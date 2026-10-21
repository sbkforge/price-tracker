// Price Tracker page. Built with esbuild into public/app.js.

import {
  createElement as lucide, Bell, BellRing, BookmarkPlus, Check, Compass, Copy, Download, ExternalLink, Flame, History,
  Lightbulb, Link, MessageCircle, Mic, Plus, RefreshCw, Search, Settings, Share2, ShoppingBag, SlidersHorizontal,
  Tag, Tags, Trash2, Undo2, X,
} from "lucide";
import type { IconNode } from "lucide";
import type {
  BackfillResponse, CheckResponse, CompareHit, CompareResponse, ConfigResponse, Deal, DealsResponse, ListResponse,
  OpenResponse, PricePoint, Product, ShareResponse, Snapshot, UpdateRequest,
} from "../src/shared";

// ---------- icons (Lucide) ----------

const ICONS: Record<string, IconNode> = {
  bell: Bell, "bell-ring": BellRing, "bookmark-plus": BookmarkPlus, check: Check, compass: Compass, copy: Copy, download: Download,
  "external-link": ExternalLink, flame: Flame, history: History, lightbulb: Lightbulb, link: Link,
  "message-circle": MessageCircle, mic: Mic, plus: Plus, "refresh-cw": RefreshCw, search: Search,
  settings: Settings, "share-2": Share2, "shopping-bag": ShoppingBag, "sliders-horizontal": SlidersHorizontal,
  tag: Tag, tags: Tags, "trash-2": Trash2, "undo-2": Undo2, x: X,
};

function icon(name: keyof typeof ICONS, size = 16): SVGElement {
  const svg = lucide(ICONS[name], { width: size, height: size, "stroke-width": 2, "aria-hidden": "true" });
  svg.classList.add("lucide");
  return svg;
}

// <i class="ic" data-icon="bell"></i> placeholders in the HTML become SVGs.
document.querySelectorAll<HTMLElement>("i.ic[data-icon]").forEach((i) => {
  const name = i.dataset.icon as keyof typeof ICONS;
  if (ICONS[name]) i.replaceChildren(icon(name, i.classList.contains("empty-ic") ? 56 : i.classList.contains("brand-ic") ? 20 : 16));
});

/** A pill button with a Lucide icon in front of its label. */
function pill(name: keyof typeof ICONS, label: string, cls = "pill"): HTMLButtonElement {
  const b = el("button", cls);
  b.append(icon(name, 14), document.createTextNode(` ${label}`));
  return b;
}

type Filter = "all" | "browse" | "dropped" | "alerts" | "target" | "out" | "bought" | "deals";
type Sort = "recent" | "drop" | "score" | "low" | "high" | "name";
type Mode = "list" | "search" | "shared";

const state = {
  mode: "list" as Mode,
  products: [] as Product[],
  filter: "all" as Filter,
  sort: "recent" as Sort,
  query: "",
  loaded: false,
  config: null as ConfigResponse | null,
  deals: null as Deal[] | null,
  catalog: null as Product[] | null,
  dealCat: "all",
  dealMin: 0,
  search: { query: "", hits: [] as CompareHit[], blocked: [] as string[], loading: false },
  shared: null as { token: string; products: Product[] } | null,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const store = {
  get(k: string, fallback: string): string {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k: string, v: string): void {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
};

// A random id per browser; the server keeps each id's list separate.
// It doubles as the sync code for other devices.
function ownerId(): string {
  let id = store.get("owner", "");
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    store.set("owner", id);
  }
  return id;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-owner": ownerId(),
      ...(options.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

// ---------- toast ----------

let toastTimer = 0;
function toast(text: string, kind: "info" | "error" | "success" = "info"): void {
  const t = $("toast");
  t.textContent = text;
  t.dataset.kind = kind;
  t.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), kind === "error" ? 6000 : 3000);
}

// ---------- loading ----------

async function load(): Promise<void> {
  try {
    const data = await api<ListResponse>("/api/products");
    state.products = data.products;
    state.loaded = true;
    render();
  } catch (err) {
    toast(`Could not load: ${(err as Error).message}`, "error");
  }
}

// ---------- formatting ----------

function money(value: number | null, currency: string | null): string {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: value % 1 ? 2 : 0,
    }).format(value);
  } catch {
    return `${currency || ""} ${value.toLocaleString()}`.trim();
  }
}

/** Rounds to whole units when the product's prices are whole (most INR listings). */
const tidy = (p: Product, v: number | null): number | null =>
  v != null && p.price != null && Number.isInteger(p.price) ? Math.round(v) : v;

function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dateShort = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dateLong = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string | null
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const isUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s.trim());

// ---------- categories (for Deals and "Deals in this category") ----------

const CATEGORIES: Array<[string, RegExp]> = [
  ["Phones", /\b(phone|iphone|galaxy|pixel|redmi|realme|oneplus|vivo|oppo|poco|smartphone|5g)\b/i],
  ["Laptops", /\b(laptop|macbook|notebook|chromebook|thinkpad|ideapad|vivobook|zenbook|pavilion|inspiron)\b/i],
  ["Tablets", /\b(ipad|tablet|tab s|galaxy tab)\b/i],
  ["Audio", /\b(earbuds|earphones|headphones|airpods|airdopes|speaker|soundbar|tws|buds)\b/i],
  ["Watches", /\b(smartwatch|smart watch|watch|band)\b/i],
  ["TVs", /\b(tv|television|smart tv|oled|qled)\b/i],
  ["Cameras", /\b(camera|dslr|mirrorless|gopro|lens)\b/i],
  ["Gaming", /\b(playstation|ps5|xbox|nintendo|gaming|controller|console)\b/i],
  ["Appliances", /\b(fridge|refrigerator|washing machine|air fryer|microwave|mixer|grinder|ac|air conditioner|purifier|vacuum|dishwasher|cooler|geyser|fan)\b/i],
  ["Fashion", /\b(shirt|t-shirt|tshirt|jeans|dress|kurta|saree|jacket|hoodie|shoes|sneakers|sandals|trousers|shorts)\b/i],
  ["Beauty", /\b(serum|moisturizer|shampoo|lipstick|foundation|perfume|sunscreen|face wash|hair oil)\b/i],
  ["Home", /\b(sofa|chair|table|mattress|bedsheet|pillow|lamp|curtain|cookware|bottle)\b/i],
  ["Sports", /\b(backpack|cycle|bicycle|treadmill|dumbbell|yoga|cricket|football|tent|hiking|camping)\b/i],
  ["Books", /\b(book|novel|paperback|hardcover)\b/i],
];

function categoryOf(title: string): string {
  for (const [name, re] of CATEGORIES) if (re.test(title)) return name;
  return "Other";
}

// ---------- deal score (Buyhatke-style, from our own history) ----------
//
// Starts at 100 and loses points for signs that "the deal" isn't one:
// the price being above its lows and average, and a price pump (a rise
// shortly before the current drop). Needs a few checks to mean anything.

interface ScoreLine { label: string; points: number; detail: string }
interface DealScore {
  score: number | null;           // 0..100, or null when there isn't enough history
  label: string;
  kind: "great" | "good" | "meh" | "bad" | "new";
  lines: ScoreLine[];
  pump: boolean;
}

