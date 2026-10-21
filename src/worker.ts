// price-tracker Worker: reads prices from product pages, stores them in D1,
// re-checks every product on a schedule, and sends Web Push alerts when a
// price drops. Static files come from ./public.

import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { b64url, sendPush } from "./push";
import type { PushSubscriptionRow } from "./push";
import { MAX_PER_OWNER } from "./shared";
import type {
  AddRequest, Availability, PricePoint, Product, ProductRow, PushSubscribeRequest, Snapshot, UpdateRequest,
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
const BATCH = 15; // urls per scheduled run (free plan allows 50 fetches; discovery and backfill need the rest)
const OWNER_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // "Put our address in front of any product link": /https://store/... opens
      // the page with that product ready to track.
      if (/^\/https?:\/\//i.test(path) && method === "GET") {
        const target = request.url.slice(url.origin.length + 1);
        return Response.redirect(`${url.origin}/?url=${encodeURIComponent(target)}`, 302);
      }

      // Public, read-only view of someone's shared list.
      const sharedMatch = /^\/api\/shared\/([A-Za-z0-9_-]{16,64})$/.exec(path);
      if (sharedMatch && method === "GET") return await sharedList(env, sharedMatch[1]);

      if (path === "/api/config" && method === "GET") {
        return json({
          vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
          maxPerOwner: MAX_PER_OWNER,
          browserRendering: !!env.BROWSER,
        });
      }

      // Public: biggest recent price drops across everyone (no owner info).
      if (path === "/api/deals" && method === "GET") return await deals(env);
      // Public: the auto-discovered catalog of popular products.
      if (path === "/api/catalog" && method === "GET") return await catalog(env);

      // Every visitor sends their own random owner id; it scopes everything.
      const owner = request.headers.get("x-owner") || "";
      if (path.startsWith("/api/")) {
        if (!OWNER_RE.test(owner)) return json({ error: "Missing owner id; reload the page" }, 400);
      }

      // "Why can't this link be tracked?": what the reader saw on the page.
      if (path === "/api/inspect" && method === "GET") {
        const target = url.searchParams.get("url") || "";
        if (!/^https?:\/\//.test(target)) return json({ error: "Give a full link" }, 400);
        const info = await readProduct(target, env, url.searchParams.get("render") === "1" ? "render" : "auto");
        return json({ ...info, canonical: (await canonicalUrl(new URL(target))).href, image: info.image ? "(found)" : null }, 200, { "cache-control": "no-store" });
      }

      if (path === "/api/compare" && method === "GET") {
        return await compare(url.searchParams.get("q") || "");
      }

      if (path === "/api/products" && method === "GET") return await listProducts(env, owner);
      if (path === "/api/products" && method === "POST") return await addProduct(request, env, owner, ctx);
      // Open any product link: it joins the public catalog if new, and comes
      // back with the site-wide history. Nothing is added to the person's list.
      if (path === "/api/open" && method === "POST") return await openProduct(request, env, owner, ctx);
      if (path === "/api/share" && method === "GET") return await shareLink(env, owner, url.origin);
      if (path === "/api/backfill" && method === "POST") return await backfillRoute(request, env);

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
        if (!m[2] && method === "DELETE") return await deleteProduct(env, p);
      }

      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: errorMessage(err) }, 500);
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(checkDue(env).then(() => discover(env)).then(() => backfillDue(env)));
  },
} satisfies ExportedHandler<Env>;

// ---------- products ----------

async function listProducts(env: Env, owner: string): Promise<Response> {
  return json({ products: await productsFor(env, owner) }, 200, { "cache-control": "no-store" });
}

async function productsFor(env: Env, owner: string): Promise<Product[]> {
  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM products WHERE owner = ? ORDER BY created_at DESC"
  ).bind(owner).all<ProductRow>();
  const history = await historyByUrl(env, "SELECT url FROM products WHERE owner = ?", [owner]);
  return rows.map((p) => withHistory(p, history.get(p.url)));
}

// History is site-wide: every price point anyone's check, bookmark or an
// archive snapshot ever produced for this url, whoever holds the row.
const ARCHIVE_OWNER = "archive";

interface HistoryRow { url: string; price: number; checked_at: number; source: string | null }

async function historyByUrl(env: Env, urlSubquery: string, binds: unknown[]): Promise<Map<string, HistoryRow[]>> {
  const { results } = await env.DB.prepare(
    `SELECT p.url, pr.price, pr.checked_at, pr.source FROM prices pr
     JOIN products p ON p.id = pr.product_id
     WHERE p.url IN (${urlSubquery}) ORDER BY pr.checked_at`
  ).bind(...binds).all<HistoryRow>();
  const map = new Map<string, HistoryRow[]>();
  for (const r of results) {
    const list = map.get(r.url) ?? [];
    // Two rows checked in the same run produce twins; keep one.
    const last = list[list.length - 1];
    if (last && last.price === r.price && r.checked_at - last.checked_at < 10 * 60 * 1000) continue;
    list.push(r);
    map.set(r.url, list);
  }
  return map;
}

function withHistory(p: ProductRow, rows: HistoryRow[] | undefined): Product {
  const h: PricePoint[] = (rows ?? []).map((r) => [r.checked_at, r.price]);
  const values = h.map((x) => x[1]);
  const n = values.length;
  return {
    ...p,
    history: h,
    archived: (rows ?? []).filter((r) => r.source === "wayback").length,
    lowest: n ? Math.min(...values) : null,
    highest: n ? Math.max(...values) : null,
    average: n ? Math.round((values.reduce((a, b) => a + b, 0) / n) * 100) / 100 : null,
    first: n ? values[0] : null,
  };
}

// ---------- shared lists ----------

async function shareLink(env: Env, owner: string, origin: string): Promise<Response> {
  let row = await env.DB.prepare("SELECT token FROM lists WHERE owner = ?").bind(owner).first<{ token: string }>();
  if (!row) {
    const token = b64url(crypto.getRandomValues(new Uint8Array(18)));
    await env.DB.prepare("INSERT INTO lists (owner, token, created_at) VALUES (?, ?, ?)")
      .bind(owner, token, Date.now()).run();
    row = { token };
  }
  return json({ token: row.token, url: `${origin}/?list=${row.token}` });
}

