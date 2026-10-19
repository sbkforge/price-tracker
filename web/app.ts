// Price Tracker page. Built with esbuild into public/app.js.

import type { CheckResponse, ConfigResponse, ListResponse, PricePoint, Product } from "../src/shared";

type Filter = "all" | "dropped" | "target" | "out";
type Sort = "recent" | "drop" | "low" | "high" | "name";

const state = {
  products: [] as Product[],
  filter: "all" as Filter,
  sort: "recent" as Sort,
  query: "",
  loaded: false,
  config: null as ConfigResponse | null,
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string | null
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- rendering ----------

const isDropped = (p: Product): boolean => p.first != null && p.price != null && p.price < p.first;
const isHit = (p: Product): boolean => p.target != null && p.price != null && p.price <= p.target;
const dropPct = (p: Product): number =>
  p.first && p.price != null ? (p.first - p.price) / p.first : 0;

function visible(): Product[] {
  const q = state.query.toLowerCase();
  const list = state.products.filter((p) => {
    if (q && !`${p.title} ${p.store}`.toLowerCase().includes(q)) return false;
    switch (state.filter) {
      case "dropped": return isDropped(p);
      case "target": return isHit(p);
      case "out": return p.availability === "out_of_stock";
      default: return true;
    }
  });
  const by: Record<Sort, (a: Product, b: Product) => number> = {
    recent: (a, b) => b.created_at - a.created_at,
    drop: (a, b) => dropPct(b) - dropPct(a),
    low: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    high: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    name: (a, b) => a.title.localeCompare(b.title),
  };
  return list.sort(by[state.sort]);
}

function render(): void {
  const all = state.products;
  const shown = visible();

  $("subtitle").textContent = all.length
    ? `${all.length} product${all.length === 1 ? "" : "s"} · ${all.filter(isDropped).length} dropped · ${all.filter(isHit).length} below target`
    : "Paste a product link to start watching its price.";

  const empty = $("empty");
  empty.hidden = !state.loaded || shown.length > 0;
  $("emptyTitle").textContent = all.length ? "Nothing here" : "No products yet";
  $("emptyText").textContent = all.length
    ? "No tracked product matches this filter or search."
    : "Add a link from any online store. We'll check its price every 6 hours.";

  $("products").replaceChildren(...shown.map(card));

  document.querySelectorAll<HTMLButtonElement>("#filters button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter))
  );
}

function card(p: Product): HTMLElement {
  const c = el("article", "card");
  if (isHit(p)) c.classList.add("hit");

  // Photo, title, store
  const top = el("div", "card-top");
  const frame = el("div", "photo");
  if (p.image) {
    const img = el("img");
    img.src = p.image;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    frame.append(img);
  }
  const info = el("div", "info");
  const title = el("a", "title", p.title);
  title.href = p.url;
  title.target = "_blank";
  title.rel = "noopener";
  info.append(title, el("div", "store", p.store));
  top.append(frame, info);

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
  else if (p.history.length > 2 && p.price != null && p.price === p.lowest) {
    row.append(el("span", "chip low", "Lowest yet"));
  }
  if (p.availability === "out_of_stock") row.append(el("span", "chip stock out", "Out of stock"));
  else if (p.availability === "preorder") row.append(el("span", "chip stock", "Pre-order"));

  const stats = el("div", "stats");
  const stat = (label: string, value: string) => {
    const s = el("span");
    s.append(el("span", "k", label), el("span", "v", value));
    return s;
  };
  stats.append(
    stat("Low", money(p.lowest, p.currency)),
    stat("High", money(p.highest, p.currency)),
    stat("Avg", money(p.average != null && p.price != null && Number.isInteger(p.price) ? Math.round(p.average) : p.average, p.currency)),
    stat("Checked", ago(p.checked_at))
  );

  c.append(top, row, chart(p, 72), stats);
  if (p.error) c.append(el("p", "err", `Last check failed: ${p.error}`));

  // Target price, history, check now, remove
  const foot = el("div", "card-foot");
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

  const history = el("button", "pill", "History");
  history.addEventListener("click", () => openHistory(p));
  const check = el("button", "pill", "Check");
  check.title = "Check the price now";
  check.addEventListener("click", () => checkNow(p, check));
  const remove = el("button", "pill danger", "Remove");
  remove.addEventListener("click", () => removeProduct(p));
  foot.append(label, history, check, remove);
  c.append(foot);
  return c;
}

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

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

  const pts = h.map(([t, v]) => `${x(t).toFixed(1)} ${y(v).toFixed(1)}`);
  const d = `M ${pts.join(" L ")}`;
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

// ---------- history sheet with timeline ----------

const DAY = 86400000;
let sheetProduct: Product | null = null;
let sheetRange = 0; // days; 0 = all

const dateShort = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dateLong = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function rangeHistory(p: Product, days: number): PricePoint[] {
  if (!days) return p.history;
  const from = Date.now() - days * DAY;
  const inRange = p.history.filter(([t]) => t >= from);
  // Keep the last point before the range so the line starts at the edge.
  const before = p.history.filter(([t]) => t < from).pop();
  return before ? [[from, before[1]], ...inRange] : inRange;
}

// Big chart: date axis, grid, lowest/highest markers, hover or touch readout.
function timeline(p: Product, h: PricePoint[]): SVGElement {
  const W = 600, H = 200, L = 8, R = 8, T = 22, B = 24;
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img" });
  svg.style.height = `${H}px`;
  svg.setAttribute("aria-label", `Price timeline, ${h.length} checks`);
  const readout = $("hReadout");
  if (h.length < 2) {
    svg.classList.add("flat");
    svg.append(svgEl("line", { class: "line", x1: 0, x2: W, y1: H / 2, y2: H / 2 }));
    readout.textContent = h.length ? "Only one check so far; the line grows with each check." : "No checks in this range.";
    return svg;
  }

  const values = h.map((x) => x[1]);
  if (p.target != null) values.push(p.target);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const t0 = h[0][0];
  const t1 = h[h.length - 1][0];
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
  for (let i = 0; i < ticks; i++) {
    const t = t0 + (span * i) / (ticks - 1);
    const label = svgEl("text", {
      class: "axis", x: x(t), y: H - 6,
      "text-anchor": i === 0 ? "start" : i === ticks - 1 ? "end" : "middle",
    });
    label.textContent = span > 2 * DAY ? dateShort(t) : when(t);
    svg.append(label);
  }

  // Line and area
  const pts = h.map(([t, v]) => `${x(t).toFixed(1)} ${y(v).toFixed(1)}`);
  const d = `M ${pts.join(" L ")}`;
  const gid = `tl${p.id}`;
  const defs = svgEl("defs", {});
  const grad = svgEl("linearGradient", { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 });
  grad.append(svgEl("stop", { offset: "0%", class: "stop-a" }), svgEl("stop", { offset: "100%", class: "stop-b" }));
  defs.append(grad);
  svg.append(
    defs,
    svgEl("path", { class: "area", d: `${d} L ${x(t1).toFixed(1)} ${H - B} L ${x(t0).toFixed(1)} ${H - B} Z`, fill: `url(#${gid})` }),
    svgEl("path", { class: "line", d }),
  );
  if (p.target != null) {
    svg.append(svgEl("line", { class: "target", x1: L, x2: W - R, y1: y(p.target), y2: y(p.target) }));
  }

  // Lowest and highest markers (first time each was reached)
  const lowIdx = h.findIndex(([, v]) => v === Math.min(...h.map((q) => q[1])));
  const highIdx = h.findIndex(([, v]) => v === Math.max(...h.map((q) => q[1])));
  for (const [idx, cls] of [[highIdx, "hi"], [lowIdx, "lo"]] as const) {
    if (idx < 0) continue;
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
  $("hChart").replaceChildren(timeline(p, h));
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
      el("span", "muted", ` · tracking since ${since}`)
    );
  }
}