function dealScore(p: Product): DealScore {
  const h = p.history;
  const n = h.length;
  if (p.price == null || n < 3 || p.lowest == null || p.average == null) {
    return {
      score: null, kind: "new", label: "Not enough history yet", pump: false,
      lines: [{ label: "Checks so far", points: 0, detail: `${n} of the 3 needed` }],
    };
  }
  const price = p.price;
  const lines: ScoreLine[] = [];

  // 1. Price pump: did it climb and then "drop" to where it already was?
  const recent = h.filter(([t]) => t >= Date.now() - 30 * DAY);
  let pump = false;
  if (recent.length >= 3) {
    const peakIdx = recent.reduce((best, pt, i) => (pt[1] > recent[best][1] ? i : best), 0);
    const before = recent.slice(0, peakIdx).map((x) => x[1]);
    const peak = recent[peakIdx][1];
    const base = before.length ? Math.min(...before) : null;
    pump = base != null && peak > base * 1.05 && price < peak && price >= base * 0.98;
  }
  lines.push({
    label: "Price hiked before this drop", points: pump ? 36 : 0,
    detail: pump ? "It rose, then came back to about where it was" : "No pump seen",
  });

  // 2. Above the all-time low seen here
  const vsLow = (price - p.lowest) / p.lowest;
  lines.push({
    label: `Above all-time low (${money(p.lowest, p.currency)})`,
    points: Math.min(30, Math.round(vsLow * 100 * 1.5)),
    detail: vsLow <= 0.005 ? "At the lowest seen" : `${Math.round(vsLow * 100)}% above`,
  });

  // 3. Above the 30-day low
  const low30 = recent.length ? Math.min(...recent.map((x) => x[1])) : p.lowest;
  const vs30 = (price - low30) / low30;
  lines.push({
    label: `Above 30-day low (${money(low30, p.currency)})`,
    points: Math.min(16, Math.round(vs30 * 100)),
    detail: vs30 <= 0.005 ? "At the 30-day low" : `${Math.round(vs30 * 100)}% above`,
  });

  // 4. Above the average
  const vsAvg = (price - p.average) / p.average;
  lines.push({
    label: `Above average price (${money(tidy(p, p.average), p.currency)})`,
    points: vsAvg > 0 ? Math.min(18, Math.round(vsAvg * 100 * 1.5)) : 0,
    detail: vsAvg > 0 ? `${Math.round(vsAvg * 100)}% above` : `${Math.round(-vsAvg * 100)}% below`,
  });

  const score = Math.max(0, 100 - lines.reduce((s, l) => s + l.points, 0));
  const kind = score >= 75 ? "great" : score >= 50 ? "good" : score >= 25 ? "meh" : "bad";
  const label = pump ? "Deal mirage" : kind === "great" ? "Real deal" : kind === "good" ? "Decent deal" : kind === "meh" ? "Nothing special" : "Skip for now";
  return { score, kind, label, lines, pump };
}

// Plain-words verdict shown on cards and in the sheet.
type Verdict = { kind: "great" | "good" | "fair" | "wait" | "new"; label: string; why: string };

function verdict(p: Product): Verdict {
  const n = p.history.length;
  if (p.price == null || n < 3 || p.lowest == null || p.average == null) {
    return { kind: "new", label: "Building history", why: `${n} check${n === 1 ? "" : "s"} so far. The verdict needs a few more.` };
  }
  const vsAvg = (p.price - p.average) / p.average;
  const vsLow = (p.price - p.lowest) / p.lowest;
  const cur = money(p.price, p.currency);
  const avg = money(tidy(p, p.average), p.currency);
  if (vsLow <= 0.005 && vsAvg <= -0.03) {
    return { kind: "great", label: "Great price", why: `${cur} is the lowest seen and ${Math.round(-vsAvg * 100)}% under the average of ${avg}.` };
  }
  if (vsAvg <= -0.01) {
    return { kind: "good", label: "Good price", why: `${cur} is ${Math.round(-vsAvg * 100)}% under the average of ${avg}; the lowest seen was ${money(p.lowest, p.currency)}.` };
  }
  if (vsAvg >= 0.05) {
    return { kind: "wait", label: "Wait", why: `${cur} is ${Math.round(vsAvg * 100)}% above the average of ${avg}. It has been as low as ${money(p.lowest, p.currency)}.` };
  }
  return { kind: "fair", label: "Fair price", why: `${cur} is around the average of ${avg}. Lowest seen: ${money(p.lowest, p.currency)}.` };
}

// An MRP far above anything the product ever sold for is marketing, not a saving.
const inflatedList = (p: Product): boolean =>
  p.list_price != null && p.highest != null && p.history.length >= 3 && p.list_price > p.highest * 1.6;

// ---------- rendering ----------

const isDropped = (p: Product): boolean => p.first != null && p.price != null && p.price < p.first;
const isHit = (p: Product): boolean => p.target != null && p.price != null && p.price <= p.target;
const dropPct = (p: Product): number =>
  p.first && p.price != null ? (p.first - p.price) / p.first : 0;

function visible(list: Product[]): Product[] {
  const q = state.query.toLowerCase();
  const shown = list.filter((p) => {
    if (q && !`${p.title} ${p.store}`.toLowerCase().includes(q)) return false;
    switch (state.filter) {
      case "dropped": return isDropped(p);
      case "alerts": return p.target != null;
      case "target": return isHit(p);
      case "out": return p.availability === "out_of_stock";
      case "bought": return p.bought_at != null;
      default: return true;
    }
  });
  const by: Record<Sort, (a: Product, b: Product) => number> = {
    recent: (a, b) => b.created_at - a.created_at,
    drop: (a, b) => dropPct(b) - dropPct(a),
    score: (a, b) => (dealScore(b).score ?? -1) - (dealScore(a).score ?? -1),
    low: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    high: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    name: (a, b) => a.title.localeCompare(b.title),
  };
  return shown.sort(by[state.sort]);
}

function setEmpty(show: boolean, title = "", text = "", examples = false): void {
  $("empty").hidden = !show;
  $("emptyTitle").textContent = title;
  $("emptyText").textContent = text;
  $("examples").hidden = !examples;
}

document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((b) =>
  b.addEventListener("click", () => {
    $<HTMLInputElement>("url").value = b.dataset.example || "";
    $<HTMLInputElement>("url").dispatchEvent(new Event("input"));
    $<HTMLFormElement>("add").requestSubmit();
  })
);
document.querySelectorAll<HTMLButtonElement>("[data-open-settings]").forEach((b) =>
  b.addEventListener("click", () => $("settingsBtn").click())
);

function render(): void {
  document.querySelectorAll<HTMLButtonElement>("#filters button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter))
  );
  $("dealsBar").hidden = (state.filter !== "deals" && state.filter !== "browse") || state.mode === "search";
  $("dealMin").hidden = state.filter !== "deals";
  $("searchHead").hidden = state.mode !== "search";
  $("sharedBanner").hidden = state.mode !== "shared";

  if (state.mode === "search") return renderSearch();
  if (state.filter === "deals") {
    void renderDeals();
    return;
  }
  if (state.filter === "browse") {
    void renderBrowse();
    return;
  }

  const shared = state.mode === "shared";
  const all = shared ? (state.shared?.products ?? []) : state.products;
  const shown = visible(all);

  $("heading").textContent = shared ? "Shared list" : "Prices";
  $("subtitle").textContent = all.length
    ? `${all.length} product${all.length === 1 ? "" : "s"} · ${all.filter(isDropped).length} dropped · ${all.filter(isHit).length} below target${shared ? "" : ` · ${all.filter((p) => p.bought_at).length} bought`}`
    : shared ? "This list is empty." : "Products you've set alerts on. Paste any product link to see its full price history, or type a name to search.";

  const noneAtAll = all.length === 0;
  $("skeleton").hidden = state.loaded || shared;
  setEmpty(state.loaded && shown.length === 0,
    noneAtAll ? "No products yet" : "Nothing here",
    noneAtAll
      ? "Set an alert on any product (Browse, search, or paste a link) and it shows up here. Every product's history is public either way."
      : "No product on your list matches this filter.",
    noneAtAll && !shared);
  $("products").replaceChildren(...shown.map((p) => card(p, shared)));
}

// ---------- search mode (name instead of a link) ----------

async function runSearch(query: string): Promise<void> {
  state.mode = "search";
  state.search = { query, hits: [], blocked: [], loading: true };
  render();
  try {
    const data = await api<CompareResponse>(`/api/compare?q=${encodeURIComponent(query)}`);
    if (state.search.query !== query) return;
    state.search = { query, hits: data.hits, blocked: data.blocked, loading: false };
  } catch (err) {
    if (state.search.query !== query) return;
    state.search = { query, hits: [], blocked: ["flipkart.com"], loading: false };
    toast((err as Error).message, "error");
  }
  render();
}

function renderSearch(): void {
  const s = state.search;
  $("skeleton").hidden = !s.loading;
  $("heading").textContent = "Search";
  $("subtitle").textContent = "Tap a result to see its full price history, or paste a link from any store.";
  $("searchTitle").textContent = s.loading ? `Searching for “${s.query}”…` : `Results for “${s.query}”`;
  $("searchLinks").replaceChildren(...storeLinks(s.query));
  setEmpty(!s.loading && s.hits.length === 0, "No results",
    s.blocked.includes("flipkart.com") ? "Flipkart didn't answer just now. Try again, or use the store links above." : "Try fewer or different words.");
  $("products").replaceChildren(...s.hits.map(hitCard));
}

function storeLinks(q: string): HTMLAnchorElement[] {
  return STORE_SEARCH.map(([name, make]) => {
    const a = el("a", undefined, `${name} ↗`);
    a.href = make(q);
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  });
}