async function sharedList(env: Env, token: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT owner FROM lists WHERE token = ?").bind(token).first<{ owner: string }>();
  if (!row) return json({ error: "That shared list doesn't exist" }, 404);
  // Strip anything personal: targets and purchases stay with the owner.
  const products = (await productsFor(env, row.owner)).map((p) => ({
    ...p, owner: "", target: null, bought_at: null, bought_price: null,
  }));
  return json({ products }, 200, { "cache-control": "no-store" });
}

async function addProduct(request: Request, env: Env, owner: string, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<AddRequest>;
  let url: URL;
  try {
    url = new URL(String(body.url || "").trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return json({ error: "Paste a full product link starting with https://" }, 400);
  }
  url = await canonicalUrl(url);

  const snapshot = cleanSnapshot(body.snapshot);

  const existing = await env.DB.prepare("SELECT * FROM products WHERE owner = ? AND url = ?")
    .bind(owner, url.href).first<ProductRow>();
  if (existing) {
    // The bookmark on a page already tracked: record what it saw as a fresh check.
    if (snapshot) {
      await recordSnapshot(env, existing, snapshot);
      return json({ ok: true, id: existing.id, price: snapshot.price, currency: snapshot.currency, via: "bookmark", updated: true });
    }
    return json({ error: "You're already tracking that product" }, 409);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE owner = ?")
    .bind(owner).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PER_OWNER) {
    return json({ error: `You can track up to ${MAX_PER_OWNER} products. Remove one first.` }, 429);
  }

  // Already known to the site (someone else, the catalog, or an archived row):
  // no fetch, and the whole history comes along.
  const known = await env.DB.prepare(
    "SELECT * FROM products WHERE url = ? AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 1"
  ).bind(url.href).first<ProductRow>();
  if (known) {
    const now = Date.now();
    const row = await env.DB.prepare(
      `INSERT INTO products (owner, url, title, image, store, currency, price, target, availability, list_price, render, backfilled_at, created_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(owner, known.url, known.title, known.image, known.store, known.currency, known.price, toNumber(body.target),
      known.availability, known.list_price, known.render, known.backfilled_at, now, known.checked_at).first<{ id: number }>();
    if (!row) throw new Error("Could not save the product");
    // A url known only from an old row that lost its points still needs one.
    const points = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM prices pr JOIN products p ON p.id = pr.product_id WHERE p.url = ?"
    ).bind(known.url).first<{ n: number }>();
    if (!points?.n) {
      await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
        .bind(row.id, known.price, known.checked_at ?? now).run();
    }
    if (snapshot) {
      await recordSnapshot(env, { ...known, id: row.id, owner, target: toNumber(body.target), bought_at: null, bought_price: null }, snapshot);
    }
    return json({ ok: true, id: row.id, price: snapshot ? snapshot.price : known.price, currency: known.currency, via: snapshot ? "bookmark" : "shared" }, 201);
  }

  // With a snapshot in hand, don't make the person wait on a store that is
  // known to refuse us; otherwise try a quick plain read (no browser) first.
  let info: PageInfo = snapshot && BLOCKED_STORES.test(url.hostname)
    ? fail("blocked")
    : await readProduct(url.href, env, snapshot ? "static" : "auto");
  if (info.price == null && snapshot) {
    // The Worker couldn't read the page, but the person's browser could.
    info = {
      title: snapshot.title || info.title || url.hostname,
      image: snapshot.image ?? info.image,
      price: snapshot.price,
      currency: snapshot.currency ?? info.currency ?? null,
      availability: snapshot.availability ?? info.availability,
      listPrice: snapshot.listPrice ?? null,
      via: "bookmark",
    };
  }
  if (info.price == null) {
    const hint = BLOCKED_STORES.test(url.hostname)
      ? ` ${storeName(url)} blocks automatic checks. Open the product page and use the "Track price" bookmark (in Settings) to add it from your browser.`
      : "";
    return json({ error: (info.error || "Couldn't find a price on that page") + hint }, 422);
  }

  // A share link that redirected: keep the real product page, and see if it
  // can be read without a browser (cheaper for every later check).
  if (info.finalUrl && info.finalUrl !== url.href) {
    const resolved = await canonicalUrl(new URL(info.finalUrl));
    if (resolved.href !== url.href) {
      url = resolved;
      const dupe = await env.DB.prepare("SELECT id FROM products WHERE owner = ? AND url = ?")
        .bind(owner, url.href).first();
      if (dupe) return json({ error: "You're already tracking that product" }, 409);
      if (info.rendered) {
        const plain = await readProduct(url.href, env, "static");
        if (plain.price != null) info = plain;
      }
    }
  }

  const now = Date.now();
  const target = toNumber(body.target);
  const row = await env.DB.prepare(
    `INSERT INTO products (owner, url, title, image, store, currency, price, target, availability, list_price, render, created_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(owner, url.href, info.title, info.image, storeName(url), info.currency, info.price,
    target, info.availability, info.listPrice, info.rendered ? 1 : 0, now, now).first<{ id: number }>();
  if (!row) throw new Error("Could not save the product");
  await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at, source) VALUES (?, ?, ?, ?)")
    .bind(row.id, info.price, now, info.via === "bookmark" ? "bookmark" : null).run();

  // New to the site: fetch its past from the archive right away, after the
  // reply has gone out, so the chart is already long on the first visit.
  const saved: ProductRow = {
    id: row.id, owner, url: url.href, title: info.title, image: info.image, store: storeName(url), currency: info.currency,
    price: info.price, target, error: null, availability: info.availability, list_price: info.listPrice,
    render: info.rendered ? 1 : 0, bought_at: null, bought_price: null, backfilled_at: null, created_at: now, checked_at: now,
  };
  ctx.waitUntil(backfill(env, saved, 10).catch(() => undefined));

  return json({ ok: true, id: row.id, price: info.price, currency: info.currency, via: info.via }, 201);
}

async function openProduct(request: Request, env: Env, owner: string, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { url?: string };
  let url: URL;
  try {
    url = new URL(String(body.url || "").trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return json({ error: "Paste a full product link starting with https://" }, 400);
  }
  url = await canonicalUrl(url);

  let known = await env.DB.prepare(
    "SELECT * FROM products WHERE url = ? AND price IS NOT NULL ORDER BY CASE owner WHEN ? THEN 0 ELSE 1 END, checked_at DESC LIMIT 1"
  ).bind(url.href, owner).first<ProductRow>();

  if (!known) {
    let info = await readProduct(url.href, env, "auto");
    if (info.price == null) {
      const hint = BLOCKED_STORES.test(url.hostname)
        ? ` ${storeName(url)} blocks automatic checks. Open the product page and use the "Track price" bookmark (in Settings) to add it from your browser.`
        : "";
      return json({ error: (info.error || "Couldn't find a price on that page") + hint }, 422);
    }
    if (info.finalUrl && info.finalUrl !== url.href) {
      const resolved = await canonicalUrl(new URL(info.finalUrl));
      if (resolved.href !== url.href) {
        url = resolved;
        const again = await env.DB.prepare("SELECT * FROM products WHERE url = ? AND price IS NOT NULL LIMIT 1")
          .bind(url.href).first<ProductRow>();
        if (again) known = again;
        else if (info.rendered) {
          const plain = await readProduct(url.href, env, "static");
          if (plain.price != null) info = plain;
        }
      }
    }
    if (!known) {
      const now = Date.now();
      const row = await env.DB.prepare(
        `INSERT INTO products (owner, url, title, image, store, currency, price, availability, list_price, render, created_at, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).bind(CATALOG_OWNER, url.href, info.title, info.image, storeName(url), info.currency, info.price,
        info.availability, info.listPrice, info.rendered ? 1 : 0, now, now).first<ProductRow>();
      if (!row) throw new Error("Could not save the product");
      await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
        .bind(row.id, info.price, now).run();
      known = row;
    }
  }

  // Past prices from the archive, once per url, after the reply goes out.
  if (!known.backfilled_at) ctx.waitUntil(backfill(env, known, 10).catch(() => undefined));

  const mine = known.owner === owner ? known : await env.DB.prepare("SELECT * FROM products WHERE url = ? AND owner = ?")
    .bind(known.url, owner).first<ProductRow>();
  const history = (await historyByUrl(env, "?", [known.url])).get(known.url);
  const product = withHistory({ ...known, owner: "", target: mine?.target ?? null, bought_at: mine?.bought_at ?? null, bought_price: mine?.bought_price ?? null }, history);
  return json({ product, mineId: mine?.id ?? null, pending: !known.backfilled_at }, 200, { "cache-control": "no-store" });
}

// Stores known to turn away Cloudflare, headless browser included. Their
// products come in through the bookmark instead.
const BLOCKED_STORES = /(^|\.)(croma\.com|reliancedigital\.in|nykaa\.com|ajio\.com|meesho\.com|bigbasket\.com|snapdeal\.com)$/i;

function cleanSnapshot(s: Snapshot | undefined): Snapshot | null {
  if (!s || typeof s !== "object") return null;
  const price = toNumber(s.price);
  if (price == null || !(price > 0)) return null;
  const listPrice = toNumber(s.listPrice);
  const title = s.title ? cleanTitle(String(s.title)) : "";
  return {
    title: title || undefined,
    price,
    currency: s.currency && /^[A-Z]{3}$/.test(String(s.currency)) ? String(s.currency) : null,
    image: s.image && /^https?:\/\//.test(String(s.image)) ? String(s.image).slice(0, 500) : null,
    availability: availabilityOf(s.availability),
    listPrice: listPrice != null && listPrice > price ? listPrice : null,
  };
}

async function recordSnapshot(env: Env, p: ProductRow, s: Snapshot): Promise<void> {
  const now = Date.now();
  const followers = await followersOf(env, p.url);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE products SET price = ?, currency = COALESCE(?, currency), error = NULL,
       availability = COALESCE(?, availability), list_price = COALESCE(?, list_price),
       image = COALESCE(image, ?), title = COALESCE(?, title), checked_at = ? WHERE url = ?`
    ).bind(s.price, s.currency ?? null, s.availability ?? null, s.listPrice ?? null, s.image ?? null, s.title ?? null, now, p.url),
    env.DB.prepare("INSERT INTO prices (product_id, price, checked_at, source) VALUES (?, ?, ?, 'bookmark')")
      .bind(p.id, s.price, now),
  ]);
  const info: PageInfo = {
    title: s.title || p.title, image: s.image ?? p.image, price: s.price, currency: s.currency ?? p.currency,
    availability: s.availability ?? p.availability, listPrice: s.listPrice ?? null,
  };
  for (const f of followers) await alertIfNeeded(env, f, info);
}

/** Everyone with this product on their list (not the catalog or archived rows). */
async function followersOf(env: Env, url: string): Promise<ProductRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM products WHERE url = ? AND owner NOT IN (?, ?)"
  ).bind(url, ARCHIVE_OWNER, CATALOG_OWNER).all<ProductRow>();
  return results;
}

async function updateProduct(request: Request, env: Env, id: number): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as UpdateRequest;
  if ("target" in body) {
    await env.DB.prepare("UPDATE products SET target = ? WHERE id = ?")
      .bind(toNumber(body.target), id).run();
  }
  if ("bought" in body) {
    const price = body.bought ? toNumber(body.bought.price) : null;
    await env.DB.prepare("UPDATE products SET bought_at = ?, bought_price = ? WHERE id = ?")
      .bind(body.bought ? Date.now() : null, price, id).run();
  }
  return json({ ok: true });
}

// Removing a product never loses history: its price points move to another
// row for the same url, or the row itself is kept as an archived one.
async function deleteProduct(env: Env, p: ProductRow): Promise<Response> {
  const keeper = await env.DB.prepare(
    "SELECT id FROM products WHERE url = ? AND id != ? ORDER BY CASE owner WHEN ? THEN 1 ELSE 0 END, id LIMIT 1"
  ).bind(p.url, p.id, ARCHIVE_OWNER).first<{ id: number }>();
  if (keeper) {
    await env.DB.batch([
      env.DB.prepare("UPDATE prices SET product_id = ? WHERE product_id = ?").bind(keeper.id, p.id),
      env.DB.prepare("DELETE FROM products WHERE id = ?").bind(p.id),
    ]);
  } else {
    await env.DB.prepare(
      "UPDATE products SET owner = ?, target = NULL, bought_at = NULL, bought_price = NULL WHERE id = ?"
    ).bind(ARCHIVE_OWNER, p.id).run();
  }
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
  const rows = (await historyByUrl(env, "?", [p.url])).get(p.url) ?? [];
  const lines = ["date,price,currency,source"];
  for (const r of rows) lines.push(`${new Date(r.checked_at).toISOString()},${r.price},${p.currency || ""},${r.source || "check"}`);
  const name = p.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "history";
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
      "cache-control": "no-store",
    },
  });
}

