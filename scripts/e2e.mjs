#!/usr/bin/env node
// End-to-end test against a running deployment (local `npm run dev` or live).
//
//   node scripts/e2e.mjs                      # http://localhost:8787
//   node scripts/e2e.mjs http://localhost:8797
//   node scripts/e2e.mjs https://price-tracker.sbkforge.workers.dev
//
// Adds real products from Amazon.in, Flipkart and a few brand stores under a
// throwaway owner, checks every API the page uses, then removes them.
// Exits non-zero if a required step fails. Stores that block or rate-limit
// are reported as SKIPPED, not failures, unless marked required.

const base = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const owner = "e2e" + Math.random().toString(36).slice(2).padEnd(20, "x");
const other = "e2eother" + Math.random().toString(36).slice(2).padEnd(20, "y");

// Real product pages, one per store family. `required` ones must read; the
// rest depend on the store's mood (rate limits, bot walls) and may be skipped.
// `min`/`max` are sanity bounds so a wrong element (an accessory, a coupon)
// can't pass as the product's price.
const PRODUCTS = [
  { name: "Amazon.in Echo Dot", url: "https://www.amazon.in/dp/B09B8XJDW5", required: true, currency: "INR", min: 2000, max: 9000 },
  { name: "Flipkart MacBook Pro (share link)", url: "https://dl.flipkart.com/s/g_v8VPuuuN", required: true, currency: "INR", min: 200000, max: 400000,
    expectUrl: /^https:\/\/www\.flipkart\.com\/.+\/p\/itm/ },
  { name: "boAt Airdopes 141 (Shopify JSON-LD)", url: "https://www.boat-lifestyle.com/products/airdopes-141", required: true, currency: "INR", min: 500, max: 3000 },
  { name: "Decathlon camping bed", url: "https://www.decathlon.in/p/968079/accessories/bedchair-fullbreak-carp-fishing?id=968079&type=p", required: false, currency: "INR", min: 5000, max: 40000 },
  { name: "Myntra t-shirt", url: "https://www.myntra.com/tshirts/roadster/roadster-men-black-cotton-pure-cotton-t-shirt/1700944/buy", required: false, currency: "INR", min: 100, max: 3000 },
  { name: "Zepto OnePlus 13R", url: "https://www.zepto.com/pn/oneplus-13r-12gb-256gb-astral-trail/pvid/043d54ac-545c-4f73-91ce-f0d171462570", required: false, currency: "INR", min: 20000, max: 60000 },
  { name: "Blinkit coriander (browser)", url: "https://blinkit.com/prn/coriander-bunch-dhaniya-patti/prid/3889", required: false, currency: "INR", min: 5, max: 100 },
  { name: "Instamart milk (browser)", url: "https://www.swiggy.com/instamart/item/CCX1XWR7GN", required: false, currency: "INR", min: 10, max: 200 },
  { name: "Tata CLiQ shirt (browser)", url: "https://www.tatacliq.com/arrow-men-cotton-linen-slim-fit-shirt/p-mp000000027411083", required: false, currency: "INR", min: 500, max: 6000 },
  { name: "Vijay Sales cooler", url: "https://www.vijaysales.com/p/197712/bluestar-375-l-5-star-vertical-visi-cooler-double-layer-glass-door-tropicalized-compressor-adjustable-shelves-sc375f-white", required: false, currency: "INR", min: 15000, max: 80000 },
  { name: "Samsung Galaxy S26 Ultra", url: "https://www.samsung.com/in/smartphones/galaxy-s26-ultra/buy/", required: false, currency: "INR", min: 80000, max: 250000 },
  { name: "Apple iPhone 16 (apple.com/in)", url: "https://www.apple.com/in/shop/buy-iphone/iphone-16", required: false, currency: "INR", min: 50000, max: 150000 },
];

// A store that blocks the Worker, added the way the "Track price" bookmark does it.
const BLOCKED_SNAPSHOT = {
  name: "Croma iPhone via bookmark snapshot",
  url: "https://www.croma.com/apple-iphone-17-pro-256gb-cosmic-orange-/p/317417",
  snapshot: { title: "Apple iPhone 17 Pro 256GB (Cosmic Orange)", price: 134900, currency: "INR", image: "https://media.croma.com/image/upload/example.png", availability: "InStock", listPrice: 139900 },
};

let pass = 0, fail = 0, skip = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  ${dim(detail)}` : ""}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`); }
  return cond;
};
const skipped = (name, why) => { skip++; console.log(`  – ${name}  ${dim(`skipped: ${why}`)}`); };
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const section = (s) => console.log(`\n${s}`);

