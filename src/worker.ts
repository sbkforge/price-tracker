// price-tracker Worker: reads prices from product pages, stores them in D1,
// re-checks every product on a schedule, and sends Web Push alerts when a
// price drops. Static files come from ./public.

import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { sendPush } from "./push";
import type { PushSubscriptionRow } from "./push";
import { MAX_PER_OWNER } from "./shared";
import type {
  AddRequest, Availability, PricePoint, Product, ProductRow, PushSubscribeRequest, TargetRequest,
} from "./shared";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BROWSER?: BrowserWorker;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT: string;
}

const CHECK_EVERY = 6 * 60 * 60 * 1000; // re-check a product every 6 hours
const BATCH = 25; // products per scheduled run (free plan allows 50 fetches)
const OWNER_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (path === "/api/config" && method === "GET") {
        return json({
          vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
          maxPerOwner: MAX_PER_OWNER,
          browserRendering: !!env.BROWSER,
        });
      }

      // Every visitor sends their own random owner id; it scopes everything.
      const owner = request.headers.get("x-owner") || "";
      if (path.startsWith("/api/")) {
        if (!OWNER_RE.test(owner)) return json({ error: "Missing owner id; reload the page" }, 400);
      }

      // "Why can't this link be tracked?": what the reader saw on the page.
      if (path === "/api/inspect" && method === "GET") {
        const target = url.searchParams.get("url") || "";
        if (!/^https?:\/\//.test(target)) return json({ error: "Give a full link" }, 400);
        const info = await readProduct(target, env, url.searchParams.get("render") === "1");
        return json({ ...info, image: info.image ? "(found)" : null }, 200, { "cache-control": "no-store" });
      }

      if (path === "/api/products" && method === "GET") return await listProducts(env, owner);
      if (path === "/api/products" && method === "POST") return await addProduct(request, env, owner);

      if (path === "/api/push" && method === "POST") return await subscribe(request, env, owner);
      if (path === "/api/push" && method === "DELETE") return await unsubscribe(request, env, owner);
      if (path === "/api/push/test" && method === "POST") {
        const sent = await notify(env, owner, {
          title: "Alerts are on",
          body: "You'll hear from us when a tracked price drops.",
          url: "/",
          tag: "test",
        });
        return json({ ok: sent > 0, sent });
      }

      const m = /^\/api\/products\/(\d+)(\/check|\/history\.csv)?$/.exec(path);
      if (m) {
        const id = Number(m[1]);
        const p = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND owner = ?")
          .bind(id, owner).first<ProductRow>();
        if (!p) return json({ error: "Not found" }, 404);
        if (m[2] === "/check" && method === "POST") return await checkNow(env, p);
        if (m[2] === "/history.csv" && method === "GET") return await historyCsv(env, p);
        if (!m[2] && method === "PATCH") return await updateProduct(request, env, id);
        if (!m[2] && method === "DELETE") return await deleteProduct(env, id);
      }

      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: errorMessage(err) }, 500);
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(checkDue(env));
  },
} satisfies ExportedHandler<Env>;

// ---------- products ----------

async function listProducts(env: Env, owner: string): Promise<Response> {
  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM products WHERE owner = ? ORDER BY created_at DESC"
  ).bind(owner).all<ProductRow>();

  // Full history is small (4 checks a day), so send it all for the charts.
  const { results: points } = await env.DB.prepare(
    `SELECT product_id, price, checked_at FROM prices
     WHERE product_id IN (SELECT id FROM products WHERE owner = ?) ORDER BY checked_at`
  ).bind(owner).all<{ product_id: number; price: number; checked_at: number }>();
  const history = new Map<number, PricePoint[]>();
  for (const r of points) {
    const list = history.get(r.product_id) ?? [];
    list.push([r.checked_at, r.price]);
    history.set(r.product_id, list);
  }

  const products: Product[] = rows.map((p) => {
    const h = history.get(p.id) ?? [];
    const values = h.map((x) => x[1]);
    const n = values.length;
    return {
      ...p,
      history: h,
      lowest: n ? Math.min(...values) : null,
      highest: n ? Math.max(...values) : null,
      average: n ? Math.round((values.reduce((a, b) => a + b, 0) / n) * 100) / 100 : null,
      first: n ? values[0] : null,
    };
  });
  return json({ products }, 200, { "cache-control": "no-store" });
}