// ---------- catalog: popular products tracked without anyone adding them ----------
//
// Each scheduled run searches one category on Flipkart (the one store whose
// search page can be read) and starts tracking the top results under the
// shared "catalog" owner. They're checked like everything else, so Deals and
// Browse fill up on their own. Capped so the cron budget stays within limits.

const CATALOG_OWNER = "catalog";
const CATALOG_MAX = 1200; // discovery stops here; products people open still join
const CATALOG_PER_RUN = 6;
// Specific searches with a price floor: generic words ("camera") return
// straps and lens caps, so each query names the kind of product and the least
// it plausibly costs.
const CATALOG_QUERIES: Array<{ q: string; min: number }> = [
  { q: "iphone 16", min: 40000 }, { q: "iphone 17", min: 50000 }, { q: "samsung galaxy s25", min: 40000 },
  { q: "samsung galaxy a55", min: 15000 }, { q: "oneplus 13", min: 25000 }, { q: "oneplus nord", min: 15000 },
  { q: "redmi note 14", min: 10000 }, { q: "realme narzo", min: 8000 }, { q: "vivo t4", min: 10000 },
  { q: "google pixel 9", min: 40000 }, { q: "motorola edge", min: 15000 }, { q: "nothing phone", min: 15000 },
  { q: "macbook air m4", min: 70000 }, { q: "macbook pro", min: 120000 }, { q: "dell laptop i5", min: 35000 },
  { q: "hp laptop i5", min: 35000 }, { q: "lenovo ideapad laptop", min: 30000 }, { q: "asus gaming laptop", min: 50000 },
  { q: "ipad", min: 25000 }, { q: "samsung galaxy tab", min: 12000 }, { q: "apple watch", min: 20000 },
  { q: "samsung galaxy watch", min: 10000 }, { q: "noise smartwatch", min: 1500 }, { q: "boat airdopes", min: 800 },
  { q: "sony wh-1000xm5", min: 15000 }, { q: "jbl bluetooth speaker", min: 2000 }, { q: "airpods pro", min: 15000 },
  { q: "samsung 55 inch smart tv", min: 30000 }, { q: "lg oled tv", min: 80000 }, { q: "sony bravia tv", min: 40000 },
  { q: "lg refrigerator double door", min: 20000 }, { q: "samsung washing machine front load", min: 20000 },
  { q: "philips air fryer", min: 5000 }, { q: "preethi mixer grinder", min: 3000 }, { q: "daikin 1.5 ton split ac", min: 30000 },
  { q: "samsung microwave oven", min: 7000 }, { q: "dyson vacuum cleaner", min: 20000 }, { q: "canon dslr camera", min: 30000 },
  { q: "sony mirrorless camera", min: 50000 }, { q: "gopro hero", min: 20000 }, { q: "playstation 5 console", min: 35000 },
  { q: "lg 27 inch monitor", min: 10000 }, { q: "nike running shoes men", min: 2500 }, { q: "adidas running shoes", min: 2500 },
  { q: "american tourister backpack", min: 1200 }, { q: "philips trimmer", min: 1000 }, { q: "mi power bank 20000mah", min: 1200 },
  { q: "kindle paperwhite", min: 10000 }, { q: "dyson airwrap", min: 30000 }, { q: "lego set", min: 1500 },
  { q: "iphone 15", min: 40000 }, { q: "iphone 14", min: 35000 }, { q: "samsung galaxy s24", min: 35000 },
  { q: "samsung galaxy z fold", min: 100000 }, { q: "samsung galaxy z flip", min: 60000 }, { q: "oneplus 12", min: 30000 },
  { q: "poco phone", min: 8000 }, { q: "iqoo phone", min: 12000 }, { q: "infinix phone", min: 7000 },
  { q: "lava phone", min: 5000 }, { q: "macbook pro m4", min: 150000 }, { q: "surface laptop", min: 60000 },
  { q: "acer aspire laptop", min: 30000 }, { q: "msi gaming laptop", min: 60000 }, { q: "imac", min: 100000 },
  { q: "mac mini", min: 50000 }, { q: "ipad pro", min: 80000 }, { q: "ipad air", min: 50000 },
  { q: "garmin watch", min: 20000 }, { q: "fitbit", min: 8000 }, { q: "boat rockerz", min: 800 },
  { q: "oneplus buds", min: 2000 }, { q: "samsung galaxy buds", min: 5000 }, { q: "sony earbuds", min: 5000 },
  { q: "bose headphones", min: 15000 }, { q: "marshall speaker", min: 10000 }, { q: "sony soundbar", min: 15000 },
  { q: "mi smart tv", min: 15000 }, { q: "oneplus tv", min: 15000 }, { q: "tcl tv", min: 15000 },
  { q: "samsung refrigerator", min: 15000 }, { q: "whirlpool refrigerator", min: 12000 }, { q: "lg washing machine", min: 15000 },
  { q: "bosch washing machine", min: 25000 }, { q: "ifb dishwasher", min: 30000 }, { q: "lg 1.5 ton split ac", min: 30000 },
  { q: "voltas ac", min: 28000 }, { q: "havells air purifier", min: 6000 }, { q: "philips garment steamer", min: 2000 },
  { q: "instant pot", min: 5000 }, { q: "bajaj ceiling fan", min: 1500 }, { q: "crompton water heater", min: 4000 },
  { q: "nikon camera", min: 30000 }, { q: "dji drone", min: 30000 }, { q: "xbox series x", min: 35000 },
  { q: "nintendo switch", min: 20000 }, { q: "samsung monitor", min: 8000 }, { q: "logitech mouse", min: 1000 },
  { q: "mechanical keyboard", min: 2000 }, { q: "puma running shoes", min: 2000 }, { q: "skybags backpack", min: 1000 },
  { q: "wildcraft backpack", min: 1000 }, { q: "titan watch men", min: 2000 }, { q: "fossil watch", min: 5000 },
  { q: "ray-ban sunglasses", min: 4000 }, { q: "levis jeans men", min: 1000 }, { q: "allen solly shirt", min: 800 },
  { q: "fastrack watch", min: 1000 }, { q: "atomberg fan", min: 2500 }, { q: "prestige induction cooktop", min: 1500 },
  { q: "milton water bottle", min: 300 }, { q: "sleepwell mattress", min: 5000 }, { q: "wakefit mattress", min: 5000 },
  { q: "samsung galaxy m35", min: 12000 }, { q: "redmi 14c", min: 7000 }, { q: "realme 14 pro", min: 18000 },
];