function hitCard(h: CompareHit): HTMLElement {
  const c = el("article", "card result clickable");
  c.append(cardTop(h.image, h.title, h.url, h.store));
  const row = el("div", "price-row");
  row.append(el("span", "price", money(h.price, h.currency || "INR")));
  const foot = el("div", "card-foot");
  const open = pill("history", "Price history");
  open.addEventListener("click", (e) => { e.stopPropagation(); void openProduct(h.url); });
  foot.append(el("span", "spacer"), open);
  c.append(row, foot);
  c.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("a")) void openProduct(h.url); });
  return c;
}

$("searchClose").addEventListener("click", () => {
  state.mode = state.shared ? "shared" : "list";
  $<HTMLInputElement>("url").value = "";
  render();
});

// Voice search (Chrome, Safari, Edge). The button hides where it isn't supported.
type Recognition = { lang: string; start(): void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onerror: () => void; onend: () => void };
const SpeechCtor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition });
const RecognitionImpl = SpeechCtor.SpeechRecognition || SpeechCtor.webkitSpeechRecognition;
if (!RecognitionImpl) $("voice").hidden = true;
$("voice").addEventListener("click", () => {
  if (!RecognitionImpl) return;
  const r = new RecognitionImpl();
  r.lang = navigator.language || "en-IN";
  $("voice").classList.add("listening");
  r.onresult = (e) => {
    const text = e.results[0][0].transcript;
    $<HTMLInputElement>("url").value = text;
    $<HTMLFormElement>("add").requestSubmit();
  };
  r.onerror = () => toast("Didn't catch that. Try again.", "error");
  r.onend = () => $("voice").classList.remove("listening");
  r.start();
});

// ---------- browse: the auto-discovered catalog ----------

function categoryChips(titles: string[]): void {
  const cats = new Map<string, number>();
  for (const t of titles) cats.set(categoryOf(t), (cats.get(categoryOf(t)) ?? 0) + 1);
  if (!cats.has(state.dealCat) && state.dealCat !== "all") state.dealCat = "all";
  const chips = $("dealCats");
  chips.replaceChildren(...[["all", "All"], ...[...cats.keys()].sort().map((c) => [c, c])].map(([key, label]) => {
    const b = el("button", undefined, label === "All" ? `All · ${titles.length}` : `${label} · ${cats.get(key)}`);
    b.setAttribute("aria-pressed", String(state.dealCat === key));
    b.addEventListener("click", () => { state.dealCat = key; render(); });
    return b;
  }));
}

async function renderBrowse(): Promise<void> {
  $("heading").textContent = "Browse";
  $("subtitle").textContent = "Every product on the site, with its full price history and deal score. Set an alert on any of them and it joins your list.";
  $("skeleton").hidden = !!state.catalog;
  if (!state.catalog) {
    $("products").replaceChildren();
    setEmpty(false);
    try {
      const data = await api<ListResponse>("/api/catalog");
      state.catalog = data.products;
    } catch (err) {
      toast(`Could not load the catalog: ${(err as Error).message}`, "error");
      state.catalog = [];
    }
    if (state.filter !== "browse" || state.mode === "search") return;
    $("skeleton").hidden = true;
  }
  categoryChips(state.catalog.map((p) => p.title));
  const q = state.query.toLowerCase();
  const list = visible(state.catalog.filter((p) => state.dealCat === "all" || categoryOf(p.title) === state.dealCat))
    .filter((p) => !q || `${p.title} ${p.store}`.toLowerCase().includes(q));
  setEmpty(list.length === 0, state.catalog.length ? "Nothing here" : "The catalog is filling up",
    state.catalog.length ? "Try another category." : "New products are discovered every 15 minutes. Check back soon, or search for one above.");
  $("products").replaceChildren(...list.map((p) => card(p, true)));
}

// ---------- deals feed ----------

async function renderDeals(): Promise<void> {
  $("heading").textContent = "Deals";
  $("subtitle").textContent = "Biggest price drops in the last 7 days, across everything people track here.";
  $("skeleton").hidden = !!state.deals;
  if (!state.deals) {
    $("products").replaceChildren();
    setEmpty(false);
    try {
      const data = await api<DealsResponse>("/api/deals");
      state.deals = data.deals;
    } catch (err) {
      toast(`Could not load deals: ${(err as Error).message}`, "error");
      state.deals = [];
    }
    if (state.filter !== "deals" || state.mode === "search") return;
    $("skeleton").hidden = true;
  }

  // Category chips from what's actually on offer.
  categoryChips(state.deals.map((d) => d.title));

  const q = state.query.toLowerCase();
  const list = state.deals.filter((d) =>
    (!q || `${d.title} ${d.store}`.toLowerCase().includes(q)) &&
    (state.dealCat === "all" || categoryOf(d.title) === state.dealCat) &&
    d.drop_pct >= state.dealMin
  );
  setEmpty(list.length === 0, "No deals here",
    state.deals.length ? "Try another category or a smaller discount." : "Deals show up here when a tracked product's price falls. Check back after a few checks.");
  $("products").replaceChildren(...list.map(dealCard));
}

$<HTMLSelectElement>("dealMin").addEventListener("change", (e) => {
  state.dealMin = Number((e.target as HTMLSelectElement).value) || 0;
  render();
});

function cardTop(image: string | null, title: string, url: string, store: string): HTMLElement {
  const top = el("div", "card-top");
  const frame = el("div", "photo");
  if (image) {
    const img = el("img");
    img.src = image;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    frame.append(img);
  }
  const info = el("div", "info");
  const a = el("a", "title", title);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  info.append(a, el("div", "store", store));
  top.append(frame, info);
  return top;
}

function dealCard(d: Deal): HTMLElement {
  const c = el("article", "card deal");
  c.append(cardTop(d.image, d.title, d.url, d.store));

  const row = el("div", "price-row");
  row.append(
    el("span", "price", money(d.price, d.currency)),
    el("span", "was", money(d.was, d.currency)),
    el("span", "drop-big", `−${d.drop_pct}%`)
  );
  if (d.list_price) row.append(el("span", "chip off", `${Math.round((1 - d.price / d.list_price) * 100)}% off MRP`));
  row.append(el("span", "chip cat", categoryOf(d.title)));

  const foot = el("div", "card-foot");
  const stamp = el("span", "muted", `Dropped ${ago(d.checked_at)}`);
  const open = pill("history", "Price history");
  open.addEventListener("click", (e) => { e.stopPropagation(); void openProduct(d.url); });
  foot.append(stamp, el("span", "spacer"), open);
  c.append(row, foot);
  c.classList.add("clickable");
  c.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("a")) void openProduct(d.url); });
  return c;
}

// Any product link, from anywhere: open its site-wide history. New links join
// the public catalog on the server; nothing goes on the person's list.
let opening = false;
async function openProduct(url: string): Promise<void> {
  if (opening) return;
  opening = true;
  toast("Opening the product…", "info");
  try {
    const r = await api<OpenResponse>("/api/open", { method: "POST", body: JSON.stringify({ url }) });
    openHistory(r.product, true, r.pending);
    $("toast").classList.remove("show");
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    opening = false;
  }
}

// ---------- product card ----------