async function addProduct(request: Request, env: Env, owner: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<AddRequest>;
  let url: URL;
  try {
    url = new URL(String(body.url || "").trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return json({ error: "Paste a full product link starting with https://" }, 400);
  }
  url.hash = "";

  const existing = await env.DB.prepare("SELECT id FROM products WHERE owner = ? AND url = ?")
    .bind(owner, url.href).first();
  if (existing) return json({ error: "You're already tracking that product" }, 409);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE owner = ?")
    .bind(owner).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PER_OWNER) {
    return json({ error: `You can track up to ${MAX_PER_OWNER} products. Remove one first.` }, 429);
  }

  const info = await readProduct(url.href, env, false);
  if (info.price == null) {
    return json({ error: info.error || "Couldn't find a price on that page" }, 422);
  }

  const now = Date.now();
  const target = toNumber(body.target);
  const row = await env.DB.prepare(
    `INSERT INTO products (owner, url, title, image, store, currency, price, target, availability, render, created_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(owner, url.href, info.title, info.image, storeName(url), info.currency, info.price,
    target, info.availability, info.rendered ? 1 : 0, now, now).first<{ id: number }>();
  if (!row) throw new Error("Could not save the product");
  await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
    .bind(row.id, info.price, now).run();

  return json({ ok: true, id: row.id, price: info.price, currency: info.currency, via: info.via }, 201);
}

async function updateProduct(request: Request, env: Env, id: number): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<TargetRequest>;
  await env.DB.prepare("UPDATE products SET target = ? WHERE id = ?")
    .bind(toNumber(body.target), id).run();
  return json({ ok: true });
}

async function deleteProduct(env: Env, id: number): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM prices WHERE product_id = ?").bind(id),
    env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function checkNow(env: Env, p: ProductRow): Promise<Response> {
  // Don't let "Check now" hammer a store: reuse a result under 10 minutes old.
  if (p.checked_at && Date.now() - p.checked_at < 10 * 60 * 1000 && !p.error) {
    return json({ ok: true, price: p.price, cached: true });
  }
  const result = await checkProduct(env, p);
  return json({ ok: !result.error, ...result });
}

async function historyCsv(env: Env, p: ProductRow): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT price, checked_at FROM prices WHERE product_id = ? ORDER BY checked_at"
  ).bind(p.id).all<{ price: number; checked_at: number }>();
  const lines = ["date,price,currency"];
  for (const r of results) lines.push(`${new Date(r.checked_at).toISOString()},${r.price},${p.currency || ""}`);
  const name = p.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "history";
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
      "cache-control": "no-store",
    },
  });
}

// ---------- scheduled checks ----------

async function checkDue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM products WHERE checked_at IS NULL OR checked_at < ? ORDER BY checked_at LIMIT ?"
  ).bind(Date.now() - CHECK_EVERY, BATCH).all<ProductRow>();
  for (const p of results) {
    await checkProduct(env, p);
  }
}

async function checkProduct(env: Env, p: ProductRow): Promise<{ price?: number; error?: string }> {
  const now = Date.now();
  let info: PageInfo;
  try {
    info = await readProduct(p.url, env, p.render === 1);
  } catch (err) {
    info = fail(errorMessage(err));
  }

  if (info.price == null) {
    // Keep the last good price; just note what went wrong.
    const error = info.error || "Couldn't find a price";
    await env.DB.prepare("UPDATE products SET error = ?, checked_at = ? WHERE id = ?")
      .bind(error, now, p.id).run();
    return { error };
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE products SET price = ?, currency = COALESCE(?, currency), error = NULL, availability = ?,
       render = MAX(render, ?), checked_at = ?, image = COALESCE(image, ?) WHERE id = ?`
    ).bind(info.price, info.currency, info.availability, info.rendered ? 1 : 0, now, info.image, p.id),
    env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
      .bind(p.id, info.price, now),
  ]);

  await alertIfNeeded(env, p, info);
  return { price: info.price };
}