async function setting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}

async function discover(env: Env): Promise<void> {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE owner = ?")
    .bind(CATALOG_OWNER).first<{ n: number }>();
  if ((total?.n ?? 0) >= CATALOG_MAX) return;

  // One category per run, round robin, remembered between runs.
  const slot = (Number(await setting(env, "catalog_slot")) + 1) % CATALOG_QUERIES.length;
  await setSetting(env, "catalog_slot", String(slot));
  const { q, min } = CATALOG_QUERIES[slot];
  let hits: ReturnType<typeof parseFlipkartSearch>;
  try {
    // Sorted by popularity, so the catalog gets the products people buy.
    const res = await fetchPage(`https://www.flipkart.com/search?q=${encodeURIComponent(q)}&marketplace=FLIPKART&sort=popularity`);
    if (!res.ok) return;
    hits = parseFlipkartSearch(await res.text());
  } catch {
    return;
  }

  const now = Date.now();
  let added = 0;
  // One entry per model: "OnePlus 13 (Black Eclipse, 512 GB)" and its other
  // colours share a key, so a run brings variety rather than six colours.
  const seenModels = new Set<string>();
  for (const h of hits) {
    if (added >= CATALOG_PER_RUN) break;
    if (h.price == null || h.price < min) continue;
    const model = h.title.replace(/\(([^,)]*),\s*/, "(").toLowerCase();
    if (seenModels.has(model)) continue;
    seenModels.add(model);
    const url = await canonicalUrl(new URL(h.url));
    const dupe = await env.DB.prepare("SELECT id FROM products WHERE owner = ? AND url = ?")
      .bind(CATALOG_OWNER, url.href).first();
    if (dupe) continue;
    // The listing's own data is enough to start; the next check reads the page.
    const row = await env.DB.prepare(
      `INSERT INTO products (owner, url, title, image, store, currency, price, availability, render, created_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`
    ).bind(CATALOG_OWNER, url.href, h.title.slice(0, 200), h.image, storeName(url), h.currency || "INR",
      h.price, "in_stock", now, now - CHECK_EVERY).first<{ id: number }>();
    if (row) {
      await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
        .bind(row.id, h.price, now).run();
      added++;
    }
  }
}