function card(p: Product, readOnly = false): HTMLElement {
  const c = el("article", "card");
  if (isHit(p)) c.classList.add("hit");
  if (p.bought_at) c.classList.add("bought");
  c.append(cardTop(p.image, p.title, p.url, p.store));

  // Price, change since first check, badges
  const row = el("div", "price-row");
  row.append(el("span", "price", money(p.price, p.currency)));
  if (p.first != null && p.price != null && p.price !== p.first) {
    const diff = p.price - p.first;
    const pct = Math.abs(Math.round((diff / p.first) * 100));
    const chip = el("span", `chip ${diff < 0 ? "down" : "up"}`,
      `${diff < 0 ? "▼" : "▲"} ${money(Math.abs(diff), p.currency)} · ${pct}%`);
    chip.title = "Since you started tracking";
    row.append(chip);
  }
  if (isHit(p)) row.append(el("span", "chip hit", "Below target"));
  const ds = dealScore(p);
  if (ds.score != null) {
    const chip = el("span", `chip score ${ds.kind}`, `${ds.label} · ${ds.score}`);
    chip.title = "Deal score out of 100. Open History for the breakup.";
    row.append(chip);
  } else if (p.history.length > 2 && p.price != null && p.price === p.lowest) {
    row.append(el("span", "chip low", "Lowest yet"));
  }
  if (p.list_price && p.price != null && !inflatedList(p)) {
    const off = el("span", "chip off");
    off.append(el("s", undefined, money(p.list_price, p.currency)), ` ${Math.round((1 - p.price / p.list_price) * 100)}% off`);
    row.append(off);
  }
  if (p.availability === "out_of_stock") row.append(el("span", "chip stock out", "Out of stock"));
  else if (p.availability === "preorder") row.append(el("span", "chip stock", "Pre-order"));
  if (p.bought_at) {
    row.append(el("span", "chip bought", `Bought ${money(p.bought_price, p.currency)} · ${dateShort(p.bought_at)}`));
  }

  const stats = el("div", "stats");
  const stat = (label: string, value: string) => {
    const s = el("span");
    s.append(el("span", "k", label), el("span", "v", value));
    return s;
  };
  const spansDays = p.history.length > 1 && p.history[p.history.length - 1][0] - p.history[0][0] > DAY;
  stats.append(
    stat("Low", money(p.lowest, p.currency)),
    stat("High", money(p.highest, p.currency)),
    stat("Avg", money(tidy(p, p.average), p.currency)),
    spansDays ? stat("Since", dateShort(p.history[0][0]) + (new Date(p.history[0][0]).getFullYear() !== new Date().getFullYear() ? ` ${new Date(p.history[0][0]).getFullYear()}` : ""))
      : stat("Checked", ago(p.checked_at))
  );

  c.append(row, chart(p, 72), stats);
  if (p.error) c.append(el("p", "err", `Last check failed: ${p.error}`));

  const foot = el("div", "card-foot");
  if (readOnly) {
    // Browse and shared lists: set an alert straight away; that follows the
    // product for you. No "track" step first.
    const mineRow = state.products.find((x) => x.url === p.url);
    const label = el("label", "target");
    label.append(el("span", undefined, "Alert below"));
    const target = el("input");
    target.type = "number";
    target.min = "0";
    target.step = "any";
    target.inputMode = "decimal";
    target.placeholder = mineRow ? "any" : "price";
    target.value = mineRow?.target == null ? "" : String(mineRow.target);
    target.addEventListener("change", () => alertFromBrowse(p, target.value));
    label.append(target);

    const history = pill("history", "History");
    history.addEventListener("click", () => openHistory(p, true));
    foot.append(label, history);
    if (mineRow) foot.append(el("span", "chip bought", "On my list"));
    c.append(foot);
    // Catalog and shared products are read-only here, but their history is real.
    c.classList.add("readonly");
    return c;
  }

  // Target price, history, check now, bought, remove
  const label = el("label", "target");
  label.append(el("span", undefined, "Alert below"));
  const target = el("input");
  target.type = "number";
  target.min = "0";
  target.step = "any";
  target.inputMode = "decimal";
  target.placeholder = "any";
  target.value = p.target == null ? "" : String(p.target);
  target.addEventListener("change", () => setTarget(p, target.value));
  label.append(target);

  const history = pill("history", "History");
  history.addEventListener("click", () => openHistory(p));
  const check = pill("refresh-cw", "Check");
  check.title = "Check the price now";
  check.addEventListener("click", () => checkNow(p, check));
  const bought = pill(p.bought_at ? "undo-2" : "shopping-bag", p.bought_at ? "Not bought" : "Bought");
  bought.title = p.bought_at ? "Clear the purchase" : "Mark as bought and add it to your Spend";
  bought.addEventListener("click", () => markBought(p));
  const remove = pill("trash-2", "Remove", "pill danger");
  remove.addEventListener("click", () => removeProduct(p));
  foot.append(label, history, check, bought, remove);
  c.append(foot);
  return c;
}

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

// A smooth curve through the points. Monotone cubic tangents (Fritsch–Carlson)
// keep it from overshooting, so the curve never shows a price the data
// doesn't contain between two real points.
function smoothPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n < 2) return n ? `M ${pts[0][0]} ${pts[0][1]}` : "";
  const dx: number[] = [], dy: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0] || 1e-6);
    dy.push(pts[i + 1][1] - pts[i][1]);
    m.push(dy[i] / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C ${(pts[i][0] + h).toFixed(1)} ${(pts[i][1] + t[i] * h).toFixed(1)}, ${(pts[i + 1][0] - h).toFixed(1)} ${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)}, ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

function chart(p: Product, height: number): SVGElement {
  const W = 300, H = height, PAD = 4;
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img" });
  svg.style.height = `${H}px`;
  const h = p.history;
  svg.setAttribute("aria-label", `Price history, ${h.length} checks`);
  if (h.length < 2) {
    svg.classList.add("flat");
    svg.append(svgEl("line", { class: "line", x1: 0, x2: W, y1: H / 2, y2: H / 2 }));
    return svg;
  }

  const values = h.map((x) => x[1]);
  if (p.target != null) values.push(p.target);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi += 1; lo -= 1; }
  const t0 = h[0][0];
  const span = (h[h.length - 1][0] - t0) || 1;
  const x = (t: number) => PAD + ((t - t0) / span) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2);

  const d = smoothPath(h.map(([t, v]) => [x(t), y(v)]));
  const gid = `g${p.id}-${H}`;

  const defs = svgEl("defs", {});
  const grad = svgEl("linearGradient", { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 });
  grad.append(svgEl("stop", { offset: "0%", class: "stop-a" }), svgEl("stop", { offset: "100%", class: "stop-b" }));
  defs.append(grad);

  const last = h[h.length - 1];
  svg.append(
    defs,
    svgEl("path", { class: "area", d: `${d} L ${x(last[0]).toFixed(1)} ${H} L ${x(t0).toFixed(1)} ${H} Z`, fill: `url(#${gid})` }),
    svgEl("path", { class: "line", d }),
  );
  if (p.target != null) {
    svg.append(svgEl("line", { class: "target", x1: 0, x2: W, y1: y(p.target), y2: y(p.target) }));
  }
  svg.append(svgEl("circle", { class: "dot", cx: x(last[0]), cy: y(last[1]), r: 3.5 }));
  return svg;
}

// ---------- deal score gauge ----------

function gauge(ds: DealScore): SVGElement {
  const W = 120, H = 70, cx = 60, cy = 62, r = 48;
  const svg = svgEl("svg", { class: "gauge-svg", viewBox: `0 0 ${W} ${H}`, role: "img" });
  svg.setAttribute("aria-label", ds.score == null ? "No deal score yet" : `Deal score ${ds.score} out of 100`);
  const arc = (from: number, to: number, cls: string) => {
    // 0..1 along the half circle, left to right
    const a0 = Math.PI * (1 - from), a1 = Math.PI * (1 - to);
    const x0 = cx + r * Math.cos(a0), y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    return svgEl("path", { class: `seg ${cls}`, d: `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}` });
  };
  svg.append(arc(0, 0.25, "s-bad"), arc(0.25, 0.5, "s-meh"), arc(0.5, 0.75, "s-good"), arc(0.75, 1, "s-great"));
  const v = ds.score == null ? 0.5 : ds.score / 100;
  const a = Math.PI * (1 - v);
  const nx = cx + (r - 10) * Math.cos(a), ny = cy - (r - 10) * Math.sin(a);
  svg.append(
    svgEl("line", { class: `needle ${ds.score == null ? "none" : ""}`, x1: cx, y1: cy, x2: nx.toFixed(1), y2: ny.toFixed(1) }),
    svgEl("circle", { class: "hub", cx, cy, r: 4 })
  );
  const t = svgEl("text", { class: "score-num", x: cx, y: cy - 14, "text-anchor": "middle" });
  t.textContent = ds.score == null ? "–" : String(ds.score);
  svg.append(t);
  return svg;
}

// ---------- history sheet with timeline ----------

const DAY = 86400000;
let sheetProduct: Product | null = null;
let sheetRange = 0; // days; 0 = all

function rangeHistory(p: Product, days: number): PricePoint[] {
  if (!days) return p.history;
  const from = Date.now() - days * DAY;
  const inRange = p.history.filter(([t]) => t >= from);
  // Keep the last point before the range so the line starts at the edge.
  const before = p.history.filter(([t]) => t < from).pop();
  return before ? [[from, before[1]], ...inRange] : inRange;
}