document.querySelectorAll<HTMLButtonElement>("#hRange button").forEach((b) =>
  b.addEventListener("click", () => {
    sheetRange = Number(b.dataset.range) || 0;
    renderHistoryChart();
  })
);

function openHistory(p: Product): void {
  sheetProduct = p;
  $("hTitle").textContent = p.title;
  const avg = p.average != null && p.price != null && Number.isInteger(p.price) ? Math.round(p.average) : p.average;
  $("hMeta").textContent = `${p.store} · ${p.history.length} check${p.history.length === 1 ? "" : "s"} · low ${money(p.lowest, p.currency)} · high ${money(p.highest, p.currency)} · avg ${money(avg, p.currency)}`;
  renderHistoryChart();
  $<HTMLAnchorElement>("hOpen").href = p.url;
  $<HTMLAnchorElement>("hCsv").href = `/api/products/${p.id}/history.csv`;

  const body = $("hTable").querySelector("tbody") as HTMLTableSectionElement;
  body.replaceChildren();
  const rows: PricePoint[] = [...p.history].reverse();
  rows.forEach(([t, v], i) => {
    const prev = rows[i + 1];
    const tr = el("tr");
    tr.append(el("td", undefined, when(t)));
    tr.append(el("td", "num", money(v, p.currency)));
    const diff = prev ? v - prev[1] : 0;
    const cell = el("td", `num ${diff < 0 ? "down" : diff > 0 ? "up" : ""}`,
      prev && diff !== 0 ? `${diff < 0 ? "▼" : "▲"} ${money(Math.abs(diff), p.currency)}` : "–");
    tr.append(cell);
    body.append(tr);
  });
  $<HTMLDialogElement>("historySheet").showModal();
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
  const url = $<HTMLInputElement>("url");
  const target = $<HTMLInputElement>("target");
  button.disabled = true;
  button.textContent = "Reading…";
  try {
    await api("/api/products", {
      method: "POST",
      body: JSON.stringify({ url: url.value.trim(), target: target.value || null }),
    });
    url.value = "";
    target.value = "";
    toast("Added. We'll watch this price for you.", "success");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Track";
  }
});

async function setTarget(p: Product, value: string): Promise<void> {
  try {
    await api(`/api/products/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ target: value === "" ? null : Number(value) }),
    });
    toast(value === "" ? "You'll be told about any drop" : `We'll flag it at or below ${money(Number(value), p.currency)}`, "success");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}

async function checkNow(p: Product, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const r = await api<CheckResponse>(`/api/products/${p.id}/check`, { method: "POST" });
    if (r.error) toast(`${p.title}: ${r.error}`, "error");
    else toast(r.cached ? "Checked a few minutes ago; showing that price." : "Price updated.", "success");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
    button.disabled = false;
    button.textContent = "Check";
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

// ---------- sheets ----------

document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) =>
  b.addEventListener("click", () => (b.closest("dialog") as HTMLDialogElement).close())
);
// Tap outside the sheet to close it.
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) =>
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); })
);

$("settingsBtn").addEventListener("click", () => {
  $("syncCode").textContent = ownerId();
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
  location.reload();
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

state.sort = (["recent", "drop", "low", "high", "name"] as Sort[]).includes(store.get("sort", "") as Sort)
  ? (store.get("sort", "recent") as Sort) : "recent";
$<HTMLSelectElement>("sort").value = state.sort;

load();
fetch("/api/config").then((r) => r.json()).then((c: ConfigResponse) => { state.config = c; }).catch(() => {});
currentSubscription().then((s) => setAlertsUi(!!s)).catch(() => {});