async function catalog(env: Env): Promise<Response> {
  // Newest 400 with their history; enough for Browse without a huge payload.
  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM products WHERE owner = ? ORDER BY created_at DESC LIMIT 400"
  ).bind(CATALOG_OWNER).all<ProductRow>();
  const history = await historyByUrl(env, "SELECT url FROM products WHERE owner = ? ORDER BY created_at DESC LIMIT 400", [CATALOG_OWNER]);
  const products = rows.map((p) => ({
    ...withHistory(p, history.get(p.url)), owner: "", target: null, bought_at: null, bought_price: null,
  }));
  return json({ products }, 200, { "cache-control": "public, max-age=300" });
}

// ---------- deals feed ----------
//
// Products anyone tracks whose price fell in the last 7 days, biggest drop
// first. Only product facts are shared, never who tracks what.

async function deals(env: Env): Promise<Response> {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT p.url, p.title, p.image, p.store, p.currency, p.price, p.list_price, p.checked_at,
              (SELECT MAX(price) FROM prices WHERE product_id = p.id AND checked_at >= ?) AS was
       FROM products p
       WHERE p.price IS NOT NULL AND p.error IS NULL AND p.checked_at >= ? AND p.owner != 'archive'
     )
     WHERE was IS NOT NULL AND was > price
     ORDER BY (was - price) * 1.0 / was DESC
     LIMIT 200`
  ).bind(since, since).all<{
    url: string; title: string; image: string | null; store: string; currency: string | null;
    price: number; list_price: number | null; checked_at: number; was: number;
  }>();
  // The same product tracked by several people appears once, with its biggest drop.
  const seen = new Set<string>();
  const list = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    list.push({ ...r, drop_pct: Math.round(((r.was - r.price) / r.was) * 100) });
    if (list.length >= 40) break;
  }
  return json({ deals: list }, 200, { "cache-control": "public, max-age=300" });
}

// ---------- compare across stores ----------
//
// Searches other stores for the same product. Only Flipkart's search page
// can be read without a browser; stores that block are reported so the page
// can offer a search link instead.

async function compare(raw: string): Promise<Response> {
  const q = raw.replace(/[|()[\]{}"']/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 10).join(" ");
  if (q.length < 3) return json({ error: "Nothing to search for" }, 400);

  const hits = [];
  const blocked: string[] = ["amazon.in", "croma.com", "reliancedigital.in", "vijaysales.com", "tatacliq.com"];
  try {
    const res = await fetchPage(`https://www.flipkart.com/search?q=${encodeURIComponent(q)}&marketplace=FLIPKART`);
    if (res.ok) hits.push(...parseFlipkartSearch(await res.text()));
    else blocked.unshift("flipkart.com");
  } catch {
    blocked.unshift("flipkart.com");
  }
  return json({ query: q, hits: hits.slice(0, 6), blocked }, 200, { "cache-control": "public, max-age=900" });
}

