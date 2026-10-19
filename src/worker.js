// price-tracker Worker: reads prices from product pages, stores them in D1,
// and re-checks every product on a schedule. Static files come from ./public.

const CHECK_EVERY = 6 * 60 * 60 * 1000; // re-check a product every 6 hours
const BATCH = 25; // products per scheduled run (free plan allows 50 fetches)

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (path === "/api/products" && method === "GET") return await listProducts(env);
      if (path === "/api/products" && method === "POST") {
        if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
        return await addProduct(request, env);
      }

      const m = /^\/api\/products\/(\d+)(\/check)?$/.exec(path);
      if (m) {
        if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
        const id = Number(m[1]);
        if (m[2] && method === "POST") return await checkNow(env, id);
        if (!m[2] && method === "PATCH") return await updateProduct(request, env, id);
        if (!m[2] && method === "DELETE") return await deleteProduct(env, id);
      }

      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.message || "Server error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkDue(env));
  },
};

// ---------- API ----------

async function listProducts(env) {
  const { results: products } = await env.DB.prepare(
    "SELECT * FROM products ORDER BY created_at DESC"
  ).all();

  // Full history is small (4 checks a day), so send it all for the charts.
  const { results: rows } = await env.DB.prepare(
    "SELECT product_id, price, checked_at FROM prices ORDER BY checked_at"
  ).all();
  const history = {};
  for (const r of rows) (history[r.product_id] ||= []).push([r.checked_at, r.price]);

  return json({
    products: products.map((p) => {
      const h = history[p.id] || [];
      const values = h.map((x) => x[1]);
      return {
        ...p,
        history: h,
        lowest: values.length ? Math.min(...values) : null,
        highest: values.length ? Math.max(...values) : null,
        first: values.length ? values[0] : null,
      };
    }),
  }, 200, { "cache-control": "no-store" });
}

async function addProduct(request, env) {
  const body = await request.json().catch(() => ({}));
  let url;
  try {
    url = new URL(String(body.url || "").trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return json({ error: "Paste a full product link starting with https://" }, 400);
  }
  url.hash = "";

  const existing = await env.DB.prepare("SELECT id FROM products WHERE url = ?")
    .bind(url.href).first();
  if (existing) return json({ error: "You're already tracking that product" }, 409);

  const info = await readProduct(url.href);
  if (info.price == null) {
    return json({ error: info.error || "Couldn't find a price on that page" }, 422);
  }

  const now = Date.now();
  const target = toNumber(body.target);
  const row = await env.DB.prepare(
    `INSERT INTO products (url, title, image, store, currency, price, target, created_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(url.href, info.title, info.image, storeName(url), info.currency, info.price,
    target, now, now).first();
  await env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
    .bind(row.id, info.price, now).run();

  return json({ ok: true, id: row.id, price: info.price, currency: info.currency, via: info.via }, 201);
}

async function updateProduct(request, env, id) {
  const body = await request.json().catch(() => ({}));
  await env.DB.prepare("UPDATE products SET target = ? WHERE id = ?")
    .bind(toNumber(body.target), id).run();
  return json({ ok: true });
}

async function deleteProduct(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM prices WHERE product_id = ?").bind(id),
    env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function checkNow(env, id) {
  const p = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
  if (!p) return json({ error: "Not found" }, 404);
  const result = await checkProduct(env, p);
  return json({ ok: !result.error, ...result });
}

// ---------- scheduled checks ----------

async function checkDue(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM products WHERE checked_at IS NULL OR checked_at < ? ORDER BY checked_at LIMIT ?"
  ).bind(Date.now() - CHECK_EVERY, BATCH).all();
  for (const p of results) {
    await checkProduct(env, p);
  }
}

async function checkProduct(env, p) {
  const now = Date.now();
  let info;
  try {
    info = await readProduct(p.url);
  } catch (err) {
    info = { error: err.message };
  }

  if (info.price == null) {
    // Keep the last good price; just note what went wrong.
    await env.DB.prepare("UPDATE products SET error = ?, checked_at = ? WHERE id = ?")
      .bind(info.error || "Couldn't find a price", now, p.id).run();
    return { error: info.error || "Couldn't find a price" };
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE products SET price = ?, currency = COALESCE(?, currency), error = NULL,
       checked_at = ?, image = COALESCE(image, ?) WHERE id = ?`
    ).bind(info.price, info.currency, now, info.image, p.id),
    env.DB.prepare("INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)")
      .bind(p.id, info.price, now),
  ]);
  return { price: info.price };
}

// ---------- reading a product page ----------
//
// Most stores publish product data for search engines, which is what this
// reads, in order of reliability:
//   1. JSON-LD  <script type="application/ld+json"> with a schema.org Product
//   2. meta tags  product:price:amount / og:price:amount / itemprop="price"
//   3. a few store-specific price elements (Amazon, Flipkart)