// Alert on a price drop (any drop without a target, or when the target is
// reached), and when something comes back in stock.
async function alertIfNeeded(env: Env, p: ProductRow, info: PageInfo): Promise<void> {
  const price = info.price as number;
  const dropped = p.price != null && price < p.price;
  const hit = p.target == null || price <= p.target;
  const backInStock = p.availability === "out_of_stock" && info.availability === "in_stock";

  if (dropped && hit) {
    const pct = p.price ? Math.round(((p.price - price) / p.price) * 100) : 0;
    await notify(env, p.owner, {
      title: `Price drop: ${money(price, p.currency)}`,
      body: `${p.title} is down ${pct}% from ${money(p.price as number, p.currency)}${p.target != null ? " and under your target" : ""}.`,
      url: "/",
      tag: `product-${p.id}`,
      icon: p.image || undefined,
    });
  } else if (backInStock) {
    await notify(env, p.owner, {
      title: "Back in stock",
      body: `${p.title} is available again at ${money(price, p.currency)}.`,
      url: "/",
      tag: `product-${p.id}`,
      icon: p.image || undefined,
    });
  }
}

// ---------- push subscriptions ----------

async function subscribe(request: Request, env: Env, owner: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<PushSubscribeRequest>;
  const endpoint = String(body.endpoint || "");
  const p256dh = String(body.keys?.p256dh || "");
  const auth = String(body.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return json({ error: "Invalid push subscription" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO subscriptions (owner, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth`
  ).bind(owner, endpoint, p256dh, auth, Date.now()).run();
  return json({ ok: true });
}

async function unsubscribe(request: Request, env: Env, owner: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { endpoint?: string };
  await env.DB.prepare("DELETE FROM subscriptions WHERE owner = ? AND endpoint = ?")
    .bind(owner, String(body.endpoint || "")).run();
  return json({ ok: true });
}

interface Alert {
  title: string;
  body: string;
  url: string;
  tag: string;
  icon?: string;
}

/** Sends an alert to every browser the owner turned alerts on in. Returns how many got it. */
async function notify(env: Env, owner: string, alert: Alert): Promise<number> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return 0;
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM subscriptions WHERE owner = ?"
  ).bind(owner).all<PushSubscriptionRow>();

  let sent = 0;
  const keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
  for (const sub of results) {
    try {
      const r = await sendPush(sub, alert, keys);
      if (r.ok) sent++;
      if (r.gone) {
        await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
      }
    } catch {
      // A bad subscription shouldn't stop the others.
    }
  }
  return sent;
}

// ---------- reading a product page ----------
//
// Most stores publish product data for search engines, which is what this
// reads, in order of reliability:
//   1. JSON-LD  <script type="application/ld+json"> with a schema.org Product
//   2. meta tags  product:price:amount / og:price:amount / itemprop="price"
//   3. a few store-specific price elements (Amazon, Flipkart)
// If none of those has a price, the page probably fills it in with
// JavaScript, so it's loaded once more in a real browser (Browser Rendering).

interface PageInfo {
  title: string;
  image: string | null;
  price: number | null;
  currency: string | null;
  availability: Availability;
  via?: string;
  rendered?: boolean;
  error?: string;
}

// JSON-LD is free-form, so it's handled loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PRICE_SELECTORS =
  // Amazon's buy box only: other .a-price elements are related products.
  "#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, " +
  "#apex_desktop .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, " +
  "#price_inside_buybox, #newBuyBoxPrice, " +
  // Flipkart
  "div.Nx9bqj, div._30jeq3";

const CURRENCY_RE = /₹|Rs\.?\s?\d|\$|€|£|¥|\b(INR|USD|EUR|GBP|JPY|AUD|CAD|AED|SGD)\b/i;

const fail = (error: string): PageInfo =>
  ({ title: "", image: null, price: null, currency: null, availability: null, error });

async function readProduct(href: string, env: Env, forceRender: boolean): Promise<PageInfo> {
  if (!forceRender || !env.BROWSER) {
    const res = await fetch(href, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-IN,en;q=0.9" },
      redirect: "follow",
    });
    if (!res.ok) {
      const blocked = res.status === 403 || res.status === 503 ? " (it may be blocking automated checks)" : "";
      return fail(`The store answered ${res.status}${blocked}`);
    }
    if (!(res.headers.get("content-type") || "").includes("html")) {
      return fail("That link isn't a web page");
    }
    const info = await parsePage(res, href);
    if (info.price != null || !env.BROWSER) return info;
  }

  // Real browser, for pages that load the price with JavaScript.
  const info = await renderAndParse(href, env.BROWSER as BrowserWorker);
  info.rendered = info.price != null;
  return info;
}

async function renderAndParse(href: string, binding: BrowserWorker): Promise<PageInfo> {
  let browser;
  try {
    browser = await puppeteer.launch(binding);
  } catch (err) {
    return fail(`Couldn't open a browser for this page (${errorMessage(err)})`);
  }
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(href, { waitUntil: "networkidle2", timeout: 25000 });
    const html = await page.content();
    const info = await parsePage(new Response(html, { headers: { "content-type": "text/html" } }), href);
    if (info.price != null) info.via = `browser, ${info.via}`;
    return info;
  } catch (err) {
    return fail(`The page didn't finish loading in a browser (${errorMessage(err)})`);
  } finally {
    await browser.close();
  }
}

async function parsePage(res: Response, href: string): Promise<PageInfo> {
  const found = {
    ld: [] as string[],
    meta: {} as Record<string, string>,
    itemprop: null as string | null,
    availability: null as string | null,
    selectors: [] as string[],
    guesses: [] as string[],
    title: "",
    image: null as string | null,
  };
  let ldText = "";
  let selText = "";
  let inSel = 0;
  const guessText: Array<(s: string) => void> = [];

  await new HTMLRewriter()
    .on('script[type="application/ld+json"]', {
      text(t) {
        ldText += t.text;
        if (t.lastInTextNode) { found.ld.push(ldText); ldText = ""; }
      },
    })
    .on("meta", {
      element(e) {
        const key = (e.getAttribute("property") || e.getAttribute("name") || e.getAttribute("itemprop") || "").toLowerCase();
        const val = e.getAttribute("content");
        if (key && val && !(key in found.meta)) found.meta[key] = val;
      },
    })
    .on('[itemprop="price"]', {
      element(e) {
        const content = e.getAttribute("content");
        if (found.itemprop == null && content) found.itemprop = content;
      },
    })
    .on('[itemprop="availability"]', {
      element(e) {
        found.availability ||= e.getAttribute("content") || e.getAttribute("href");
      },
    })
    .on(PRICE_SELECTORS, {
      element(e) {
        inSel++;
        e.onEndTag(() => {
          inSel--;
          if (selText.trim()) found.selectors.push(selText.trim());
          selText = "";
        });
      },
      text(t) { if (inSel) selText += t.text; },
    })
    // 4. Last resort: any element whose class or id mentions "price". Only
    //    texts that look like an amount with a currency are kept.
    .on('[class*="price"], [class*="Price"], [id*="price"], [id*="Price"], [data-price]', {
      element(e) {
        if (found.guesses.length >= 40) return;
        const data = e.getAttribute("data-price");
        if (data && parsePrice(data)) found.guesses.push(data);
        let txt = "";
        e.onEndTag(() => {
          txt = txt.replace(/\s+/g, " ").trim();
          if (txt && txt.length <= 40 && CURRENCY_RE.test(txt) && parsePrice(txt)) found.guesses.push(txt);
        });
        // Text arrives in the handler below via a closure per element.
        guessText.push((s) => { txt += s; });
      },
      text(t) {
        if (guessText.length) guessText[guessText.length - 1](t.text);
        if (t.lastInTextNode) { /* keep collecting until the end tag */ }
      },
    })
    .on("#landingImage, #imgTagWrapperId img", {
      // Amazon has no og:image; use the main product photo.
      element(e) {
        found.image ||= e.getAttribute("data-old-hires") || e.getAttribute("src");
      },
    })
    .on("title", { text(t) { found.title += t.text; } })
    .transform(res)
    .arrayBuffer();

  const out: PageInfo = { title: "", image: null, price: null, currency: null, availability: null };

  // 1. JSON-LD
  for (const raw of found.ld) {
    const product = findProduct(safeJSON(raw));
    if (!product) continue;
    out.title ||= text(product.name);
    out.image ||= firstImage(product.image);
    const offer = pickOffer(product.offers);
    if (offer && out.price == null) {
      const spec = offer.priceSpecification || {};
      out.price = toNumber(offer.price ?? offer.lowPrice ?? spec.price);
      out.currency = offer.priceCurrency || spec.priceCurrency || null;
      out.availability = availabilityOf(offer.availability);
      out.via = "json-ld";
    }
  }

  // 2. meta tags
  const meta = found.meta;
  if (out.price == null) {
    out.price = toNumber(meta["product:price:amount"] ?? meta["og:price:amount"] ?? found.itemprop);
    out.currency ||= meta["product:price:currency"] || meta["og:price:currency"] || meta["pricecurrency"] || null;
    if (out.price != null) out.via = "meta";
  }
  out.availability ||= availabilityOf(meta["product:availability"] || meta["og:availability"] || found.availability);

  // 3. store-specific elements
  if (out.price == null && found.selectors.length) {
    out.price = parsePrice(found.selectors[0]);
    out.currency ||= currencyFromSymbol(found.selectors[0]);
    out.via = `page: ${found.selectors.slice(0, 3).join(" | ")}`;
  }

  // 4. generic "price" elements (rendered pages mostly end up here)
  if (out.price == null && found.guesses.length) {
    // Prefer the most common amount on the page: the product's own price is
    // usually repeated (sticky bar, buy box), struck-out MRPs less so.
    const counts = new Map<number, number>();
    for (const g of found.guesses) {
      const v = parsePrice(g);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      out.price = best[0];
      out.currency ||= currencyFromSymbol(found.guesses.find((g) => parsePrice(g) === best[0]) || "");
      out.via = `guess: ${found.guesses.slice(0, 3).join(" | ")}`;
    }
  }

  out.title = (out.title || meta["og:title"] || meta["twitter:title"] || decodeEntities(found.title))
    .replace(/\s+/g, " ").trim().slice(0, 200) || new URL(href).hostname;
  out.image ||= meta["og:image"] || meta["twitter:image"] || found.image || null;
  if (out.image) {
    try { out.image = new URL(out.image, href).href; } catch { out.image = null; }
  }
  if (out.price != null && !(out.price > 0)) out.price = null;
  if (out.price == null) {
    out.error = "Couldn't find a price on that page. The store may load prices with JavaScript or block automated checks.";
    // Leave clues for /api/inspect.
    out.via = `title: ${found.title.trim().slice(0, 80)} | ld: ${found.ld.length} | meta: ${Object.keys(meta).length} | guesses: ${found.guesses.slice(0, 5).join(" ; ")}`;
  }
  return out;
}

function availabilityOf(v: unknown): Availability {
  const s = text(v).toLowerCase();
  if (!s) return null;
  if (/outofstock|out_of_stock|soldout|discontinued|out of stock/.test(s)) return "out_of_stock";
  if (/preorder|pre-order/.test(s)) return "preorder";
  if (/instock|in_stock|in stock|limitedavailability|onlineonly|instoreonly|available/.test(s)) return "in_stock";
  return null;
}

function findProduct(node: Json): Json | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findProduct(n);
      if (p) return p;
    }
    return null;
  }
  const type = ([] as Json[]).concat(node["@type"] || []).map(String);
  if (type.some((t) => /^(Product|ProductGroup|IndividualProduct|Vehicle|Book)$/i.test(t))) {
    // A ProductGroup (variants) may hold its offers on the first variant.
    if (!node.offers && Array.isArray(node.hasVariant) && node.hasVariant[0]) {
      return { ...node, offers: node.hasVariant[0].offers };
    }
    return node;
  }
  return findProduct(node["@graph"]) || findProduct(node.mainEntity);
}