// Big chart: date axis, grid, lowest/highest markers, hover or touch readout.
// The x-axis is the chosen window (last week, month, …) ending today; "All"
// runs from the earliest real price to today. Data sits wherever it falls.
function timeline(p: Product, h: PricePoint[], rangeDays = 0): SVGElement {
  const W = 600, H = 200, L = 8, R = 8, T = 22, B = 24;
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img" });
  svg.style.height = `${H}px`;
  svg.setAttribute("aria-label", `Price timeline, ${h.length} checks`);
  const readout = $("hReadout");
  readout.textContent = "";
  if (!h.length) {
    svg.classList.add("flat");
    svg.append(svgEl("line", { class: "line", x1: 0, x2: W, y1: H / 2, y2: H / 2 }));
    readout.textContent = "No prices in this range.";
    return svg;
  }
  if (h.length === 1) readout.textContent = "One price so far; the line grows with every check.";

  const values = h.map((x) => x[1]);
  if (p.target != null) values.push(p.target);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi *= 1.05; lo *= 0.95; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const now = Date.now();
  const t0 = rangeDays ? now - rangeDays * DAY : Math.min(h[0][0], now - 7 * DAY);
  const t1 = Math.max(now, h[h.length - 1][0]);
  const span = (t1 - t0) || 1;
  const x = (t: number) => L + ((t - t0) / span) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // Grid and axis labels
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    svg.append(svgEl("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const label = svgEl("text", { class: "axis", x: W - R, y: y(v) - 3, "text-anchor": "end" });
    label.textContent = money(Math.round(v), p.currency);
    svg.append(label);
  }
  const ticks = Math.min(5, Math.max(2, Math.round(span / DAY) + 1));
  const longSpan = span > 300 * DAY;
  for (let i = 0; i < ticks; i++) {
    const t = t0 + (span * i) / (ticks - 1);
    const label = svgEl("text", {
      class: "axis", x: x(t), y: H - 6,
      "text-anchor": i === 0 ? "start" : i === ticks - 1 ? "end" : "middle",
    });
    label.textContent = span > 2 * DAY
      ? (longSpan ? new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : dateShort(t))
      : when(t);
    svg.append(label);
  }

  // Line and area, over the dates that have data
  const first = h[0][0], last = h[h.length - 1][0];
  if (h.length >= 2) {
    const d = smoothPath(h.map(([t, v]) => [x(t), y(v)]));
    const gid = `tl${p.id}`;
    const defs = svgEl("defs", {});
    const grad = svgEl("linearGradient", { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 });
    grad.append(svgEl("stop", { offset: "0%", class: "stop-a" }), svgEl("stop", { offset: "100%", class: "stop-b" }));
    defs.append(grad);
    svg.append(
      defs,
      svgEl("path", { class: "area", d: `${d} L ${x(last).toFixed(1)} ${H - B} L ${x(first).toFixed(1)} ${H - B} Z`, fill: `url(#${gid})` }),
      svgEl("path", { class: "line", d }),
    );
  }
  // The price holds from the last check until now: a faint continuation.
  if (now - last > 60 * 60 * 1000 || h.length === 1) {
    svg.append(svgEl("line", { class: "hold", x1: x(last), x2: x(Math.max(now, last)), y1: y(h[h.length - 1][1]), y2: y(h[h.length - 1][1]) }));
  }
  if (p.target != null) {
    svg.append(svgEl("line", { class: "target", x1: L, x2: W - R, y1: y(p.target), y2: y(p.target) }));
  }

  // Lowest and highest markers (first time each was reached)
  const lowIdx = h.findIndex(([, v]) => v === Math.min(...h.map((q) => q[1])));
  const highIdx = h.findIndex(([, v]) => v === Math.max(...h.map((q) => q[1])));
  for (const [idx, cls] of [[highIdx, "hi"], [lowIdx, "lo"]] as const) {
    if (idx < 0 || (h.length === 1 && cls === "hi")) continue;
    const [t, v] = h[idx];
    svg.append(svgEl("circle", { class: `mark ${cls}`, cx: x(t), cy: y(v), r: 4 }));
    const left = x(t) > W * 0.7;
    const label = svgEl("text", {
      class: `label ${cls}`, x: x(t) + (left ? -8 : 8), y: y(v) + (cls === "lo" ? 14 : -8),
      "text-anchor": left ? "end" : "start",
    });
    label.textContent = `${cls === "lo" ? "Low" : "High"} ${money(v, p.currency)} · ${dateShort(t)}`;
    svg.append(label);
  }

  // Hover / touch readout
  const cursor = svgEl("line", { class: "cursor", x1: 0, x2: 0, y1: T, y2: H - B, visibility: "hidden" });
  const dot = svgEl("circle", { class: "dot", cx: 0, cy: 0, r: 4, visibility: "hidden" });
  svg.append(cursor, dot);
  const show = (clientX: number) => {
    const rect = svg.getBoundingClientRect();
    const t = t0 + ((clientX - rect.left) / rect.width) * span;
    let i = h.findIndex(([tt]) => tt > t);
    i = i < 0 ? h.length - 1 : Math.max(0, i - 1);
    if (t < first) i = 0;
    const [tt, v] = h[i];
    cursor.setAttribute("x1", String(x(tt)));
    cursor.setAttribute("x2", String(x(tt)));
    dot.setAttribute("cx", String(x(tt)));
    dot.setAttribute("cy", String(y(v)));
    cursor.setAttribute("visibility", "visible");
    dot.setAttribute("visibility", "visible");
    readout.replaceChildren(el("b", undefined, money(v, p.currency)), document.createTextNode(` · ${when(tt)}`));
  };
  const hide = () => {
    cursor.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    readout.textContent = "";
  };
  svg.addEventListener("pointermove", (e) => show(e.clientX));
  svg.addEventListener("pointerdown", (e) => show(e.clientX));
  svg.addEventListener("pointerleave", hide);
  return svg;
}

function renderHistoryChart(): void {
  const p = sheetProduct;
  if (!p) return;
  const h = rangeHistory(p, sheetRange);
  $("hChart").replaceChildren(timeline(p, h, sheetRange));
  document.querySelectorAll<HTMLButtonElement>("#hRange button").forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.range) === sheetRange))
  );

  const lowLine = $("hLow");
  lowLine.replaceChildren();
  if (h.length) {
    const minV = Math.min(...h.map((q) => q[1]));
    const low = h.find(([, v]) => v === minV) as PricePoint;
    const since = dateLong(p.history[0][0]);
    lowLine.append(
      "Lowest ", el("b", "lo", money(low[1], p.currency)), ` on ${dateLong(low[0])}`,
      el("span", "muted", ` · history since ${since}`)
    );
  }
}

document.querySelectorAll<HTMLButtonElement>("#hRange button").forEach((b) =>
  b.addEventListener("click", () => {
    sheetRange = Number(b.dataset.range) || 0;
    renderHistoryChart();
  })
);

// ---------- compare across stores / related ----------