function parseFlipkartSearch(html: string) {
  const out = [];
  // Each result sits in a <div data-id="..."> card with the link, image and price.
  const cards = html.split(/<div data-id="/).slice(1, 40);
  const seen = new Set<string>();
  for (const card of cards) {
    const link = /href="(\/[^"]*\/p\/itm[^"]*)"/.exec(card);
    const img = /<img[^>]+alt="([^"]{5,200})"[^>]+src="([^"]+)"/.exec(card) || /<img[^>]+src="([^"]+)"[^>]+alt="([^"]{5,200})"/.exec(card);
    const price = /₹\s?([0-9][0-9,]{2,})/.exec(card.replace(/<[^>]+>/g, " "));
    if (!link || !img) continue;
    const href = link[1].replace(/&amp;/g, "&");
    const pid = /pid=([A-Z0-9]+)/.exec(href)?.[1] || href.split("?")[0];
    if (seen.has(pid)) continue;
    seen.add(pid);
    const alt = img[0].startsWith("<img") && /alt="/.test(img[0].split("src=")[0]) ? img[1] : img[2];
    const src = img[0].startsWith("<img") && /alt="/.test(img[0].split("src=")[0]) ? img[2] : img[1];
    const url = new URL(href, "https://www.flipkart.com");
    for (const key of [...url.searchParams.keys()]) if (key !== "pid") url.searchParams.delete(key);
    out.push({
      store: "flipkart.com",
      title: decodeEntities(alt),
      url: url.href,
      price: price ? parsePrice(price[1]) : null,
      currency: price ? "INR" : null,
      image: src.replace(/&amp;/g, "&"),
    });
  }
  return out;
}

// ---------- past prices from the Wayback Machine ----------
//
// Stores don't publish old prices, but the Internet Archive has dated
// snapshots of many product pages. Each snapshot is read with the same
// parser, so the history can reach back years before anyone added the
// product here. Runs once per url: on demand when a sheet opens, and from
// the cron for everything else.

const WAYBACK_MAX = 16; // snapshots fetched per product (subrequest budget)
const DAY_MS = 24 * 60 * 60 * 1000;

async function backfillRoute(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { url?: string };
  let url: URL;
  try { url = await canonicalUrl(new URL(String(body.url || ""))); } catch { return json({ error: "Give a product link" }, 400); }
  const p = await env.DB.prepare("SELECT * FROM products WHERE url = ? ORDER BY backfilled_at DESC LIMIT 1")
    .bind(url.href).first<ProductRow>();
  if (!p) return json({ error: "That product isn't on the site yet" }, 404);
  if (p.backfilled_at && Date.now() - p.backfilled_at < 3 * 60 * 1000) {
    // Another request (the add, or the cron) is on it right now.
    return json({ ok: true, added: 0, snapshots: 0, earliest: null, pending: true });
  }
  if (p.backfilled_at && Date.now() - p.backfilled_at < 30 * DAY_MS) {
    return json({ ok: true, added: 0, snapshots: 0, earliest: null, cached: true });
  }
  return json(await backfill(env, p));
}

async function backfill(env: Env, p: ProductRow, max = WAYBACK_MAX): Promise<{ ok: boolean; added: number; snapshots: number; earliest: number | null }> {
  const now = Date.now();
  // Claim the url first so a concurrent request doesn't fetch the same snapshots.
  await env.DB.prepare("UPDATE products SET backfilled_at = ? WHERE url = ?").bind(now, p.url).run();
  // The same page is captured under many address variants (tracking
  // parameters, share links), so match everything that starts with the page's
  // path and keep one capture per month, preferring the cleanest address.
  let captures: Array<{ ts: string; original: string }> = [];
  try {
    const base = p.url.split("?")[0].replace(/^https?:\/\//, "");
    const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(base)}&matchType=prefix&output=json&fl=timestamp,original&filter=statuscode:200&filter=mimetype:text/html&limit=4000`;
    const res = await fetch(cdx, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(String(res.status));
    const rows = (await res.json()) as string[][];
    const byMonth = new Map<string, { ts: string; original: string }>();
    for (const [ts, original] of rows.slice(1)) {
      if (!/^\d{14}$/.test(ts) || !original) continue;
      // Only this product: same path, any query string.
      const path = original.replace(/^https?:\/\//, "").split("?")[0];
      if (path !== base) continue;
      const month = ts.slice(0, 6);
      const cur = byMonth.get(month);
      if (!cur || original.length < cur.original.length) byMonth.set(month, { ts, original });
    }
    captures = [...byMonth.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    // The archive is down or rate-limiting; release the claim for another run.
    await env.DB.prepare("UPDATE products SET backfilled_at = NULL WHERE url = ?").bind(p.url).run();
    return { ok: false, added: 0, snapshots: 0, earliest: null };
  }

  // Spread the budget across the whole span rather than only the newest.
  const pick: Array<{ ts: string; original: string }> = [];
  if (captures.length <= max) pick.push(...captures);
  else for (let i = 0; i < max; i++) pick.push(captures[Math.round((i * (captures.length - 1)) / (max - 1))]);

  const existing = ((await historyByUrl(env, "?", [p.url])).get(p.url) ?? []).map((r) => r.checked_at);
  let added = 0;
  let earliest: number | null = null;
  for (const { ts, original } of pick) {
    const t = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14));
    if (existing.some((e) => Math.abs(e - t) < 1.5 * DAY_MS)) continue;
    try {
      // "id_" returns the page as captured, without the archive's toolbar.
      const res = await fetch(`https://web.archive.org/web/${ts}id_/${original}`, { headers: { "user-agent": UA }, redirect: "follow" });
      if (!res.ok) continue;
      const info = await parsePage(res, p.url);
      // Only confident readings go into history: structured data or the
      // store's own price element, never a loose "price-ish" guess. A value
      // wildly off today's price is a different variant or a broken capture.
      if (info.price == null || (info.via || "").startsWith("guess")) continue;
      if (p.price != null && (info.price > p.price * 4 || info.price < p.price / 4)) continue;
      await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at, source) VALUES (?, ?, ?, 'wayback')")
        .bind(p.id, info.price, t).run();
      existing.push(t);
      added++;
      if (earliest == null || t < earliest) earliest = t;
    } catch {
      // A broken snapshot; move on.
    }
  }
  await env.DB.prepare("UPDATE products SET backfilled_at = ? WHERE url = ?").bind(now, p.url).run();
  return { ok: true, added, snapshots: captures.length, earliest };
}

async function backfillDue(env: Env): Promise<void> {
  // Two products per run, fewer snapshots each, to stay inside the fetch budget.
  const { results } = await env.DB.prepare(
    "SELECT * FROM products WHERE backfilled_at IS NULL AND owner != ? GROUP BY url ORDER BY created_at LIMIT 2"
  ).bind(ARCHIVE_OWNER).all<ProductRow>();
  for (const p of results) await backfill(env, p, 10);
}