async function api(path, { method = "GET", body, as = owner, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(as ? { "x-owner": as } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const blockedError = (msg = "") => /answered \d+|blocking|browser|rate limit|unavailable|didn't finish/i.test(msg);

console.log(`Price Tracker end-to-end against ${base}`);

section("Basics");
{
  const { status, data } = await api("/api/config", { as: null });
  ok("GET /api/config", status === 200 && typeof data.browserRendering === "boolean", `push key ${data.vapidPublicKey?.length || 0} chars, browser rendering ${data.browserRendering}`);
  const res = await api("/https://www.flipkart.com/x/p/itm1?pid=A1", { raw: true, as: null });
  ok("Prefix trick /https://… redirects to /?url=", res.status === 302 && /\/\?url=https%3A%2F%2Fwww\.flipkart\.com/.test(res.headers.get("location") || ""));
  const noOwner = await api("/api/products", { as: null });
  ok("Owner header required", noOwner.status === 400);
  const page = await fetch(base + "/");
  const html = await page.text();
  ok("Page serves", page.status === 200 && /id="add"/.test(html) && /app\.js/.test(html));
  const sw = await fetch(base + "/sw.js");
  ok("Service worker served", sw.status === 200 && /push/.test(await sw.text()));
  const manifest = await (await fetch(base + "/manifest.json")).json();
  ok("Manifest has share target", !!manifest.share_target);
}

section("Tracking real products");
const added = [];
for (const p of PRODUCTS) {
  const t0 = Date.now();
  const { status, data } = await api("/api/products", { method: "POST", body: { url: p.url, target: 1 } });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (status === 201) {
    const sane = data.price > 0 && (!p.min || data.price >= p.min) && (!p.max || data.price <= p.max);
    ok(`${p.name}: added`, sane && (!p.currency || data.currency === p.currency),
      `${data.price} ${data.currency} via ${data.via} in ${secs}s${sane ? "" : `  (expected ${p.min}–${p.max})`}`);
    added.push({ ...p, id: data.id });
  } else if (!p.required && blockedError(data.error)) {
    skipped(`${p.name}`, data.error);
  } else {
    ok(`${p.name}: added`, false, `${status} ${data.error}`);
  }
}

{
  const b = BLOCKED_SNAPSHOT;
  const plain = await api("/api/products", { method: "POST", body: { url: b.url } });
  ok("Blocked store without the bookmark explains what to do", plain.status === 422 && /bookmark/i.test(plain.data.error || ""), (plain.data.error || "").slice(0, 90));
  const snap = await api("/api/products", { method: "POST", body: { url: b.url, snapshot: b.snapshot } });
  if (ok(`${b.name}: added from the snapshot`, snap.status === 201 && snap.data.price === b.snapshot.price && snap.data.via === "bookmark", JSON.stringify(snap.data))) {
    added.push({ name: b.name, url: b.url, id: snap.data.id, currency: "INR", min: 100000, max: 200000, snapshot: true });
    const again = await api("/api/products", { method: "POST", body: { url: b.url, snapshot: { ...b.snapshot, price: 129900 } } });
    ok("Bookmark on the same page records a new price", again.status === 200 && again.data.updated === true && again.data.price === 129900, JSON.stringify(again.data));
    const { data } = await api("/api/products");
    const p = data.products.find((x) => x.id === snap.data.id);
    ok("Snapshot product has two history points and the list price", p && p.history.length === 2 && p.price === 129900 && p.list_price === 139900 && p.highest === 134900);
  }
}

section("What the page gets back");
let products = [];
{
  const { data } = await api("/api/products");
  products = data.products || [];
  ok("List returns every added product", products.length === added.length, `${products.length} products`);
  for (const a of added) {
    const p = products.find((x) => x.id === a.id);
    if (!ok(`${a.name}: present`, !!p)) continue;
    ok(`${a.name}: title, store, price, currency`, p.title.length > 3 && p.store && p.price > 0 && p.currency, `${p.store} · ${p.title.slice(0, 50)}`);
    if (!a.snapshot) ok(`${a.name}: history has the first point (chart data)`, Array.isArray(p.history) && p.history.length >= 1 && p.history[0][1] === p.price && p.lowest === p.price && p.highest === p.price && p.first === p.price);
    ok(`${a.name}: photo found`, !!p.image, p.image ? "" : "no image");
    if (p.availability == null) skipped(`${a.name}: stock status`, "the page doesn't say");
    else ok(`${a.name}: stock status read`, ["in_stock", "out_of_stock", "preorder"].includes(p.availability), String(p.availability));
    if (a.expectUrl) ok(`${a.name}: share link resolved to the product page`, a.expectUrl.test(p.url), p.url.slice(0, 70));
    if (!a.snapshot) ok(`${a.name}: target saved`, p.target === 1);
  }
}

section("Product actions");
if (added.length) {
  const a = added[0];
  const dup = await api("/api/products", { method: "POST", body: { url: a.url } });
  ok("Adding the same link again is refused", dup.status === 409);
  const t = await api(`/api/products/${a.id}`, { method: "PATCH", body: { target: 999 } });
  ok("Set target", t.status === 200);
  const b = await api(`/api/products/${a.id}`, { method: "PATCH", body: { bought: { price: 123 } } });
  ok("Mark as bought", b.status === 200);
  let { data } = await api("/api/products");
  let p = data.products.find((x) => x.id === a.id);
  ok("Target and purchase show in the list", p.target === 999 && p.bought_price === 123 && p.bought_at > 0);
  await api(`/api/products/${a.id}`, { method: "PATCH", body: { bought: null } });
  ({ data } = await api("/api/products"));
  p = data.products.find((x) => x.id === a.id);
  ok("Clear purchase", p.bought_at === null && p.bought_price === null);
  const c = await api(`/api/products/${a.id}/check`, { method: "POST" });
  ok("Check now (fresh result reused)", c.status === 200 && c.data.ok && c.data.cached === true, JSON.stringify(c.data));
  const csv = await api(`/api/products/${a.id}/history.csv`, { raw: true });
  const text = await csv.text();
  ok("CSV export", csv.status === 200 && text.startsWith("date,price,currency") && text.trim().split("\n").length === 2, text.trim().split("\n")[1]);
  const foreign = await api(`/api/products/${a.id}`, { as: other, method: "DELETE" });
  ok("Another visitor can't delete it", foreign.status === 404);
  const foreignList = await api("/api/products", { as: other });
  ok("Another visitor sees an empty list", foreignList.data.products.length === 0);
}

section("Share, search, deals");
{
  const s = await api("/api/share");
  ok("Share link created", s.status === 200 && /^[A-Za-z0-9_-]{16,}$/.test(s.data.token) && s.data.url.includes("?list="));
  const again = await api("/api/share");
  ok("Share link is stable", again.data.token === s.data.token);
  const shared = await api(`/api/shared/${s.data.token}`, { as: null });
  ok("Shared list is readable without an owner", shared.status === 200 && shared.data.products.length === added.length);
  ok("Shared list hides targets and purchases", shared.data.products.every((p) => p.target === null && p.bought_at === null && p.owner === ""));
  const bad = await api("/api/shared/nope_nope_nope_nope", { as: null });
  ok("Unknown share token is a 404", bad.status === 404);

  const cmp = await api("/api/compare?q=boAt%20Airdopes%20141");
  if (cmp.status === 200 && cmp.data.hits.length) {
    ok("Search by name finds Flipkart results", cmp.data.hits.every((h) => /^https:\/\/www\.flipkart\.com\//.test(h.url) && h.title), `${cmp.data.hits.length} hits, first ${cmp.data.hits[0].price} INR`);
    // Track a search result, as the page's "Track this" button does.
    const hit = cmp.data.hits.find((h) => h.price);
    const t0 = Date.now();
    const r = await api("/api/products", { method: "POST", body: { url: hit.url } });
    if (r.status === 201) {
      ok("Track a search result", r.data.price > 0, `${hit.title.slice(0, 40)} → ${r.data.price} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      added.push({ name: "search result", url: hit.url, id: r.data.id });
    } else if (blockedError(r.data.error)) skipped("Track a search result", r.data.error);
    else ok("Track a search result", false, r.data.error);
  } else if (cmp.data.blocked?.includes("flipkart.com")) skipped("Search by name", "Flipkart didn't answer");
  else ok("Search by name", false, JSON.stringify(cmp.data).slice(0, 120));

  const deals = await api("/api/deals", { as: null });
  ok("Deals feed", deals.status === 200 && Array.isArray(deals.data.deals), `${deals.data.deals?.length} deals`);
  const insp = await api(`/api/inspect?url=${encodeURIComponent("https://www.amazon.in/dp/B0BDK62PDX")}`);
  ok("Unavailable Amazon listing isn't given a made-up price", insp.status === 200 && insp.data.price === null, insp.data.error || `price ${insp.data.price}`);
}

section("Cleanup");
for (const a of added) {
  const r = await api(`/api/products/${a.id}`, { method: "DELETE" });
  ok(`Remove ${a.name}`, r.status === 200);
}
{
  const { data } = await api("/api/products");
  ok("List is empty again", data.products.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length) console.log("Failed: " + failures.join("; "));
process.exit(fail ? 1 : 0);