const STORE_SEARCH: Array<[string, (q: string) => string]> = [
  ["Amazon.in", (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`],
  ["Flipkart", (q) => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`],
  ["Croma", (q) => `https://www.croma.com/searchB?q=${encodeURIComponent(q)}`],
  ["Reliance Digital", (q) => `https://www.reliancedigital.in/products?q=${encodeURIComponent(q)}`],
  ["Vijay Sales", (q) => `https://www.vijaysales.com/search/${encodeURIComponent(q)}`],
  ["Tata CLiQ", (q) => `https://www.tatacliq.com/search/?searchCategory=all&text=${encodeURIComponent(q)}`],
];

// "Apple MacBook Pro (M5 Pro, 2026) M5 Pro - (24 GB/1 TB SSD/Tahoe) MGEA4HN/A" -> short search words
function searchWords(title: string): string {
  return title
    .replace(/\|.*$/, "")
    .replace(/[()[\]{}\-–—,/]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(with|and|the|for|of|a|an|in|by)$/i.test(w))
    .slice(0, 8)
    .join(" ");
}

function hitRow(h: { title: string; url: string; store: string; image: string | null; price: number | null; currency: string | null }, compareTo: number | null): HTMLElement {
  const row = el("div", "hit");
  const img = el("img");
  img.src = h.image || "";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => img.remove();
  const mid = el("div");
  const t = el("a", "t", h.title);
  t.href = h.url;
  t.target = "_blank";
  t.rel = "noopener";
  mid.append(t, el("div", "s", h.store));
  const right = el("div", "hit-right");
  const cheaper = h.price != null && compareTo != null && h.price < compareTo;
  right.append(el("span", `p ${cheaper ? "cheaper" : ""}`, money(h.price, h.currency || "INR")));
  const open = pill("history", "History");
  open.addEventListener("click", () => void openProduct(h.url));
  right.append(open);
  row.append(img, mid, right);
  return row;
}

async function loadRelated(p: Product): Promise<void> {
  const q = searchWords(p.title);
  $("hCompareLinks").replaceChildren(...storeLinks(q));
  const hits = $("hCompareHits");
  hits.replaceChildren(el("p", "muted", "Looking on Flipkart…"));
  try {
    const data = await api<CompareResponse>(`/api/compare?q=${encodeURIComponent(q)}`);
    if (sheetProduct !== p) return;
    hits.replaceChildren();
    const found = data.hits.filter((h) => h.url !== p.url);
    if (!found.length) {
      hits.append(el("p", "muted", data.blocked.includes("flipkart.com")
        ? "Flipkart didn't answer just now. Use the store links above."
        : "No close matches found. Use the store links above."));
    }
    for (const h of found) hits.append(hitRow(h, p.price));
  } catch (err) {
    hits.replaceChildren(el("p", "muted", `Couldn't look up other stores: ${(err as Error).message}`));
  }
}

async function loadCategoryDeals(p: Product): Promise<void> {
  const box = $("hCatDeals");
  box.hidden = true;
  if (!state.deals) {
    try { state.deals = (await api<DealsResponse>("/api/deals")).deals; } catch { state.deals = []; }
  }
  if (sheetProduct !== p) return;
  const cat = categoryOf(p.title);
  const list = state.deals.filter((d) => d.url !== p.url && categoryOf(d.title) === cat).slice(0, 6);
  if (!list.length) return;
  (box.querySelector("h3") as HTMLElement).textContent = `Deals in ${cat === "Other" ? "this category" : cat}`;
  $("hCatList").replaceChildren(...list.map((d) =>
    hitRow({ title: d.title, url: d.url, store: `${d.store} · −${d.drop_pct}%`, image: d.image, price: d.price, currency: d.currency }, null)
  ));
  box.hidden = false;
}

function openHistory(p: Product, readOnly = false, pending = false): void {
  fillHistory(p, readOnly);
  $<HTMLDialogElement>("historySheet").showModal();
  $<HTMLDialogElement>("historySheet").scrollTop = 0;
  void loadRelated(p);
  void loadCategoryDeals(p);
  void loadArchive(p, readOnly, pending);
}

// Re-read the product (site-wide history plus the person's own alert) and redraw.
async function refreshSheet(p: Product, readOnly: boolean): Promise<Product | null> {
  try {
    const r = await api<OpenResponse>("/api/open", { method: "POST", body: JSON.stringify({ url: p.url }) });
    if (sheetProduct !== p) return null;
    sheetProduct = r.product;
    fillHistory(r.product, readOnly);
    return r.product;
  } catch {
    return null;
  }
}

// Older prices from the Wayback Machine: already there, running in the
// background (a product just opened or added), or fetched now.
async function loadArchive(p: Product, readOnly: boolean, pending = false): Promise<void> {
  const note = $("hArchive");
  const describe = (q: Product) => {
    note.hidden = false;
    note.textContent = q.archived
      ? `${q.archived} of these prices come from Internet Archive snapshots of the product page; history since ${dateLong(q.history[0][0])}.`
      : "No readable past prices in the Internet Archive for this page; history grows with every check from here on.";
  };
  if (p.backfilled_at && !pending) return describe(p);

  note.hidden = false;
  note.textContent = "Looking for older prices in the Internet Archive…";
  try {
    if (!pending) {
      const r = await api<BackfillResponse & { cached?: boolean; pending?: boolean }>("/api/backfill", { method: "POST", body: JSON.stringify({ url: p.url }) });
      if (sheetProduct !== p) return;
      if (!r.ok) { note.textContent = "The Internet Archive didn't answer; older prices will be added later."; return; }
      pending = !!r.pending;
    }
    // Give a background lookup time to land, then redraw with what it found.
    if (pending) await new Promise((res) => setTimeout(res, 15000));
    if (sheetProduct !== p) return;
    const fresh = await refreshSheet(p, readOnly);
    if (fresh) {
      describe(fresh);
      if (!readOnly) await load();
    }
  } catch (err) {
    note.textContent = `Couldn't look up older prices: ${(err as Error).message}`;
  }
}

function fillHistory(p: Product, readOnly: boolean): void {
  sheetProduct = p;
  $("hTitle").textContent = p.title;
  const since = p.history.length ? ` · since ${dateLong(p.history[0][0])}` : "";
  $("hMeta").textContent = `${p.store} · ${p.history.length} price point${p.history.length === 1 ? "" : "s"}${since} · low ${money(p.lowest, p.currency)} · high ${money(p.highest, p.currency)} · avg ${money(tidy(p, p.average), p.currency)}`;

  // Alert straight from the sheet: this is how a product gets on "Mine".
  const mineRow = state.products.find((x) => x.url === p.url);
  const target = $<HTMLInputElement>("hTarget");
  const current = mineRow?.target ?? p.target ?? null;
  target.value = current == null ? "" : String(current);
  target.onchange = () => alertFromBrowse(p, target.value);
  $("hAlertNote").textContent = current != null
    ? `You'll be alerted at or below ${money(current, p.currency)}.`
    : mineRow ? "On your list; you'll be told about any drop." : "Set a price and this product joins your list.";

  // Deal score
  const ds = dealScore(p);
  $("hGauge").replaceChildren(gauge(ds));
  const label = $("hScoreLabel");
  label.textContent = ds.label;
  label.dataset.kind = ds.kind;
  $("hScoreWhy").textContent = ds.score == null
    ? "The score needs at least 3 price checks. It builds up over the next day."
    : ds.pump ? "The price went up shortly before this \"drop\", so the saving is smaller than it looks."
    : ds.score >= 75 ? "Close to the best price seen here, with no tricks spotted."
    : ds.score >= 50 ? "A fair price, but it has been lower."
    : "Well above the lows seen here. Waiting is likely to pay off.";
  const body = $("hBreakup").querySelector("tbody") as HTMLTableSectionElement;
  body.replaceChildren(...ds.lines.map((l) => {
    const tr = el("tr");
    tr.append(el("td", undefined, l.label), el("td", "muted-cell", l.detail), el("td", `num ${l.points ? "up" : ""}`, l.points ? `−${l.points}` : "0"));
    return tr;
  }));

  // Plain verdict
  const v = verdict(p);
  const box = $("hVerdict");
  box.dataset.kind = v.kind;
  box.replaceChildren(el("b", undefined, v.label), el("span", "why", v.why));
  if (inflatedList(p)) {
    box.append(el("span", "why", `The listed MRP of ${money(p.list_price, p.currency)} is far above any price seen here, so the "% off" is mostly marketing.`));
  }

  renderHistoryChart();
  $<HTMLAnchorElement>("hOpen").href = p.url;
  const shareText = `${p.title} — ${money(p.price, p.currency)} on ${p.store}`;
  $<HTMLAnchorElement>("hWhatsApp").href = `https://wa.me/?text=${encodeURIComponent(`${shareText}\n${p.url}`)}`;
  $("hShare").hidden = !("share" in navigator);
  $("hShare").onclick = () => navigator.share({ title: p.title, text: shareText, url: p.url }).catch(() => {});
  $("hCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(p.url); toast("Link copied", "success"); } catch { toast("Couldn't copy", "error"); }
  };
  const csv = $<HTMLAnchorElement>("hCsv");
  csv.href = `/api/products/${p.id}/history.csv`;
  csv.hidden = readOnly;

  // Every check
  const tbody = $("hTable").querySelector("tbody") as HTMLTableSectionElement;
  tbody.replaceChildren();
  const rows: PricePoint[] = [...p.history].reverse();
  rows.forEach(([t, val], i) => {
    const prev = rows[i + 1];
    const tr = el("tr");
    tr.append(el("td", undefined, when(t)));
    tr.append(el("td", "num", money(val, p.currency)));
    const diff = prev ? val - prev[1] : 0;
    tr.append(el("td", `num ${diff < 0 ? "down" : diff > 0 ? "up" : ""}`,
      prev && diff !== 0 ? `${diff < 0 ? "▼" : "▲"} ${money(Math.abs(diff), p.currency)}` : "–"));
    tbody.append(tr);
  });
}

// CSV download needs the owner header, which a plain link can't send.
$("hCsv").addEventListener("click", async (e) => {
  e.preventDefault();
  const a = e.currentTarget as HTMLAnchorElement;
  try {
    const res = await fetch(a.href, { headers: { "x-owner": ownerId() } });
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const tmp = el("a");
    tmp.href = url;
    tmp.download = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "history.csv";
    tmp.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    toast((err as Error).message, "error");
  }
});

// ---------- actions ----------

$<HTMLFormElement>("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $<HTMLButtonElement>("track");
  const input = $<HTMLInputElement>("url");
  const target = $<HTMLInputElement>("target");
  const value = input.value.trim();
  if (!value) return;

  // A product name rather than a link: search.
  if (!isUrl(value)) {
    void runSearch(value);
    return;
  }

  // A link: open its history. With a price in the alert box, also set the alert.
  button.disabled = true;
  button.textContent = "Reading…";
  try {
    const r = await api<OpenResponse>("/api/open", { method: "POST", body: JSON.stringify({ url: value }) });
    if (target.value) {
      await api("/api/products", { method: "POST", body: JSON.stringify({ url: r.product.url, target: Number(target.value) }) })
        .catch(async (err: Error) => {
          if (!/already/.test(err.message)) throw err;
          const mine = (await api<ListResponse>("/api/products")).products.find((x) => x.url === r.product.url);
          if (mine) await update(mine, { target: Number(target.value) });
        });
      await load();
      r.product.target = Number(target.value);
    }
    input.value = "";
    target.value = "";
    openHistory(r.product, true, r.pending);
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Open";
  }
});