// ---------- scheduled checks ----------

async function checkDue(env: Env): Promise<void> {
  // Products someone has an alert on are checked every 6 hours; the public
  // catalog once a day. Followed ones go first when the budget is tight.
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT p.*, EXISTS (SELECT 1 FROM products f WHERE f.url = p.url AND f.owner NOT IN (?, ?)) AS followed
       FROM products p WHERE p.owner != ?
     )
     WHERE checked_at IS NULL OR checked_at < CASE WHEN followed THEN ? ELSE ? END
     ORDER BY followed DESC, checked_at LIMIT ?`
  ).bind(CATALOG_OWNER, ARCHIVE_OWNER, ARCHIVE_OWNER, now - CHECK_EVERY, now - 4 * CHECK_EVERY, BATCH).all<ProductRow>();
  // One fetch per url; the result is written to every row that shares it.
  const seen = new Set<string>();
  for (const p of results) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    await checkProduct(env, p);
  }
}

async function checkProduct(env: Env, p: ProductRow): Promise<{ price?: number; error?: string }> {
  const now = Date.now();
  let info: PageInfo;
  try {
    info = await readProduct(p.url, env, p.render === 1 ? "render" : "auto");
  } catch (err) {
    info = fail(errorMessage(err));
  }

  if (info.price == null) {
    // Keep the last good price; just note what went wrong.
    let error = info.error || "Couldn't find a price";
    if (BLOCKED_STORES.test(new URL(p.url).hostname)) {
      error = `${p.store} blocks automatic checks. Open the product page and click the "Track price" bookmark to record today's price.`;
    }
    await env.DB.prepare("UPDATE products SET error = ?, checked_at = ? WHERE url = ?")
      .bind(error, now, p.url).run();
    return { error };
  }

  // Everyone following this url is alerted from their own target; read them
  // before the shared update overwrites the old price.
  const followers = await followersOf(env, p.url);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE products SET price = ?, currency = COALESCE(?, currency), error = NULL, availability = ?,
       list_price = COALESCE(?, list_price), render = MAX(render, ?), checked_at = ?, image = COALESCE(image, ?)
       WHERE url = ?`
    ).bind(info.price, info.currency, info.availability, info.listPrice, info.rendered ? 1 : 0, now, info.image, p.url),
    env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
      .bind(p.id, info.price, now),
  ]);

  for (const f of followers) await alertIfNeeded(env, f, info);
  return { price: info.price };
}

// Alert on a price drop (any drop without a target, or when the target is
// reached), and when something comes back in stock.
async function alertIfNeeded(env: Env, p: ProductRow, info: PageInfo): Promise<void> {
  if (p.bought_at) return; // already bought; no point nagging
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
  listPrice: number | null;
  via?: string;
  rendered?: boolean;
  finalUrl?: string;
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

// Elements that never have an end tag; HTMLRewriter's onEndTag throws on them.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

const fail = (error: string): PageInfo =>
  ({ title: "", image: null, price: null, currency: null, availability: null, listPrice: null, error });

// Struck-out list prices: Amazon's basis price, Flipkart's strike price.
const LIST_PRICE_SELECTORS =
  "#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen, #apex_desktop .basisPrice .a-offscreen, " +
  "#listPrice, #priceblock_listprice, .a-price.a-text-price[data-a-strike] .a-offscreen, " +
  "div.yRaY8j, div._3I9_wc, ._2p6lqe";

// Answers that mean "not now" rather than "no such page": worth retrying in
// a real browser, which stores treat more kindly than a bare request.
const BLOCKED = new Set([403, 405, 406, 429, 500, 502, 503, 520, 521, 522, 529]);

type ReadMode = "auto" | "render" | "static";

async function readProduct(href: string, env: Env, mode: ReadMode | boolean): Promise<PageInfo> {
  if (typeof mode === "boolean") mode = mode ? "render" : "auto";
  const canRender = mode !== "static" && !!env.BROWSER;
  let blockedBy = 0;
  if (mode !== "render" || !canRender) {
    let res = await fetchPage(href);
    // Stores sometimes answer a share link's redirect chain with an error
    // once; a second try usually goes through.
    if (!res.ok && BLOCKED.has(res.status)) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetchPage(href);
    }
    if (!res.ok) {
      if (!BLOCKED.has(res.status) || !canRender) {
        const blocked = BLOCKED.has(res.status) ? " (it may be blocking automated checks)" : "";
        return fail(`The store answered ${res.status}${blocked}`);
      }
      blockedBy = res.status;
    } else if (!(res.headers.get("content-type") || "").includes("html")) {
      // Some app-style stores answer plain requests with JSON or a shell;
      // a real browser still gets the page.
      if (!canRender) return fail("That link isn't a web page");
      blockedBy = -1;
    } else {
      const info = await parsePage(res, res.url || href);
      info.finalUrl = res.url || href;
      if (info.price != null || !canRender) return info;
    }
  }

  // Real browser, for pages that load the price with JavaScript or turn
  // away plain requests.
  const info = await renderAndParse(href, env.BROWSER as BrowserWorker);
  info.rendered = info.price != null;
  if (info.price == null && blockedBy > 0) {
    info.error = `The store answered ${blockedBy} and the page didn't load in a browser either. It may be blocking automated checks.`;
  }
  return info;
}

function fetchPage(href: string): Promise<Response> {
  return fetch(href, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
    },
    redirect: "follow",
  });
}