async function readProduct(href) {
  const res = await fetch(href, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-IN,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    return { error: `The store answered ${res.status}${res.status === 403 || res.status === 503 ? " (it may be blocking automated checks)" : ""}` };
  }
  if (!(res.headers.get("content-type") || "").includes("html")) {
    return { error: "That link isn't a web page" };
  }

  const found = { ld: [], meta: {}, itemprop: null, selectors: [], title: "", image: null };
  let ldText = "";
  let selText = "";
  let inSel = 0;

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
        if (found.itemprop == null && e.getAttribute("content")) found.itemprop = e.getAttribute("content");
      },
    })
    .on(
      // Amazon, then Flipkart's price elements.
      // Only the main buy box: other .a-price elements are related products.
      "#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, " +
      "#apex_desktop .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, " +
      "#price_inside_buybox, #newBuyBoxPrice, div.Nx9bqj, div._30jeq3",
      {
        element(e) {
          inSel++;
          e.onEndTag(() => {
            inSel--;
            if (selText.trim()) found.selectors.push(selText.trim());
            selText = "";
          });
        },
        text(t) { if (inSel) selText += t.text; },
      }
    )
    .on("#landingImage, #imgTagWrapperId img", {
      // Amazon has no og:image; use the main product photo.
      element(e) {
        found.image ||= e.getAttribute("data-old-hires") || e.getAttribute("src");
      },
    })
    .on("title", { text(t) { found.title += t.text; } })
    .transform(res)
    .arrayBuffer();

  const out = { title: "", image: null, price: null, currency: null };

  // 1. JSON-LD
  for (const raw of found.ld) {
    const product = findProduct(safeJSON(raw));
    if (!product) continue;
    out.title ||= text(product.name);
    out.image ||= firstImage(product.image);
    const offer = pickOffer(product.offers);
    if (offer && out.price == null) {
      out.price = toNumber(offer.price ?? offer.lowPrice ?? (offer.priceSpecification || {}).price);
      out.currency = offer.priceCurrency || (offer.priceSpecification || {}).priceCurrency || null;
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

  // 3. store-specific elements
  if (out.price == null && found.selectors.length) {
    out.price = parsePrice(found.selectors[0]);
    out.currency ||= currencyFromSymbol(found.selectors[0]);
    out.via = `page: ${found.selectors.slice(0, 3).join(" | ")}`;
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
  }
  return out;
}

function findProduct(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findProduct(n);
      if (p) return p;
    }
    return null;
  }
  const type = [].concat(node["@type"] || []).map(String);
  if (type.some((t) => /^(Product|ProductGroup|IndividualProduct|Vehicle|Book)$/i.test(t))) {
    // A ProductGroup (variants) may hold its offers on the first variant.
    if (!node.offers && Array.isArray(node.hasVariant) && node.hasVariant[0]) {
      return { ...node, offers: node.hasVariant[0].offers };
    }
    return node;
  }
  return findProduct(node["@graph"]) || findProduct(node.mainEntity);
}

function pickOffer(offers) {
  if (!offers) return null;
  if (Array.isArray(offers)) {
    // Prefer an in-stock offer, then the lowest price.
    const priced = offers.filter((o) => toNumber(o.price ?? o.lowPrice) != null);
    const inStock = priced.filter((o) => !/OutOfStock/i.test(o.availability || ""));
    const pool = inStock.length ? inStock : priced;
    return pool.sort((a, b) => toNumber(a.price ?? a.lowPrice) - toNumber(b.price ?? b.lowPrice))[0] || null;
  }
  if (offers.offers) return pickOffer(offers.offers);
  return offers;
}

function firstImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return firstImage(img[0]);
  if (typeof img === "object") return img.url || img.contentUrl || null;
  return String(img);
}

function text(v) {
  return Array.isArray(v) ? String(v[0] || "") : v ? String(v) : "";
}

function safeJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Some stores leave raw newlines inside strings; try once more without them.
    try { return JSON.parse(raw.replace(/[\r\n\t]+/g, " ")); } catch { return null; }
  }
}

function toNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  return parsePrice(String(v));
}

// "₹1,299.00" -> 1299, "1.299,00 €" -> 1299, "$19.99" -> 19.99
function parsePrice(s) {
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

function currencyFromSymbol(s) {
  const code = /\b(INR|USD|EUR|GBP|JPY|AUD|CAD|AED|SGD)\b/.exec(s);
  if (code) return code[1];
  if (/₹|Rs\.?/i.test(s)) return "INR";
  if (/€/.test(s)) return "EUR";
  if (/£/.test(s)) return "GBP";
  if (/¥/.test(s)) return "JPY";
  if (/\$/.test(s)) return "USD";
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function storeName(url) {
  return url.hostname.replace(/^www\./, "");
}

// ---------- helpers ----------

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