$<HTMLInputElement>("url").addEventListener("input", (e) => {
  const v = (e.target as HTMLInputElement).value.trim();
  $("track").textContent = v && !isUrl(v) ? "Search" : "Open";
});

async function update(p: Product, body: UpdateRequest): Promise<void> {
  await api(`/api/products/${p.id}`, { method: "PATCH", body: JSON.stringify(body) });
}

// Setting an alert on a Browse or shared card follows the product for you.
async function alertFromBrowse(p: Product, value: string): Promise<void> {
  const target = value === "" ? null : Number(value);
  const mineRow = state.products.find((x) => x.url === p.url);
  try {
    if (mineRow) {
      await update(mineRow, { target });
    } else {
      if (target == null) return;
      await api("/api/products", { method: "POST", body: JSON.stringify({ url: p.url, target }) });
    }
    toast(target == null ? "Alert removed" : `Alert set at ${money(target, p.currency)}. It's on your list now.`, "success");
    await load();
    render();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}

async function setTarget(p: Product, value: string): Promise<void> {
  try {
    await update(p, { target: value === "" ? null : Number(value) });
    toast(value === "" ? "You'll be told about any drop" : `We'll flag it at or below ${money(Number(value), p.currency)}`, "success");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}

async function markBought(p: Product): Promise<void> {
  try {
    if (p.bought_at) {
      await update(p, { bought: null });
      toast("Purchase cleared", "info");
    } else {
      const answer = prompt(`What did you pay for it? (${p.currency || ""})`, p.price == null ? "" : String(p.price));
      if (answer == null) return;
      const price = Number(answer.replace(/[^\d.]/g, ""));
      if (!(price > 0)) { toast("Enter the price you paid", "error"); return; }
      await update(p, { bought: { price } });
      const saved = p.highest != null && p.highest > price ? ` You paid ${money(p.highest - price, p.currency)} less than its highest price.` : "";
      toast(`Marked as bought.${saved}`, "success");
    }
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}

async function checkNow(p: Product, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.replaceChildren(icon("refresh-cw", 14), " Checking…");
  try {
    const r = await api<CheckResponse>(`/api/products/${p.id}/check`, { method: "POST" });
    if (r.error) toast(`${p.title}: ${r.error}`, "error");
    else toast(r.cached ? "Checked a few minutes ago; showing that price." : "Price updated.", "success");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
    button.disabled = false;
    button.replaceChildren(icon("refresh-cw", 14), " Check");
  }
}

async function removeProduct(p: Product): Promise<void> {
  if (!confirm(`Stop tracking “${p.title}”? Its price history will be deleted.`)) return;
  try {
    await api(`/api/products/${p.id}`, { method: "DELETE" });
    toast("Removed", "info");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}

document.querySelectorAll<HTMLButtonElement>("#filters button").forEach((b) =>
  b.addEventListener("click", () => {
    state.filter = (b.dataset.filter as Filter) || "all";
    if (state.mode === "search") state.mode = state.shared ? "shared" : "list";
    if (state.filter === "deals") state.deals = null; // refresh each visit
    if (state.filter === "browse") state.catalog = null;
    render();
  })
);

$<HTMLInputElement>("search").addEventListener("input", (e) => {
  state.query = (e.target as HTMLInputElement).value.trim();
  render();
});
$<HTMLSelectElement>("sort").addEventListener("change", (e) => {
  state.sort = (e.target as HTMLSelectElement).value as Sort;
  store.set("sort", state.sort);
  render();
});

// Paste a link anywhere on the page to fill the box.
document.addEventListener("paste", (e) => {
  if ((e.target as HTMLElement).matches("input")) return;
  const text = e.clipboardData?.getData("text") || "";
  if (/^https?:\/\//.test(text.trim())) {
    $<HTMLInputElement>("url").value = text.trim();
    $<HTMLInputElement>("url").focus();
  }
});

// ---------- links in: share target, ?url=, ?list= ----------

async function handleQuery(): Promise<void> {
  const params = new URLSearchParams(location.search);

  // App shortcuts (Android launcher): /?tab=deals, /?tab=browse
  const tab = params.get("tab");
  if (tab === "deals" || tab === "browse") {
    history.replaceState(null, "", "/");
    state.filter = tab;
    render();
    return;
  }

  const list = params.get("list");
  if (list && /^[A-Za-z0-9_-]{16,64}$/.test(list)) {
    try {
      const data = await api<ListResponse>(`/api/shared/${list}`);
      state.shared = { token: list, products: data.products };
      state.mode = "shared";
      render();
    } catch (err) {
      toast((err as Error).message, "error");
    }
    return;
  }

  // The "Track price" bookmark: it read the page in the person's browser and
  // sends what it saw, for stores that turn the Worker away.
  const capture = params.get("capture");
  if (capture) {
    history.replaceState(null, "", "/");
    let snap: Snapshot & { url?: string };
    try { snap = JSON.parse(capture); } catch { toast("The bookmark sent something unreadable", "error"); return; }
    if (!snap.url || !isUrl(snap.url)) { toast("The bookmark didn't include the page link", "error"); return; }
    toast(`Saving ${snap.title ? `“${snap.title.slice(0, 40)}”` : "the product"}…`, "info");
    try {
      const r = await api<{ ok: boolean; price: number; currency: string | null; updated?: boolean }>("/api/products", {
        method: "POST",
        body: JSON.stringify({ url: snap.url, snapshot: snap.price ? snap : undefined }),
      });
      toast(r.updated ? `Price updated: ${money(r.price, r.currency)}` : `Tracking it at ${money(r.price, r.currency)}`, "success");
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
    return;
  }

  // Shared to the app (Web Share Target), the /https://... prefix.
  const text = [params.get("url"), params.get("text"), params.get("title")].filter(Boolean).join(" ");
  const link = /https?:\/\/\S+/.exec(text || "")?.[0];
  if (!link) return;
  history.replaceState(null, "", "/");
  void openProduct(link);
}

// ---------- sheets ----------

document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) =>
  b.addEventListener("click", () => (b.closest("dialog") as HTMLDialogElement).close())
);
// Tap outside the sheet to close it.
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) =>
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); })
);