/** Resolves share/short links and drops tracking parameters, so the same product is stored once. */
async function canonicalUrl(url: URL): Promise<URL> {
  let out = url;
  if (/^(dl\.flipkart\.com|amzn\.in|amzn\.to|a\.co|fkrt\.(it|co|cc)|myntr\.it|bit\.ly|t\.co)$/i.test(url.hostname)) {
    try {
      // GET, not HEAD: some link shorteners only redirect on GET.
      const res = await fetch(url.href, { redirect: "follow", headers: { "user-agent": UA, accept: "text/html" } });
      await res.body?.cancel();
      if (res.url) out = new URL(res.url);
    } catch {
      // keep the link as given
    }
  }
  // Flipkart's /dl/ pages are the share-link landing; the product page is the same path on www.
  if (out.hostname === "dl.flipkart.com") {
    out.hostname = "www.flipkart.com";
    out.pathname = out.pathname.replace(/^\/dl\//, "/");
  }
  const drop = /^(utm_|fm$|ctx$|lid$|hl_lid$|_refId$|_appId$|marketplace$|ref$|ref_$|tag$|th$|psc$|spm$|srsltid$|gclid$|fbclid$|mc_)/i;
  for (const key of [...out.searchParams.keys()]) {
    if (drop.test(key)) out.searchParams.delete(key);
  }
  out.hash = "";
  return out;
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
    const finalUrl = page.url() || href;
    const info = await parsePage(new Response(html, { headers: { "content-type": "text/html" } }), finalUrl);
    info.finalUrl = finalUrl;
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
    listSelectors: [] as string[],
    guesses: [] as string[],
    stockText: "",
    title: "",
    image: null as string | null,
  };
  // Big marketplaces list many other products on a page (accessories,
  // "customers also bought"), so only their own price elements count there.
  const host = new URL(href).hostname;
  const marketplace = /(^|\.)(amazon\.[a-z.]+|flipkart\.com|myntra\.com|ajio\.com|meesho\.com|nykaa\.com)$/i.test(host);
  let ldText = "";
  let selText = "";
  let inSel = 0;
  let listText = "";
  let inList = 0;
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
        if (VOID_TAGS.has(e.tagName)) return;
        inSel++;
        e.onEndTag(() => {
          inSel--;
          if (selText.trim()) found.selectors.push(selText.trim());
          selText = "";
        });
      },
      text(t) { if (inSel) selText += t.text; },
    })
    .on(LIST_PRICE_SELECTORS, {
      element(e) {
        if (VOID_TAGS.has(e.tagName)) return;
        inList++;
        e.onEndTag(() => {
          inList--;
          if (listText.trim()) found.listSelectors.push(listText.trim());
          listText = "";
        });
      },
      text(t) { if (inList) listText += t.text; },
    })
    // 4. Last resort: any element whose class or id mentions "price". Only
    //    texts that look like an amount with a currency are kept.
    .on('[class*="price"], [class*="Price"], [id*="price"], [id*="Price"], [data-price]', {
      element(e) {
        if (found.guesses.length >= 40) return;
        const data = e.getAttribute("data-price");
        if (data && parsePrice(data)) found.guesses.push(data);
        // <input class="...price..."> and friends have no end tag to wait for.
        if (VOID_TAGS.has(e.tagName)) return;
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
    .on("#availability, #outOfStock", {
      // Amazon's stock line: "In stock" / "Currently unavailable".
      text(t) { found.stockText += t.text; },
    })
    .on("title", { text(t) { found.title += t.text; } })
    .transform(res)
    .arrayBuffer();

  const out: PageInfo = { title: "", image: null, price: null, currency: null, availability: null, listPrice: null };

  // 1. JSON-LD
  for (const raw of found.ld) {
    const product = findProduct(safeJSON(raw));
    if (!product) continue;
    out.title ||= text(product.name);
    out.image ||= firstImage(product.image);
    const offer = pickOffer(product.offers);
    if (offer && out.price == null) {
      const specs = ([] as Json[]).concat(offer.priceSpecification || []);
      const sale = specs.find((s) => !/ListPrice|StrikethroughPrice/i.test(s.priceType || "")) || {};
      const list = specs.find((s) => /ListPrice|StrikethroughPrice/i.test(s.priceType || ""));
      out.price = toNumber(offer.price ?? offer.lowPrice ?? sale.price);
      out.currency = offer.priceCurrency || sale.priceCurrency || null;
      out.availability = availabilityOf(offer.availability);
      out.listPrice = toNumber(list?.price);
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
  const stock = found.stockText.replace(/\s+/g, " ").trim();
  if (stock) out.availability ||= availabilityOf(stock);
  // An unavailable listing has no real price; don't invent one from the page.
  if (/currently unavailable|out of stock|sold out/i.test(stock)) {
    out.availability = "out_of_stock";
    if (out.via !== "json-ld") out.price = null;
  }
  out.listPrice ??= toNumber(meta["product:original_price:amount"] ?? meta["og:price:standard_amount"]);
  if (out.listPrice == null && found.listSelectors.length) out.listPrice = parsePrice(found.listSelectors[0]);

  // 3. store-specific elements
  if (out.price == null && found.selectors.length) {
    out.price = parsePrice(found.selectors[0]);
    out.currency ||= currencyFromSymbol(found.selectors[0]);
    out.via = `page: ${found.selectors.slice(0, 3).join(" | ")}`;
  }

  // 4. generic "price" elements (rendered pages mostly end up here)
  if (out.price == null && found.guesses.length && !marketplace) {
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

  out.title = (out.title ? out.title.replace(/\s+/g, " ").trim().slice(0, 200)
    : cleanTitle(meta["og:title"] || meta["twitter:title"] || decodeEntities(found.title)))
    || new URL(href).hostname;
  out.image ||= meta["og:image"] || meta["twitter:image"] || found.image || null;
  if (out.image) {
    try { out.image = new URL(out.image, href).href; } catch { out.image = null; }
  }
  if (out.price != null && !(out.price > 0)) out.price = null;
  // A list price only means something if it's above the selling price.
  if (out.listPrice != null && (out.price == null || out.listPrice <= out.price)) out.listPrice = null;
  if (out.price == null) {
    out.error = out.availability === "out_of_stock"
      ? "This listing is currently unavailable, so there's no price to track yet."
      : "Couldn't find a price on that page. The store may load prices with JavaScript or block automated checks.";
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

// Page titles carry store chrome: "Buy X Online - Croma", "X | Nykaa",
// "X : Amazon.in: Electronics". JSON-LD names don't, so they're left alone.
function cleanTitle(s: string): string {
  return s.replace(/\s+/g, " ")
    .replace(/^buy\s+/i, "")
    .replace(/\s+online\b.*$/i, "")
    .replace(/\s*[-|–:]\s*(amazon\.in|flipkart\.com|croma|nykaa|ajio|meesho|bigbasket|snapdeal|reliance digital|tata cliq|vijay sales|myntra)\b.*$/i, "")
    .replace(/\s+[-|–]\s+[^-|–]{2,40}$/, "")
    .trim().slice(0, 200);
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
