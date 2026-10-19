const $ = (id) => document.getElementById(id);

const state = { products: [], filter: "all" };

const store = {
  get(k, fallback) {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${store.get("token", "")}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Wrong or missing admin token. Set it in Settings.");
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

function message(text, isError = false) {
  const m = $("msg");
  m.hidden = !text;
  m.textContent = text || "";
  m.classList.toggle("error", isError);
}

// ---------- loading ----------

async function load() {
  try {
    const data = await api("/api/products");
    state.products = data.products;
    render();
  } catch (err) {
    $("status").textContent = `Could not load: ${err.message}`;
  }
}

// ---------- rendering ----------

function isDropped(p) {
  return p.first != null && p.price != null && p.price < p.first;
}

function isHit(p) {
  return p.target != null && p.price != null && p.price <= p.target;
}

function render() {
  const all = state.products;
  const shown = all.filter((p) =>
    state.filter === "dropped" ? isDropped(p) :
    state.filter === "target" ? isHit(p) : true
  );

  $("count").textContent = all.length
    ? `${all.length} product${all.length === 1 ? "" : "s"} · ${all.filter(isHit).length} below target`
    : "";
  $("status").hidden = shown.length > 0;
  $("status").textContent = all.length
    ? "No products match this filter."
    : "Nothing tracked yet. Paste a product link above to start.";
  $("products").replaceChildren(...shown.map(card));

  document.querySelectorAll(".chips button").forEach((b) =>
    b.setAttribute("aria-pressed", b.dataset.filter === state.filter)
  );
}

function money(value, currency) {
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

function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function card(p) {
  const c = el("article", "card");
  if (isHit(p)) c.classList.add("hit");

  // Image, title, store
  const top = el("div", "card-top");
  if (p.image) {
    const img = el("img");
    img.src = p.image;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(el("div", "noimg"));
    top.append(img);
  } else {
    top.append(el("div", "noimg"));
  }
  const info = el("div");
  const title = el("a", "title", p.title);
  title.href = p.url;
  title.target = "_blank";
  title.rel = "noopener";
  info.append(title, el("div", "store", p.store));
  top.append(info);

  // Price and change since first check
  const row = el("div", "price-row");
  row.append(el("span", "price", money(p.price, p.currency)));
  if (p.first != null && p.price != null && p.price !== p.first) {
    const diff = p.price - p.first;
    const pct = Math.abs(Math.round((diff / p.first) * 100));
    const ch = el("span", `change ${diff < 0 ? "down" : "up"}`,
      `${diff < 0 ? "↓" : "↑"} ${money(Math.abs(diff), p.currency)} (${pct}%)`);
    ch.title = "Since you started tracking";
    row.append(ch);
  }
  if (isHit(p)) row.append(el("span", "badge", "Below target"));

  const stats = el("div", "stats");
  const stat = (label, value) => {
    const s = el("span", null, `${label} `);
    s.append(el("b", null, value));
    return s;
  };
  stats.append(
    stat("Low", money(p.lowest, p.currency)),
    stat("High", money(p.highest, p.currency)),
    el("span", null, `Checked ${ago(p.checked_at)}`)
  );

  c.append(top, row, chart(p), stats);
  if (p.error) c.append(el("p", "err", `Last check failed: ${p.error}`));

  // Target price, check now, remove
  const foot = el("div", "card-foot");
  const label = el("label", null, "Alert below");
  const target = el("input");
  target.type = "number";
  target.min = "0";
  target.step = "any";
  target.inputMode = "decimal";
  target.placeholder = "none";
  target.value = p.target ?? "";
  target.addEventListener("change", () => setTarget(p, target.value));
  label.append(target);

  const check = el("button", null, "Check now");
  check.addEventListener("click", () => checkNow(p, check));
  const remove = el("button", null, "Remove");
  remove.addEventListener("click", () => removeProduct(p));
  foot.append(label, check, remove);
  c.append(foot);
  return c;
}

const SVG = "http://www.w3.org/2000/svg";

function chart(p) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "chart");
  svg.setAttribute("viewBox", "0 0 300 70");
  svg.setAttribute("preserveAspectRatio", "none");
  const h = p.history || [];
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Price history, ${h.length} checks`);
  if (h.length < 2) return svg;

  const values = h.map((x) => x[1]);
  if (p.target != null) values.push(p.target);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi += 1; lo -= 1; }
  const t0 = h[0][0];
  const t1 = h[h.length - 1][0] || t0 + 1;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * 300;
  const y = (v) => 64 - ((v - lo) / (hi - lo)) * 58;

  // Prices hold until the next check, so draw steps rather than slopes.
  let d = `M ${x(h[0][0])} ${y(h[0][1])}`;
  for (let i = 1; i < h.length; i++) {
    d += ` H ${x(h[i][0])} V ${y(h[i][1])}`;
  }

  const area = document.createElementNS(SVG, "path");
  area.setAttribute("class", "area");
  area.setAttribute("d", `${d} V 70 H ${x(h[0][0])} Z`);
  const line = document.createElementNS(SVG, "path");
  line.setAttribute("class", "line");
  line.setAttribute("d", d);
  svg.append(area, line);

  if (p.target != null) {
    const t = document.createElementNS(SVG, "line");
    t.setAttribute("class", "target");
    t.setAttribute("x1", 0);
    t.setAttribute("x2", 300);
    t.setAttribute("y1", y(p.target));
    t.setAttribute("y2", y(p.target));
    svg.append(t);
  }
  return svg;
}

// ---------- actions ----------

$("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  message("Reading the product page…");
  try {
    await api("/api/products", {
      method: "POST",
      body: JSON.stringify({ url: $("url").value.trim(), target: $("target").value || null }),
    });
    $("url").value = "";
    $("target").value = "";
    message("");
    await load();
  } catch (err) {
    message(err.message, true);
  } finally {
    button.disabled = false;
  }
});

async function setTarget(p, value) {
  try {
    await api(`/api/products/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ target: value === "" ? null : Number(value) }),
    });
    await load();
  } catch (err) {
    message(err.message, true);
  }
}

async function checkNow(p, button) {
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const r = await api(`/api/products/${p.id}/check`, { method: "POST" });
    if (r.error) message(`${p.title}: ${r.error}`, true);
    await load();
  } catch (err) {
    message(err.message, true);
    button.disabled = false;
    button.textContent = "Check now";
  }
}

async function removeProduct(p) {
  if (!confirm(`Stop tracking "${p.title}"? Its price history will be deleted.`)) return;
  try {
    await api(`/api/products/${p.id}`, { method: "DELETE" });
    await load();
  } catch (err) {
    message(err.message, true);
  }
}

document.querySelectorAll(".chips button").forEach((b) =>
  b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    render();
  })
);

$("settingsToggle").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});
$("token").value = store.get("token", "");
$("token").addEventListener("change", () => store.set("token", $("token").value.trim()));

// Ask for the token on first visit, since every action needs it.
if (!store.get("token", "")) $("settings").hidden = false;

load();