function renderSpend(): void {
  const bought = state.products.filter((p) => p.bought_at && p.bought_price != null);
  const box = $("spend");
  box.replaceChildren();
  if (!bought.length) {
    box.append(el("p", "muted", "Nothing bought yet."));
    return;
  }
  const currency = bought[0].currency;
  const paid = bought.reduce((s, p) => s + (p.bought_price as number), 0);
  const vsHigh = bought.reduce((s, p) => s + Math.max(0, (p.highest ?? 0) - (p.bought_price as number)), 0);
  const vsList = bought.reduce((s, p) => s + Math.max(0, (p.list_price ?? 0) - (p.bought_price as number)), 0);
  const tile = (k: string, v: string) => {
    const d = el("div", "tile");
    d.append(el("div", "k", k), el("div", "v", v));
    return d;
  };
  const tiles = el("div", "tiles");
  tiles.append(
    tile("Bought", `${bought.length} item${bought.length === 1 ? "" : "s"}`),
    tile("Paid", money(paid, currency)),
    tile("Saved vs highest seen", money(vsHigh, currency)),
    tile("Saved vs MRP", vsList ? money(vsList, currency) : "—"),
  );
  box.append(tiles);
  const byStore = new Map<string, number>();
  for (const p of bought) byStore.set(p.store, (byStore.get(p.store) ?? 0) + (p.bought_price as number));
  const ul = el("ul", "spend-list");
  for (const [storeName, sum] of [...byStore.entries()].sort((a, b) => b[1] - a[1])) {
    const li = el("li");
    li.append(el("span", undefined, storeName), el("b", undefined, money(sum, currency)));
    ul.append(li);
  }
  box.append(ul);
}

$("settingsBtn").addEventListener("click", () => {
  $("syncCode").textContent = ownerId();
  renderSpend();
  $<HTMLDialogElement>("settingsSheet").showModal();
});
$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ownerId());
    toast("Sync code copied", "success");
  } catch {
    toast("Couldn't copy; select the code and copy it by hand", "error");
  }
});
$<HTMLFormElement>("syncForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>("syncInput").value.trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
    toast("That doesn't look like a sync code", "error");
    return;
  }
  store.set("owner", code);
  location.href = "/";
});

$("makeShare").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("makeShare");
  const code = $("shareLink");
  if (code.dataset.url) {
    try { await navigator.clipboard.writeText(code.dataset.url); toast("Share link copied", "success"); } catch { toast("Couldn't copy", "error"); }
    return;
  }
  button.disabled = true;
  try {
    const r = await api<ShareResponse>("/api/share");
    code.textContent = r.url;
    code.dataset.url = r.url;
    button.textContent = "Copy";
    try { await navigator.clipboard.writeText(r.url); toast("Share link copied", "success"); } catch { /* shown in the box */ }
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    button.disabled = false;
  }
});

// The "Track price" bookmark. It runs on the store's page, so it can read
// prices from stores that block the Worker, then opens this app with what it
// found. Kept dependency-free and small; it is URL-encoded into the href.
const BOOKMARKLET_SRC = `(function(){
var D=document,T=function(s){return (s||"").replace(/\\s+/g," ").trim()},N=function(s){var m=String(s||"").match(/\\d[\\d.,]*/);if(!m)return null;var n=m[0];n=/,\\d{3}$/.test(n)?n.replace(/,/g,""):n.replace(/,/g,"");var v=parseFloat(n);return isFinite(v)&&v>0?v:null};
var out={url:location.href,title:"",price:null,currency:null,image:null,availability:null,listPrice:null};
var ld=D.querySelectorAll('script[type="application/ld+json"]');
for(var i=0;i<ld.length&&out.price==null;i++){try{var j=JSON.parse(ld[i].textContent);var st=[].concat(j);while(st.length){var n=st.shift();if(!n||typeof n!="object")continue;if(Array.isArray(n)){st=st.concat(n);continue;}var ty=[].concat(n["@type"]||[]).join(" ");if(/Product/.test(ty)){var o=n.offers;o=Array.isArray(o)?o[0]:(o&&o.offers?[].concat(o.offers)[0]:o);if(o){out.price=N(o.price||o.lowPrice);out.currency=o.priceCurrency||null;out.availability=o.availability||null;}out.title=T(n.name);var im=n.image;im=Array.isArray(im)?im[0]:im;out.image=im&&im.url?im.url:(typeof im=="string"?im:null);if(out.price!=null)break;}if(n["@graph"])st=st.concat(n["@graph"]);}}catch(e){}}
var M=function(k){var e=D.querySelector('meta[property="'+k+'"],meta[name="'+k+'"],meta[itemprop="'+k+'"]');return e?e.getAttribute("content"):null};
if(out.price==null){out.price=N(M("product:price:amount")||M("og:price:amount")||M("price")||(D.querySelector('[itemprop="price"]')||{}).getAttribute&&(D.querySelector('[itemprop="price"]').getAttribute("content")||D.querySelector('[itemprop="price"]').textContent));out.currency=out.currency||M("product:price:currency")||M("og:price:currency")||M("priceCurrency");}
if(out.price==null){var sel=D.querySelectorAll('#corePrice_feature_div .a-offscreen,#apex_desktop .a-price .a-offscreen,[data-testid*="price" i],[class*="price" i],[id*="price" i],[class*="amount" i]');var cnt={},best=null,bc=0;for(var k=0;k<sel.length&&k<80;k++){var tx=T(sel[k].textContent);if(tx.length>40||!/₹|Rs|INR|\\$|€|£/.test(tx))continue;var v=N(tx);if(!v)continue;cnt[v]=(cnt[v]||0)+1;if(cnt[v]>bc){bc=cnt[v];best=v;}}out.price=best;if(best&&!out.currency)out.currency=/₹|Rs|INR/.test(D.body.innerText)?"INR":null;}
if(!out.title)out.title=T(M("og:title")||D.title);if(!out.image)out.image=M("og:image")||M("twitter:image");
if(/currently unavailable|out of stock|sold out/i.test(D.body.innerText.slice(0,20000)))out.availability="OutOfStock";
if(out.currency==null&&/₹/.test(D.body.innerText))out.currency="INR";
if(out.price==null){alert("Price Tracker couldn't find a price on this page.");return;}
window.open(__APP__+"/?capture="+encodeURIComponent(JSON.stringify(out)),"_blank");
})()`;

$("prefixTip").textContent = `${location.host}/`;
$<HTMLAnchorElement>("bookmarklet").href =
  "javascript:" + encodeURIComponent(BOOKMARKLET_SRC.replace("__APP__", JSON.stringify(location.origin)));
$("bookmarklet").addEventListener("click", (e) => {
  e.preventDefault();
  toast("Drag this button to your bookmarks bar; clicking it here does nothing.", "info");
});

// ---------- push alerts ----------

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  return navigator.serviceWorker.register("/sw.js");
}

function urlBase64ToUint8Array(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function setAlertsUi(on: boolean): void {
  $("alertsBtn").setAttribute("aria-pressed", String(on));
  $("alertsLabel").textContent = on ? "Alerts on" : "Alerts off";
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await swRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

const isIosBrowser = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window.matchMedia("(display-mode: standalone)").matches);

async function toggleAlerts(): Promise<void> {
  const reg = await swRegistration();
  if (!reg) {
    toast(isIosBrowser()
      ? "On iPhone, add this page to your Home Screen first (Share → Add to Home Screen), then turn alerts on from there."
      : "This browser doesn't support push alerts.", "error");
    return;
  }
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await api("/api/push", { method: "DELETE", body: JSON.stringify({ endpoint: existing.endpoint }) });
    await existing.unsubscribe();
    setAlertsUi(false);
    toast("Alerts off", "info");
    return;
  }
  if (!state.config?.vapidPublicKey) {
    toast("Alerts aren't set up on this server yet", "error");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Notifications were blocked. Allow them in your browser settings to get alerts.", "error");
    return;
  }
  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey) as BufferSource,
    });
    await api("/api/push", { method: "POST", body: JSON.stringify(sub.toJSON()) });
    setAlertsUi(true);
    toast("Alerts on. You'll be notified when a price drops.", "success");
  } catch (err) {
    toast(`Couldn't turn on alerts: ${(err as Error).message}`, "error");
  }
}

$("alertsBtn").addEventListener("click", toggleAlerts);
$("testPush").addEventListener("click", async () => {
  try {
    const r = await api<{ ok: boolean; sent: number }>("/api/push/test", { method: "POST" });
    toast(r.sent ? "Test alert sent" : "No device has alerts on for this list", r.sent ? "success" : "error");
  } catch (err) {
    toast((err as Error).message, "error");
  }
});

// ---------- start ----------

const SORTS: Sort[] = ["recent", "drop", "score", "low", "high", "name"];
state.sort = SORTS.includes(store.get("sort", "") as Sort) ? (store.get("sort", "recent") as Sort) : "recent";
$<HTMLSelectElement>("sort").value = state.sort;

load().then(handleQuery);
fetch("/api/config").then((r) => r.json()).then((c: ConfigResponse) => { state.config = c; }).catch(() => {});
currentSubscription().then((s) => setAlertsUi(!!s)).catch(() => {});