function pickOffer(offers: Json): Json | null {
  if (!offers) return null;
  if (Array.isArray(offers)) {
    // Prefer an in-stock offer, then the lowest price.
    const priceOf = (o: Json) => toNumber(o.price ?? o.lowPrice);
    const priced = offers.filter((o) => priceOf(o) != null);
    const inStock = priced.filter((o) => !/OutOfStock/i.test(o.availability || ""));
    const pool = inStock.length ? inStock : priced;
    return pool.sort((a, b) => (priceOf(a) ?? 0) - (priceOf(b) ?? 0))[0] || null;
  }
  if (offers.offers) return pickOffer(offers.offers);
  return offers;
}

function firstImage(img: Json): string | null {
  if (!img) return null;
  if (Array.isArray(img)) return firstImage(img[0]);
  if (typeof img === "object") return img.url || img.contentUrl || null;
  return String(img);
}

function text(v: Json): string {
  return Array.isArray(v) ? String(v[0] || "") : v ? String(v) : "";
}

function safeJSON(raw: string): Json | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Some stores leave raw newlines inside strings; try once more without them.
    try { return JSON.parse(raw.replace(/[\r\n\t]+/g, " ")); } catch { return null; }
  }
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  return parsePrice(String(v));
}

// "₹1,299.00" -> 1299, "1.299,00 €" -> 1299, "$19.99" -> 19.99
function parsePrice(s: string): number | null {
  const m = String(s).match(/\d[\d.,\s]*/);
  if (!m) return null;
  let n = m[0].replace(/\s/g, "");
  const lastDot = n.lastIndexOf(".");
  const lastComma = n.lastIndexOf(",");
  if (lastDot > -1 && lastComma > -1) {
    // Whichever comes last is the decimal mark.
    n = lastDot > lastComma ? n.replace(/,/g, "") : n.replace(/\./g, "").replace(",", ".");
  } else if (lastComma > -1) {
    // "1,299" is thousands; "12,99" is decimals.
    n = /,\d{3}$/.test(n) ? n.replace(/,/g, "") : n.replace(",", ".");
  } else if ((n.match(/\./g) || []).length > 1) {
    n = n.replace(/\./g, "");
  }
  const v = parseFloat(n);
  return isFinite(v) ? v : null;
}

function currencyFromSymbol(s: string): string | null {
  const code = /\b(INR|USD|EUR|GBP|JPY|AUD|CAD|AED|SGD)\b/.exec(s);
  if (code) return code[1];
  if (/₹|Rs\.?/i.test(s)) return "INR";
  if (/€/.test(s)) return "EUR";
  if (/£/.test(s)) return "GBP";
  if (/¥/.test(s)) return "JPY";
  if (/\$/.test(s)) return "USD";
  return null;
}

function decodeEntities(s: string): string {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function storeName(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function money(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency", currency: currency || "USD", maximumFractionDigits: value % 1 ? 2 : 0,
    }).format(value);
  } catch {
    return `${currency || ""} ${value}`.trim();
  }
}

// ---------- helpers ----------

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Server error";
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
