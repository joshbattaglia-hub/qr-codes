const PUBLIC_FALLBACK = "https://expresshelp.site";
const NAME_TO_CODE = {
  Australia: "AU", "United States": "US", "United States of America": "US", Japan: "JP",
  "United Kingdom": "GB", "New Zealand": "NZ", Canada: "CA", Germany: "DE", France: "FR",
  India: "IN", Singapore: "SG", Ireland: "IE", Netherlands: "NL", China: "CN",
  "South Korea": "KR", Brazil: "BR", Mexico: "MX", Italy: "IT", Spain: "ES",
  Indonesia: "ID", Malaysia: "MY", Philippines: "PH", "Hong Kong": "HK", Taiwan: "TW",
  Sweden: "SE", Norway: "NO", Denmark: "DK", Finland: "FI", Switzerland: "CH",
  "South Africa": "ZA", "United Arab Emirates": "AE", Thailand: "TH", Vietnam: "VN",
};
const DEVICE_OPTIONS = [
  ["mobile", "Mobile"], ["tablet", "Tablet"], ["desktop", "Desktop"],
  ["ios", "iOS"], ["android", "Android"], ["windows", "Windows"],
  ["macos", "macOS"], ["chromeos", "ChromeOS"], ["linux", "Linux"],
];

const state = {
  codes: [],
  settings: { workspaceName: "Liberty", publicUrl: PUBLIC_FALLBACK, defaultFg: "#111827", defaultBg: "#ffffff" },
  detail: null,
  createMode: "qr",
  homeRange: "7d",
  search: "",
  locTab: "countries",
  compareMode: "none",
  compareSlug: "",
  compareStats: null,
  compareReady: false,
  focus: "",
  openCustomize: false,
  detailFrom: "",
  detailTo: "",
  analyticsFrom: "",
  analyticsTo: "",
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers["content-type"] = "application/json";
  const r = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/auth") { showLogin(); throw new Error("Unauthorized"); }
  if (!r.ok) throw new Error(d.error || "Request failed (" + r.status + ")");
  return d;
}
function base() { return (state.settings?.publicUrl || PUBLIC_FALLBACK).replace(/\/$/, ""); }
function host() { try { return new URL(base()).host; } catch { return "expresshelp.site"; } }
function shortUrl(slug) { return base() + "/r/" + slug; }
function qrTarget(slug) { return shortUrl(slug) + "?qr=1"; }
function hexOk(v) { return /^#[0-9a-fA-F]{6}$/.test(v || ""); }
function styleOf(c) {
  const fg = hexOk(c?.style?.fg) ? c.style.fg : "#111827";
  const bg = hexOk(c?.style?.bg) ? c.style.bg : "#ffffff";
  return { fg, bg };
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function lastN(n) {
  const end = todayKey();
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(addDays(end, -i));
  return keys;
}
function rangeKeys(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) return lastN(30);
  const start = from <= to ? from : to;
  const end = from <= to ? to : from;
  const keys = [];
  let cur = start;
  while (cur <= end && keys.length < 400) { keys.push(cur); cur = addDays(cur, 1); }
  return keys;
}
function previousKeys(keys) {
  if (!keys.length) return [];
  return keys.map((_, i) => addDays(keys[0], -(keys.length - i)));
}
function ensureRanges() {
  if (state.detailFrom) return;
  const keys = lastN(30);
  state.detailFrom = keys[0];
  state.detailTo = keys.at(-1);
  state.analyticsFrom = keys[0];
  state.analyticsTo = keys.at(-1);
}
function shortDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function longDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function formatCreated(iso) {
  if (!iso) return "—";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  }).format(new Date(iso));
  return date.replace(/, (\d)/, " $1").replace(" at ", " ");
}
function num(n) { return Number(n || 0).toLocaleString("en-AU"); }
function metricDelta(cur, prev) {
  if (!prev && !cur) return { cls: "flat", text: "0%" };
  if (!prev) return { cls: "up", text: "↑ New" };
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return { cls: "flat", text: "0%" };
  if (p > 0) return { cls: "up", text: "↑ " + p + "%" };
  return { cls: "down", text: "↓ " + Math.abs(p) + "%" };
}
function route() {
  const raw = (location.hash || "#/home").replace(/^#\/?/, "");
  const path = raw.split("?")[0];
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] || "home", id: parts[1] ? decodeURIComponent(parts[1]) : "" };
}
function go(path) {
  const next = "#/" + String(path || "home").replace(/^#?\/*/, "");
  closePops();
  setSidebar(false);
  if (location.hash === next) render();
  else location.hash = next;
}
function setSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#overlay").classList.toggle("show", open);
}
function closePops() {
  document.querySelectorAll("#pop-create,#pop-help,#pop-account,#search-results").forEach((el) => el.classList.add("hidden"));
}
function togglePop(id) {
  const el = $("#pop-" + id);
  if (!el) return;
  const willOpen = el.classList.contains("hidden");
  closePops();
  if (willOpen) el.classList.remove("hidden");
}
function showLogin(message) {
  $("#boot").classList.add("hidden");
  $("#shell").classList.add("hidden");
  $("#login").classList.remove("hidden");
  const err = $("#login-error");
  if (err) err.textContent = message || "";
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast("Copied");
}
function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function qrModel(slug, logo) {
  const q = qrcode(0, logo ? "H" : "M");
  q.addData(qrTarget(slug));
  q.make();
  return q;
}
function qrGeometry(slug, logo) {
  const q = qrModel(slug, !!logo);
  const n = q.getModuleCount();
  const margin = 4;
  const logoMods = logo ? Math.max(5, Math.round(n * 0.22)) : 0;
  const start = Math.floor((n - logoMods) / 2);
  return { q, n, margin, logoMods, start };
}
function qrSvg(slug, style, logo) {
  const s = styleOf(style ? { style } : { style });
  const fg = hexOk(style?.fg) ? style.fg : s.fg;
  const bg = hexOk(style?.bg) ? style.bg : s.bg;
  const g = qrGeometry(slug, logo);
  const cell = 10;
  const dim = (g.n + g.margin * 2) * cell;
  let d = "";
  for (let r = 0; r < g.n; r++) {
    for (let c = 0; c < g.n; c++) {
      if (g.logoMods && r >= g.start && r < g.start + g.logoMods && c >= g.start && c < g.start + g.logoMods) continue;
      if (g.q.isDark(r, c)) d += "M" + ((c + g.margin) * cell) + " " + ((r + g.margin) * cell) + "h" + cell + "v" + cell + "h-" + cell + "z";
    }
  }
  let image = "";
  if (logo && String(logo).startsWith("data:image/png;base64,")) {
    const x = (g.start + g.margin) * cell;
    const y = x;
    const size = g.logoMods * cell;
    image = '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" fill="' + bg + '"/>' +
      '<image href="' + logo + '" x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" preserveAspectRatio="xMidYMid meet"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    '<rect width="100%" height="100%" fill="' + bg + '"/><path d="' + d + '" fill="' + fg + '"/>' + image + "</svg>";
}
function drawQr(canvas, slug, style, logoImg) {
  const fg = hexOk(style?.fg) ? style.fg : "#111827";
  const bg = hexOk(style?.bg) ? style.bg : "#ffffff";
  const g = qrGeometry(slug, !!logoImg);
  const scale = Math.max(8, Math.ceil(1280 / (g.n + g.margin * 2)));
  const size = (g.n + g.margin * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = fg;
  for (let r = 0; r < g.n; r++) {
    for (let c = 0; c < g.n; c++) {
      if (g.logoMods && r >= g.start && r < g.start + g.logoMods && c >= g.start && c < g.start + g.logoMods) continue;
      if (g.q.isDark(r, c)) ctx.fillRect((c + g.margin) * scale, (r + g.margin) * scale, scale, scale);
    }
  }
  if (logoImg && g.logoMods) {
    const x = (g.start + g.margin) * scale;
    const y = x;
    const side = g.logoMods * scale;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, side, side);
    ctx.drawImage(logoImg, x, y, side, side);
  }
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read that image"));
    img.src = src;
  });
}
async function fileToLogo(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Use a PNG, JPEG, or WebP logo");
  const img = await loadImage(URL.createObjectURL(file));
  const max = 256;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const url = canvas.toDataURL("image/png");
  if (url.length > 180000) throw new Error("Logo is still too large after resizing");
  return url;
}

function bucketN(days, ymd, channel) {
  const day = days?.[ymd];
  if (!day) return 0;
  if (channel === "all") return (day.scan?.n || 0) + (day.click?.n || 0);
  return day[channel]?.n || 0;
}
function sumDim(days, keys, channel, dim) {
  const out = {};
  const channels = channel === "all" ? ["scan", "click"] : [channel];
  for (const key of keys) {
    for (const ch of channels) {
      for (const [name, n] of Object.entries(days?.[key]?.[ch]?.[dim] || {})) out[name] = (out[name] || 0) + n;
    }
  }
  return out;
}
function uniqueIn(days, keys, channel) {
  const set = new Set();
  const channels = channel === "all" ? ["scan", "click"] : [channel];
  for (const key of keys) for (const ch of channels) for (const h of days?.[key]?.[ch]?.u || []) set.add(h);
  return set.size;
}
function buildModel(stats, keys, channel) {
  const days = stats?.days || {};
  const series = keys.map((date) => ({ date, value: bucketN(days, date, channel) }));
  return {
    keys, series,
    total: series.reduce((s, d) => s + d.value, 0),
    unique: uniqueIn(days, keys, channel),
    country: sumDim(days, keys, channel, "country"),
    city: sumDim(days, keys, channel, "city"),
    browser: sumDim(days, keys, channel, "browser"),
    os: sumDim(days, keys, channel, "os"),
    device: sumDim(days, keys, channel, "device"),
    referrer: sumDim(days, keys, channel, "referrer"),
  };
}
function sumChannel(codes, keys, channel) {
  return keys.reduce((s, day) => s + codes.reduce((n, c) => n + bucketN(c.days, day, channel), 0), 0);
}
function countryLabel(key) {
  if (!key || key === "Unknown") return "Unknown";
  if (/^[A-Z]{2}$/.test(key)) {
    try { return new Intl.DisplayNames(["en"], { type: "region" }).of(key) || key; } catch { return key; }
  }
  return key;
}
function flagFor(key) {
  const code = /^[A-Z]{2}$/.test(key || "") ? key : (NAME_TO_CODE[key] || "");
  if (!/^[A-Z]{2}$/.test(code)) return "•";
  return String.fromCodePoint(...[...code].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}
function pctText(n, total) {
  if (!total || !n) return "0%";
  const pct = (n / total) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return Math.round(pct) + "%";
}
function niceMax(v) {
  if (v <= 1) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return f * p;
}
function smoothPath(points) {
  const nums = points.map((p) => [Number(p[0]), Number(p[1])]);
  if (!nums.length) return "";
  const n = (v) => Number(v).toFixed(1);
  const minY = Math.min(...nums.map((p) => p[1]));
  const maxY = Math.max(...nums.map((p) => p[1]));
  const clamp = (v) => Math.min(maxY, Math.max(minY, v));
  let d = "M" + n(nums[0][0]) + "," + n(nums[0][1]);
  for (let i = 0; i < nums.length - 1; i++) {
    const p0 = nums[i === 0 ? i : i - 1];
    const p1 = nums[i];
    const p2 = nums[i + 1];
    const p3 = nums[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
    d += "C" + n(c1x) + "," + n(c1y) + " " + n(c2x) + "," + n(c2y) + " " + n(p2[0]) + "," + n(p2[1]);
  }
  return d;
}
function areaChart(series, compare) {
  const w = 720, h = 210;
  const pad = { l: 36, r: 12, t: 16, b: 28 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...series.map((d) => d.value), ...(compare || []).map((d) => d.value)));
  const x = (i, len) => pad.l + (len <= 1 ? iw / 2 : (i / (len - 1)) * iw);
  const y = (v) => pad.t + (1 - v / max) * ih;
  const pts = series.map((d, i) => [x(i, series.length).toFixed(1), y(d.value).toFixed(1)]);
  const line = smoothPath(pts);
  const area = line + "L" + x(series.length - 1, series.length).toFixed(1) + "," + (pad.t + ih) + "L" + x(0, series.length).toFixed(1) + "," + (pad.t + ih) + "Z";
  const cmp = compare && compare.length ? smoothPath(compare.map((d, i) => [x(i, compare.length).toFixed(1), y(d.value).toFixed(1)])) : "";
  const ticks = max <= 1 ? [0, 1] : [0, max / 2, max];
  const grid = ticks.map((t) => {
    const yy = y(t).toFixed(1);
    const label = Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : t.toFixed(1);
    return '<line x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="#eef0f4"/>' +
      '<text x="' + (pad.l - 6) + '" y="' + (Number(yy) + 4) + '" text-anchor="end" font-size="11" fill="#98a2b3">' + label + "</text>";
  }).join("");
  const indexes = (() => {
    const n = series.length;
    if (n <= 1) return [0];
    const want = Math.min(n, 6);
    const out = [];
    for (let i = 0; i < want; i++) out.push(Math.round((i * (n - 1)) / (want - 1)));
    return [...new Set(out)];
  })();
  const labels = indexes.map((i) => {
    const anchor = i === 0 ? "start" : i === series.length - 1 ? "end" : "middle";
    return '<text x="' + x(i, series.length).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="' + anchor + '" font-size="11" fill="#98a2b3">' + esc(shortDate(series[i].date)) + "</text>";
  }).join("");
  const titles = series.map((d, i) => '<rect x="' + (x(i, series.length) - iw / Math.max(series.length, 1) / 2) + '" y="' + pad.t + '" width="' + (iw / Math.max(series.length, 1)) + '" height="' + ih + '" fill="transparent"><title>' + esc(shortDate(d.date) + ": " + d.value) + "</title></rect>").join("");
  return '<svg class="chart" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Engagements chart">' + grid +
    '<path d="' + area + '" fill="rgba(37,99,235,.16)"></path><path d="' + line + '" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"></path>' +
    (cmp ? '<path d="' + cmp + '" fill="none" stroke="#98a2b3" stroke-width="2" stroke-dasharray="5 4"></path>' : "") +
    labels + titles + "</svg>";
}
function dimTable(map, total, label, countLabel) {
  const rows = Object.entries(map).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const body = rows.length ? rows.map(([k, n]) => {
    const name = label === "Country" ? flagFor(k) + " " + esc(countryLabel(k)) : esc(k);
    return "<tr><td>" + name + '</td><td class="num">' + num(n) + '</td><td class="num muted">' + pctText(n, total) + "</td></tr>";
  }).join("") : '<tr><td class="muted" colspan="3">No data yet</td></tr>';
  return "<table><thead><tr><th>" + esc(label) + '</th><th class="num">' + esc(countLabel) + '</th><th class="num">%</th></tr></thead><tbody>' + body + "</tbody></table>";
}
function tagsHtml(tags, limit) {
  const list = tags || [];
  const shown = limit ? list.slice(0, limit) : list;
  if (!shown.length) return '<span class="muted">No tags</span>';
  return shown.map((t) => '<span class="chip">' + esc(t) + "</span>").join("") + (limit && list.length > limit ? '<span class="muted">+' + (list.length - limit) + "</span>" : "");
}
function statusBadge(c) {
  return c.paused ? '<span class="badge">Paused</span>' : '<span class="badge ok">Active</span>';
}
function filtered(list, pred) {
  const q = state.search.toLowerCase();
  return list.filter((c) => pred(c) && (!q || [c.name, c.slug, c.url, ...(c.tags || [])].join(" ").toLowerCase().includes(q)));
}
function codeBySlug(slug) { return state.codes.find((c) => c.slug === slug); }

function homeHtml() {
  const mode = state.createMode === "link" ? "link" : "qr";
  const n = state.homeRange === "1d" ? 1 : state.homeRange === "30d" ? 30 : 7;
  const keys = lastN(n);
  const prev = previousKeys(keys);
  const engagements = sumChannel(state.codes, keys, "all");
  const prevEng = sumChannel(state.codes, prev, "all");
  const clicks = sumChannel(state.codes, keys, "click");
  const prevClicks = sumChannel(state.codes, prev, "click");
  const scans = sumChannel(state.codes, keys, "scan");
  const prevScans = sumChannel(state.codes, prev, "scan");
  const series = keys.map((date) => ({ date, value: state.codes.reduce((s, c) => s + bucketN(c.days, date, "all"), 0) }));
  const compare = prev.map((date) => ({ date, value: state.codes.reduce((s, c) => s + bucketN(c.days, date, "all"), 0) }));
  const dEng = metricDelta(engagements, prevEng);
  const dClick = metricDelta(clicks, prevClicks);
  const dScan = metricDelta(scans, prevScans);
  const label = n === 1 ? "last 1 day" : "last " + n + " days";
  const rangeLabel = keys.length === 1 ? shortDate(keys[0]) : shortDate(keys[0]) + " – " + shortDate(keys.at(-1));
  const prevLabel = prev.length === 1 ? shortDate(prev[0]) : shortDate(prev[0]) + " – " + shortDate(prev.at(-1));
  const items = checklist();
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  return '<div class="mode-toggle" data-testid="mode-toggle"><div class="seg">' +
    '<button type="button" data-act="mode" data-mode="link" class="' + (mode === "link" ? "on" : "") + '">Short link</button>' +
    '<button type="button" data-act="mode" data-mode="qr" class="' + (mode === "qr" ? "on" : "") + '">QR Code</button></div></div>' +
    '<div class="home-grid"><div class="card" data-testid="quick-create"><div class="card-head"><h2>Quick create: ' + (mode === "qr" ? "QR Code" : "Short link") + '</h2><p class="muted small">You can create as many as you need.</p></div>' +
    '<div class="domain">Domain: <strong>' + esc(host()) + "</strong></div>" +
    '<form id="create-form" data-act="create"><label class="field"><span>Enter your destination URL</span></label>' +
    '<div class="url-row"><input id="dest-url" type="url" required placeholder="https://example.com/my-long-url" autocomplete="off" value="' + esc(state.draftUrl || "") + '">' +
    '<button class="btn" type="submit">' + (mode === "qr" ? "Create QR code" : "Create short link") + "</button></div>" +
    (mode === "link" ? '<label class="field"><span>Title (optional)</span><input id="link-title" type="text" maxlength="120" placeholder="Homepage"></label>' : "") +
    '<button class="text-btn" type="button" id="slug-toggle">Custom back-half</button><div id="slug-wrap" class="hidden"><label class="field"><span>Back-half</span><input id="custom-slug" type="text" maxlength="41" placeholder="auto-generated" autocomplete="off"></label></div>' +
    (mode === "qr" ? '<label class="check"><input id="also-link" type="checkbox"' + (state.alsoLink ? " checked" : "") + "> Also create a link for this QR Code</label>" : "") +
    '<p class="err" id="create-error"></p></form>' +
    '<div class="info-banner">Short links and QR codes use ' + esc(host()) + '. <a href="#/domains">Domain details</a></div></div>' +
    '<div class="card workflow"><div class="spark">✦ Simplify your workflow</div><p class="muted">Explore smarter ways to create QR codes.</p>' +
    '<button class="pill" type="button" data-act="customize-latest">Customize a QR Code</button>' +
    '<button class="pill" type="button" data-act="bulk">Bulk create QR Codes</button></div></div>' +
    '<div class="card" data-testid="engagements"><div class="card-head"><div><div class="muted">Total engagements, ' + label + '</div>' +
    '<div class="engage-num">' + num(engagements) + ' <span class="delta ' + dEng.cls + '">' + dEng.text + "</span></div>" +
    '<div class="muted small">vs ' + num(prevEng) + " prev period (" + esc(prevLabel) + ") · " + esc(rangeLabel) + "</div></div>" +
    '<div class="seg" role="group" aria-label="Date range">' +
    ["1d", "7d", "30d"].map((r) => '<button type="button" data-act="home-range" data-range="' + r + '" class="' + (state.homeRange === r ? "on" : "") + '">' + r + "</button>").join("") +
    "</div></div>" + areaChart(series, compare) +
    '<div class="legend"><span><i class="swatch"></i> This period</span><span><i class="swatch alt"></i> Previous period</span></div>' +
    '<div class="metrics"><div><div class="metric-label">Link clicks</div><div class="metric-value">' + num(clicks) + ' <span class="delta ' + dClick.cls + '">' + dClick.text + "</span></div></div>" +
    '<div><div class="metric-label">QR Code scans</div><div class="metric-value">' + num(scans) + ' <span class="delta ' + dScan.cls + '">' + dScan.text + "</span></div></div>" +
    '<div><div class="metric-label">Page clicks</div><div class="metric-value">0 <span class="muted">— no data</span></div></div></div>' +
    '<div class="row end" style="margin-top:12px"><button class="btn ghost" type="button" data-go="analytics">Explore Analytics →</button></div></div>' +
    '<div class="home-bottom"><div class="card"><div class="card-head"><h2>Connect your account</h2><a href="#/integrations">Explore Integrations →</a></div><div class="muted small">Recommended for you</div>' +
    connectRow("a", "C", "Chrome Extension", "Instant links and QR Codes from anywhere", "Install") +
    connectRow("b", "C", "Canva", "Popular pick in productivity and design", "Connect") +
    connectRow("c", "S", "Shopify", "Connect marketing activity to revenue", "Connect") +
    '</div><div class="card"><div class="card-head"><h2>Do more with Liberty</h2><div class="ring-wrap">' + pct + "%" + ring(pct) + "</div></div>" +
    items.map((item) => '<div class="check-item"><div class="dot' + (item.done ? " on" : "") + '">' + (item.done ? "✓" : "") + '</div><div><strong>' + esc(item.title) + '</strong><div class="muted small">' + esc(item.body) + "</div></div></div>").join("") +
    "</div></div>";
}
function connectRow(cls, letter, title, body, action) {
  return '<div class="connect-row"><div class="app-ico ' + cls + '">' + letter + '</div><div class="grow"><strong>' + esc(title) + '</strong><div class="muted small">' + esc(body) + '</div></div><a class="btn ghost" href="#/integrations">' + esc(action) + "</a></div>";
}
function ring(pct) {
  return '<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="#e6e8ee" stroke-width="4"></circle><circle cx="18" cy="18" r="15" fill="none" stroke="#12b76a" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + pct + ' 100" pathLength="100" transform="rotate(-90 18 18)"></circle></svg>';
}
function checklist() {
  const defaults = state.settings || {};
  return [
    { title: "Create a QR code or short link", body: "Your home chart fills in as people use them.", done: state.codes.length > 0 },
    { title: "Turn your data into insights", body: "Find your best links and codes with analytics.", done: state.codes.some((c) => (c.total || 0) > 0) },
    { title: "Customize a QR code", body: "Set colours or add a logo overlay.", done: state.codes.some((c) => c.hasLogo || (c.hasQr && c.style && (c.style.fg !== defaults.defaultFg || c.style.bg !== defaults.defaultBg))) },
  ];
}
function listHtml(kind) {
  const qr = kind === "qr";
  const rows = filtered(state.codes, (c) => qr ? c.hasQr : c.hasLink);
  const head = qr
    ? "<th></th><th>Title</th><th>Destination</th><th class='num'>Scans</th><th>Tags</th><th>Created</th><th>Status</th>"
    : "<th>Title</th><th>Short link</th><th>Destination</th><th class='num'>Clicks</th><th>Tags</th><th>Created</th><th>Status</th>";
  const body = rows.map((c) => {
    const href = (qr ? "qrcodes/" : "links/") + encodeURIComponent(c.slug);
    const count = qr ? c.scans || 0 : c.clicks || 0;
    const title = "<strong>" + esc(c.name || c.slug) + "</strong><div class='muted small'>/r/" + esc(c.slug) + "</div>";
    const cells = qr
      ? "<td><span class='mini'>" + qrSvg(c.slug, styleOf(c), "") + "</span></td><td>" + title + "</td>"
      : "<td>" + title + "</td><td class='break'>" + esc(shortUrl(c.slug)) + "</td>";
    return '<tr class="clickable" data-go="' + href + '">' + cells + "<td class='break'>" + esc(c.url) + "</td><td class='num'>" + num(count) + "</td><td>" + tagsHtml(c.tags, 3) + "</td><td>" + esc(formatCreated(c.created)) + "</td><td>" + statusBadge(c) + "</td></tr>";
  }).join("");
  return '<div class="page-head"><h1>' + (qr ? "QR Codes" : "Links") + '</h1><button class="btn" type="button" data-go="home" data-mode="' + (qr ? "qr" : "link") + '" data-focus="#dest-url">' + (qr ? "Create QR code" : "Create short link") + "</button></div>" +
    '<div class="card table-wrap">' + (rows.length ? "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>" : '<div class="empty"><div class="empty-mark">L</div><h2>Nothing here yet</h2><p class="muted">' + (state.search ? "No matches for that search." : "Create one from Home.") + "</p></div>") + "</div>";
}
function pageHead(code, qr) {
  const dl = qr
    ? '<button type="button" data-act="dl-png">PNG</button><button type="button" data-act="dl-svg">SVG</button><button type="button" data-act="dl-csv">Analytics CSV</button>'
    : '<button type="button" data-act="dl-csv">Analytics CSV</button><button type="button" data-act="copy-link">Copy short link</button>';
  return '<div class="page-head"><button class="icon-btn" type="button" data-go="' + (qr ? "qrcodes" : "links") + '" aria-label="Back">←</button>' +
    "<h1>" + esc(code.name || code.slug) + " " + (code.paused ? '<span class="badge">Paused</span>' : "") + "</h1>" +
    '<div class="menu-wrap"><button class="icon-btn" type="button" data-act="toggle-menu" data-menu="more" aria-label="More">⋯</button><div id="menu-more" class="pop menu hidden">' +
    '<button type="button" data-act="edit">Edit destination</button><button type="button" data-act="copy-link">Copy short link</button>' +
    '<button type="button" data-act="pause">' + (code.paused ? "Resume" : "Pause") + '</button><button type="button" data-act="del">Delete</button></div></div>' +
    '<div class="menu-wrap"><button class="btn ghost" type="button" data-act="toggle-menu" data-menu="download">Download ▾</button><div id="menu-download" class="pop menu hidden">' + dl + "</div></div></div>";
}
function detailsCard(code, qr) {
  const tags = (code.tags || []).length
    ? (code.tags || []).map((t) => '<span class="chip">' + esc(t) + ' <button type="button" data-act="del-tag" data-tag="' + esc(t) + '" aria-label="Remove tag">×</button></span>').join("")
    : '<span class="muted">No tags</span>';
  const rows = qr
    ? kv("Scan destination", "Website / URL") + kv("Destination", '<a href="' + esc(code.url) + '" target="_blank" rel="noreferrer">' + esc(code.url) + "</a>")
    : kv("Short link", '<a href="' + esc(shortUrl(code.slug)) + '" target="_blank" rel="noreferrer">' + esc(shortUrl(code.slug)) + "</a>") + kv("Destination", '<a href="' + esc(code.url) + '" target="_blank" rel="noreferrer">' + esc(code.url) + "</a>");
  return '<div class="card" data-testid="' + (qr ? "qr-details" : "link-details") + '"><div class="card-head"><h2>Details</h2><button class="text-btn" type="button" data-act="edit">Edit</button></div><div class="kv">' +
    rows + '<div class="k">Tags</div><div><div class="chips">' + tags + '</div><form data-act="add-tag" class="row" style="margin-top:8px"><input name="tag" type="text" maxlength="40" placeholder="Add a tag" aria-label="Add a tag" style="flex:1;border:1px solid #d0d5dd;border-radius:8px;padding:8px 10px"><button class="btn ghost" type="submit">Add</button></form></div>' +
    kv("Created on", esc(formatCreated(code.created))) +
    (code.notes ? kv("Notes", esc(code.notes)) : "") +
    "</div></div>";
}
function kv(k, v) { return '<div class="k">' + k + "</div><div class='break'>" + v + "</div>"; }
function qrSide(code) {
  const logo = code.logoData || "";
  return '<div class="card" data-testid="qr-preview"><div class="qr-stage">' + qrSvg(code.slug, styleOf(code), logo) + "</div>" +
    '<div class="muted small break" style="margin-top:8px">' + esc(shortUrl(code.slug)) + "</div>" +
    '<button class="text-btn" type="button" data-act="customize">Customize</button>' +
    (code.hasLink ? '<a class="btn ghost wide" href="#/links/' + encodeURIComponent(code.slug) + '">View short link</a>' : '<button class="btn ghost wide" type="button" data-act="make-link">+ Create short link</button>') +
    "</div>";
}
function linkSide(code) {
  if (code.hasQr) {
    return '<div class="card" data-testid="qr-preview"><div class="qr-stage">' + qrSvg(code.slug, styleOf(code), code.logoData || "") + "</div>" +
      '<button class="text-btn" type="button" data-act="customize">Customize</button>' +
      '<a class="btn ghost wide" href="#/qrcodes/' + encodeURIComponent(code.slug) + '">View QR code</a></div>';
  }
  return '<div class="card empty"><div class="empty-mark">L</div><h2>No QR code yet</h2><p class="muted">Create one that points at this same short link.</p><button class="btn" type="button" data-act="make-qr">Create QR code</button></div>';
}
function routingCard(code) {
  const rules = code.rules || [];
  const list = rules.map((rule, i) => {
    const label = rule.type === "device" ? (DEVICE_OPTIONS.find((d) => d[0] === rule.value)?.[1] || rule.value) : rule.value;
    return '<div class="rule"><span class="badge muted">' + (rule.type === "device" ? "Device" : "Location") + "</span><strong>" + esc(label) + '</strong><span class="muted">→</span><span class="break grow">' + esc(rule.url) + "</span>" +
      '<button class="btn ghost" type="button" data-act="rule-up" data-i="' + i + '" aria-label="Move up">↑</button>' +
      '<button class="btn ghost" type="button" data-act="rule-down" data-i="' + i + '" aria-label="Move down">↓</button>' +
      '<button class="btn ghost" type="button" data-act="rule-del" data-i="' + i + '">Delete</button></div>';
  }).join("");
  const devices = DEVICE_OPTIONS.map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("");
  return '<div class="card" data-testid="routing"><div class="card-head"><h2>Dynamic routing</h2><button class="btn ghost" type="button" data-act="toggle-rule">+ Add rules</button></div>' +
    '<p class="muted">Automatically route visitors to different destinations based on device, location, and more.</p>' +
    (list || "") +
    '<form id="rule-form" class="rule-form hidden" data-act="save-rule"><label class="field"><span>Route by</span><select id="rule-kind"><option value="device">Device</option><option value="location">Location</option></select></label>' +
    '<div id="rule-device-wrap"><label class="field"><span>Device</span><select id="rule-device">' + devices + "</select></label></div>" +
    '<div id="rule-loc-wrap" class="hidden"><label class="field"><span>Location</span><input id="rule-loc" type="text" maxlength="80" placeholder="Country, city, or code — AU, Australia, Sydney"></label></div>' +
    '<label class="field"><span>Destination URL</span><input id="rule-url" type="url" required placeholder="https://example.com/mobile"></label>' +
    '<div class="row end"><button class="btn" type="submit">Add rule</button></div><p class="muted small">First matching rule wins. Everyone else goes to the main destination.</p></form></div>';
}
function analyticsBlock(code, channel) {
  const noun = channel === "click" ? "Clicks" : "Scans";
  const from = state.detailFrom, to = state.detailTo;
  const keys = rangeKeys(from, to);
  const model = buildModel(state.detail.stats, keys, channel);
  let compare = null;
  let compareLabel = "";
  if (state.compareMode === "prev") {
    compare = buildModel(state.detail.stats, previousKeys(keys), channel);
    compareLabel = "Previous period";
  } else if (state.compareMode === "code" && state.compareSlug && state.compareSlug !== code.slug) {
    const stats = state.compareReady && state.compareStats ? state.compareStats : { days: codeBySlug(state.compareSlug)?.days || {} };
    compare = buildModel(stats, keys, channel);
    if (!state.compareReady) compare.unique = null;
    compareLabel = (codeBySlug(state.compareSlug)?.name || state.compareSlug);
  }
  const otherName = state.compareSlug ? esc(codeBySlug(state.compareSlug)?.name || state.compareSlug) : "";
  const select = '<select id="compare-select" aria-label="Comparison"><option value="none"' + (state.compareMode === "none" ? " selected" : "") + '>No comparison</option><option value="prev"' + (state.compareMode === "prev" ? " selected" : "") + '>Previous period</option>' +
    (state.compareMode === "code" && state.compareSlug ? '<option value="code" selected>' + otherName + "</option>" : "") + "</select>";
  const dUnique = compare && compare.unique != null ? metricDelta(model.unique, compare.unique) : null;
  const dTotal = compare ? metricDelta(model.total, compare.total) : null;
  const title = (channel === "click" ? "Link analytics" : "Code analytics") + " - " + code.url;
  return '<div class="card" data-testid="code-analytics"><h2 class="break">' + esc(title) + "</h2>" +
    '<div class="toolbar"><div class="range-wrap"><button class="btn ghost" type="button" data-act="toggle-dates">' + esc(longDate(from) + " → " + longDate(to)) + "</button>" + datePop("detail", from, to) + "</div>" +
    select + '<button class="text-btn" type="button" data-act="compare-pick" data-kind="' + (channel === "click" ? "link" : "qr") + '">Compare to a ' + (channel === "click" ? "link" : "QR Code") + "</button>" +
    '<button class="icon-btn" type="button" data-act="dl-csv" aria-label="Download CSV">↓</button></div>' +
    '<div class="stat-pair"><div class="stat-box"><div class="muted">Total ' + noun.toLowerCase() + '</div><div class="num">' + (compare && compare.unique == null ? num(model.unique) : num(model.unique)) + (dUnique ? ' <span class="delta ' + dUnique.cls + '">' + dUnique.text + "</span>" : "") + '</div><div class="sub">Unique</div></div>' +
    '<div class="stat-box"><div class="muted">' + noun + '</div><div class="num">' + num(model.total) + (dTotal ? ' <span class="delta ' + dTotal.cls + '">' + dTotal.text + "</span>" : "") + '</div><div class="sub">Total</div></div></div>' +
    "<h2 style='margin:8px 0'>" + noun + " over time</h2>" + areaChart(model.series, compare ? compare.series : null) +
    (compare ? '<div class="legend"><span><i class="swatch"></i> This period</span><span><i class="swatch alt"></i> ' + esc(compareLabel) + "</span></div>" : "") +
    '<div class="split" style="margin-top:16px"><div class="card" data-testid="by-location" style="margin:0"><div class="card-head"><h2>' + noun + ' by location</h2><div class="tabs">' +
    '<button type="button" data-act="loc-tab" data-tab="countries" class="' + (state.locTab !== "cities" ? "on" : "") + '">Countries</button>' +
    '<button type="button" data-act="loc-tab" data-tab="cities" class="' + (state.locTab === "cities" ? "on" : "") + '">Cities</button></div></div>' +
    '<div class="table-wrap">' + dimTable(state.locTab === "cities" ? model.city : model.country, model.total, state.locTab === "cities" ? "City" : "Country", noun) + "</div></div>" +
    '<div class="card" data-testid="by-browser" style="margin:0"><div class="card-head"><h2>' + noun + ' by browser</h2></div><div class="table-wrap">' + dimTable(model.browser, model.total, "Browser", noun) + "</div></div></div>" +
    '<div class="card" data-testid="by-os" style="margin:16px 0 0"><div class="card-head"><h2>' + noun + ' by operating system</h2></div><div class="table-wrap">' + dimTable(model.os, model.total, "Operating system", noun) + "</div></div></div>";
}
function datePop(target, from, to) {
  return '<div id="date-pop" class="pop date-pop hidden"><div class="field"><span>From</span><input id="from-date" type="date" value="' + esc(from) + '"></div><div class="field"><span>To</span><input id="to-date" type="date" value="' + esc(to) + '"></div>' +
    '<div class="row"><button class="btn ghost" type="button" data-act="preset" data-days="7">Last 7 days</button><button class="btn ghost" type="button" data-act="preset" data-days="30">Last 30 days</button><button class="btn ghost" type="button" data-act="preset" data-days="90">Last 90 days</button></div>' +
    '<div class="row end" style="margin-top:8px"><button class="btn" type="button" data-act="apply-dates" data-target="' + target + '">Apply</button></div></div>';
}
function detailHtml(qr) {
  const code = state.detail.code;
  const channel = qr ? "scan" : "click";
  return pageHead(code, qr) + '<div class="detail-grid">' + detailsCard(code, qr) + (qr ? qrSide(code) : linkSide(code)) + "</div>" + routingCard(code) + analyticsBlock(code, channel);
}
function workspaceModel(from, to) {
  const keys = rangeKeys(from, to);
  const fake = { days: {} };
  for (const key of keys) {
    const scan = { n: 0, browser: {}, os: {}, device: {}, country: {}, city: {}, referrer: {} };
    const click = { n: 0, browser: {}, os: {}, device: {}, country: {}, city: {}, referrer: {} };
    for (const c of state.codes) {
      const day = c.days?.[key];
      if (!day) continue;
      mergeBucket(scan, day.scan);
      mergeBucket(click, day.click);
    }
    fake.days[key] = { scan, click };
  }
  return { keys, all: buildModel(fake, keys, "all"), scan: buildModel(fake, keys, "scan"), click: buildModel(fake, keys, "click") };
}
function mergeBucket(into, src) {
  if (!src) return;
  into.n += src.n || 0;
  for (const dim of ["browser", "os", "device", "country", "city", "referrer"]) {
    for (const [k, n] of Object.entries(src[dim] || {})) into[dim][k] = (into[dim][k] || 0) + n;
  }
}
function topTable(rows, label) {
  const body = rows.length ? rows.map((c) => '<tr class="clickable" data-go="' + (c.hasQr && label === "Scans" ? "qrcodes/" : "links/") + encodeURIComponent(c.slug) + '"><td>' + esc(c.name || c.slug) + '</td><td class="num">' + num(c.count) + "</td></tr>").join("") : '<tr><td class="muted" colspan="2">No data yet</td></tr>';
  return "<table><thead><tr><th>Title</th><th class='num'>" + esc(label) + "</th></tr></thead><tbody>" + body + "</tbody></table>";
}
function analyticsPage() {
  const from = state.analyticsFrom, to = state.analyticsTo;
  const keys = rangeKeys(from, to);
  const prev = previousKeys(keys);
  const model = workspaceModel(from, to);
  const prevModel = workspaceModel(prev[0], prev.at(-1));
  const dAll = metricDelta(model.all.total, prevModel.all.total);
  const ranked = (channel) => state.codes.map((c) => ({ ...c, count: c.days ? rangeKeys(from, to).reduce((s, day) => s + bucketN(c.days, day, channel), 0) : 0 })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 8);
  return '<div class="page-head"><h1>Analytics</h1><button class="btn ghost" type="button" data-act="dl-workspace-csv">Download CSV</button></div>' +
    '<div class="card"><div class="toolbar"><div class="range-wrap"><button class="btn ghost" type="button" data-act="toggle-dates">' + esc(longDate(from) + " → " + longDate(to)) + "</button>" + datePop("analytics", from, to) + "</div></div>" +
    '<div class="metrics"><div><div class="metric-label">Total engagements</div><div class="metric-value">' + num(model.all.total) + ' <span class="delta ' + dAll.cls + '">' + dAll.text + "</span></div></div>" +
    '<div><div class="metric-label">Link clicks</div><div class="metric-value">' + num(model.click.total) + "</div></div>" +
    '<div><div class="metric-label">QR Code scans</div><div class="metric-value">' + num(model.scan.total) + "</div></div></div>" +
    areaChart(model.all.series, prevModel.all.series) +
    '<div class="legend"><span><i class="swatch"></i> This period</span><span><i class="swatch alt"></i> Previous period</span></div>' +
    '<div class="muted small" style="margin-top:8px">Page clicks: 0 — no data. Pages are not tracked in this workspace.</div></div>' +
    '<div class="split"><div class="card"><h2>Top links</h2><div class="table-wrap">' + topTable(ranked("click").filter((c) => c.hasLink), "Clicks") + '</div></div><div class="card"><h2>Top QR codes</h2><div class="table-wrap">' + topTable(ranked("scan").filter((c) => c.hasQr), "Scans") + "</div></div></div>" +
    '<div class="split"><div class="card" data-testid="by-location"><div class="card-head"><h2>By location</h2><div class="tabs"><button type="button" data-act="loc-tab" data-tab="countries" class="' + (state.locTab !== "cities" ? "on" : "") + '">Countries</button><button type="button" data-act="loc-tab" data-tab="cities" class="' + (state.locTab === "cities" ? "on" : "") + '">Cities</button></div></div><div class="table-wrap">' + dimTable(state.locTab === "cities" ? model.all.city : model.all.country, model.all.total, state.locTab === "cities" ? "City" : "Country", "Engagements") + '</div></div>' +
    '<div class="card" data-testid="by-browser"><h2>By browser</h2><div class="table-wrap">' + dimTable(model.all.browser, model.all.total, "Browser", "Engagements") + "</div></div></div>" +
    '<div class="card" data-testid="by-os"><h2>By operating system</h2><div class="table-wrap">' + dimTable(model.all.os, model.all.total, "Operating system", "Engagements") + "</div></div>";
}
function domainsPage() {
  return '<div class="page-head"><h1>Custom domains</h1></div><div class="card"><div class="card-head"><h2>' + esc(host()) + '</h2><span class="badge ok">Active</span></div><p>Primary domain for every short link and QR code.</p><p class="break"><strong>' + esc(base()) + "/r/&lt;slug&gt;</strong></p></div>" +
    '<div class="card"><h2>Adding another domain</h2><p class="muted">Extra hostnames are attached in Netlify and at your DNS host. This admin does not sell or provision domains.</p>' +
    '<div class="table-wrap"><table><thead><tr><th>Type</th><th>Host</th><th>Value</th></tr></thead><tbody>' +
    "<tr><td>A</td><td>@</td><td>75.2.60.5</td></tr><tr><td>CNAME</td><td>www</td><td>liberty-qr-353.netlify.app</td></tr>" +
    "</tbody></table></div></div>";
}
function integrationsPage() {
  const cards = [
    ["Chrome Extension", "Instant links and QR Codes from anywhere"],
    ["Canva", "Popular pick in productivity and design"],
    ["Shopify", "Connect marketing activity to revenue"],
  ];
  return '<div class="page-head"><h1>Integrations</h1></div><p class="muted">These are placeholders. Nothing here is connected.</p>' +
    cards.map(([t, b]) => '<div class="card"><div class="card-head"><h2>' + t + '</h2><span class="badge muted">Not connected</span></div><p class="muted">' + b + "</p></div>").join("");
}
function settingsPage() {
  const s = state.settings;
  return '<div class="page-head"><h1>Settings</h1></div><form class="card" data-act="save-settings"><label class="field"><span>Workspace name</span><input name="workspaceName" type="text" maxlength="40" value="' + esc(s.workspaceName) + '"></label>' +
    '<div class="split"><label class="field"><span>Default QR foreground</span><span class="color-row"><input name="defaultFg" type="color" value="' + esc(s.defaultFg) + '"><input name="defaultFgText" type="text" value="' + esc(s.defaultFg) + '"></span></label>' +
    '<label class="field"><span>Default QR background</span><span class="color-row"><input name="defaultBg" type="color" value="' + esc(s.defaultBg) + '"><input name="defaultBgText" type="text" value="' + esc(s.defaultBg) + '"></span></label></div>' +
    '<label class="field"><span>Public URL</span><input type="text" readonly value="' + esc(s.publicUrl) + '"></label>' +
    '<p class="muted small">Short links stay on ' + esc(base()) + "/r/&lt;slug&gt;. The admin password is the ADMIN_PASSWORD environment variable and is not changed here. This session cookie lasts 7 days.</p>" +
    '<div class="row"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="logout">Log out</button></div></form>';
}
function placeholder(title, body) {
  return '<div class="page-head"><h1>' + title + '</h1></div><div class="card empty"><div class="empty-mark">L</div><h2>' + title + '</h2><p class="muted">' + body + "</p></div>";
}
function pageFor(r) {
  if (r.name === "home") return homeHtml();
  if (r.name === "links") return listHtml("link");
  if (r.name === "qrcodes") return listHtml("qr");
  if (r.name === "analytics") return analyticsPage();
  if (r.name === "pages") return placeholder("Pages", "Landing pages are not set up in this workspace. QR codes and short links cover what you share today.");
  if (r.name === "campaigns") return placeholder("Campaigns", "Campaigns are not set up in this workspace. Use tags on links and QR codes to group them.");
  if (r.name === "domains") return domainsPage();
  if (r.name === "integrations") return integrationsPage();
  if (r.name === "settings") return settingsPage();
  return placeholder("Not found", "That page is not part of this admin.");
}

function currentChannel() {
  const r = route();
  return r.name === "links" ? "click" : "scan";
}
function currentModel() {
  const code = state.detail?.code;
  const stats = state.detail?.stats;
  if (!code || !stats) return null;
  const keys = rangeKeys(state.detailFrom, state.detailTo);
  const channel = currentChannel();
  const model = buildModel(stats, keys, channel);
  model.from = keys[0];
  model.to = keys.at(-1);
  model.channel = channel;
  model.slug = code.slug;
  model.url = code.url;
  return model;
}
function toCsv(model) {
  const noun = model.channel === "click" ? "clicks" : "scans";
  const lines = [
    ["metric", "unique_" + noun, model.unique],
    ["metric", "total_" + noun, model.total],
    ["metric", "from", model.from],
    ["metric", "to", model.to],
  ];
  for (const row of model.series) lines.push(["day", row.date, row.value]);
  for (const [dim, map] of [["country", model.country], ["city", model.city], ["browser", model.browser], ["os", model.os], ["device", model.device], ["referrer", model.referrer]]) {
    for (const [k, n] of Object.entries(map)) lines.push([dim, k, n]);
  }
  return lines.map((r) => r.map(csvCell).join(",")).join("\n");
}
async function patchCode(slug, body) {
  const code = await api("/api/codes/" + encodeURIComponent(slug), { method: "PATCH", body: JSON.stringify(body) });
  if (state.detail?.code?.slug === slug) state.detail.code = code;
  const i = state.codes.findIndex((c) => c.slug === slug);
  if (i >= 0) {
    const { logoData, ...rest } = code;
    state.codes[i] = { ...state.codes[i], ...rest };
  }
  return code;
}
function openModal(html) {
  const root = $("#modal");
  root.classList.remove("hidden");
  root.innerHTML = '<div class="modal-back" data-act="close-modal"></div><div class="modal-card" role="dialog">' + html + "</div>";
}
function closeModal() {
  const root = $("#modal");
  root.classList.add("hidden");
  root.innerHTML = "";
}
function openEdit() {
  const c = state.detail.code;
  openModal('<h2>Edit destination</h2><form data-act="save-edit"><p class="muted small break">' + esc(shortUrl(c.slug)) + "</p>" +
    '<label class="field"><span>Title</span><input name="name" type="text" maxlength="120" value="' + esc(c.name || "") + '"></label>' +
    '<label class="field"><span>Destination URL</span><input name="url" type="url" required value="' + esc(c.url) + '"></label>' +
    '<label class="field"><span>Notes</span><textarea name="notes" maxlength="2000">' + esc(c.notes || "") + "</textarea></label>" +
    '<div class="row end"><button class="btn ghost" type="button" data-act="close-modal">Cancel</button><button class="btn" type="submit">Save</button></div><p class="err" id="edit-error"></p></form>');
}
function openCustomize() {
  const c = state.detail.code;
  const style = styleOf(c);
  openModal('<h2>Customize QR code</h2><div class="preview-box" id="c-preview">' + qrSvg(c.slug, style, c.logoData || "") + "</div>" +
    '<form data-act="save-customize"><input type="hidden" id="c-logo-data" value="' + esc(c.logoData || "") + '">' +
    '<label class="field"><span>Foreground</span><span class="color-row"><input id="c-fg" type="color" value="' + esc(style.fg) + '"><input id="c-fg-text" type="text" value="' + esc(style.fg) + '"></span></label>' +
    '<label class="field"><span>Background</span><span class="color-row"><input id="c-bg" type="color" value="' + esc(style.bg) + '"><input id="c-bg-text" type="text" value="' + esc(style.bg) + '"></span></label>' +
    '<label class="field"><span>Logo</span><input id="c-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>' +
    '<div class="row"><button class="btn ghost" type="button" data-act="clear-logo">Remove logo</button></div>' +
    '<p class="muted small">A logo uses higher error correction. PNG and JPEG files are resized before they are saved. Colours and the logo apply to downloaded PNG and SVG files.</p>' +
    '<div class="row end"><button class="btn ghost" type="button" data-act="close-modal">Cancel</button><button class="btn" type="submit">Save</button></div><p class="err" id="c-error"></p></form>');
}
function paintCustomize() {
  const box = $("#c-preview");
  if (!box || !state.detail) return;
  const fg = $("#c-fg-text").value.trim();
  const bg = $("#c-bg-text").value.trim();
  const style = { fg: hexOk(fg) ? fg : "#111827", bg: hexOk(bg) ? bg : "#ffffff" };
  box.innerHTML = qrSvg(state.detail.code.slug, style, $("#c-logo-data").value);
}
function openBulk() {
  openModal('<h2>Bulk create QR Codes</h2><form data-act="save-bulk"><label class="field"><span>One destination URL per line</span><textarea id="bulk-text" placeholder="https://example.com/a&#10;https://example.com/b, Spring launch"></textarea></label>' +
    '<label class="check"><input id="bulk-also" type="checkbox"> Also create a link for each QR Code</label>' +
    '<div class="row end"><button class="btn ghost" type="button" data-act="close-modal">Close</button><button class="btn" type="submit">Create</button></div><div id="bulk-results" class="small" style="margin-top:10px"></div></form>');
}
function openCompare(kind) {
  const current = state.detail?.code?.slug;
  const items = state.codes.filter((c) => c.slug !== current && (kind === "link" ? c.hasLink : c.hasQr));
  const buttons = items.length ? items.map((c) => '<button type="button" data-act="pick-compare" data-slug="' + esc(c.slug) + '"><strong>' + esc(c.name || c.slug) + '</strong><span class="muted small">' + esc(c.url) + "</span></button>").join("") : '<p class="muted">Create another code to compare.</p>';
  openModal("<h2>Compare to a " + (kind === "link" ? "link" : "QR Code") + "</h2>" + buttons + '<div class="row end" style="margin-top:8px"><button class="btn ghost" type="button" data-act="close-modal">Close</button></div>');
}
function syncColorPair(colorId, textId, source) {
  const color = $(colorId), text = $(textId);
  if (!color || !text) return;
  if (source === color) text.value = color.value;
  else if (hexOk(text.value.trim())) color.value = text.value.trim();
  else if (/^[0-9a-fA-F]{6}$/.test(text.value.trim())) { text.value = "#" + text.value.trim(); color.value = text.value; }
}

let renderGen = 0;
let lastRouteKey = "";
async function render(opts = {}) {
  const gen = ++renderGen;
  ensureRanges();
  const r = route();
  const key = r.name + "/" + r.id;
  const keep = opts.keepScroll || (opts.refetch === false && key === lastRouteKey);
  const y = keep ? window.scrollY : 0;
  const routeChanged = key !== lastRouteKey;
  lastRouteKey = key;
  document.querySelectorAll("#nav [data-go]").forEach((btn) => {
    const on = btn.dataset.go === r.name;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  });
  const view = $("#view");
  if ((r.name === "qrcodes" || r.name === "links") && r.id) {
    if (!(opts.refetch === false && state.detail?.code?.slug === r.id)) {
      if (!keep) view.innerHTML = '<div class="card muted">Loading…</div>';
      try {
        const data = await api("/api/codes/" + encodeURIComponent(r.id));
        if (gen !== renderGen) return;
        state.detail = data;
      } catch (e) {
        if (gen !== renderGen) return;
        view.innerHTML = '<div class="card"><h2>Not found</h2><p>' + esc(e.message) + '</p><p><button class="btn ghost" type="button" data-go="home">Home</button></p></div>';
        return;
      }
    }
    if (routeChanged) { state.compareMode = "none"; state.compareSlug = ""; state.compareReady = false; }
    view.innerHTML = r.name === "links" ? detailHtml(false) : detailHtml(true);
    if (state.openCustomize && r.name === "qrcodes") { state.openCustomize = false; openCustomize(); }
  } else {
    state.detail = r.id ? state.detail : state.detail;
    view.innerHTML = pageFor(r);
  }
  if (state.focus) {
    const el = document.querySelector(state.focus);
    state.focus = "";
    if (el) el.focus();
  }
  requestAnimationFrame(() => window.scrollTo(0, routeChanged && !opts.keepScroll ? 0 : y));
}

async function onCreate() {
  const btn = $("#create-form button[type=submit]");
  btn.disabled = true;
  try {
    const url = $("#dest-url").value.trim();
    const slug = ($("#custom-slug")?.value || "").trim();
    const mode = state.createMode === "link" ? "link" : "qr";
    const body = { url, slug, type: mode };
    if (mode === "qr" && $("#also-link")?.checked) body.alsoLink = true;
    if (mode === "link") body.name = $("#link-title")?.value || "";
    if (!body.name) { try { body.name = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep blank */ } }
    const c = await api("/api/codes", { method: "POST", body: JSON.stringify(body) });
    state.codes = await api("/api/codes");
    state.draftUrl = "";
    state.alsoLink = false;
    toast("Created");
    go((c.hasQr ? "qrcodes/" : "links/") + c.slug);
  } catch (e) {
    const err = $("#create-error");
    if (err) err.textContent = e.message; else toast(e.message);
    btn.disabled = false;
  }
}
async function onTag(form) {
  const input = form.querySelector("input");
  const tag = input.value.trim();
  if (!tag || !state.detail) return;
  const tags = [...(state.detail.code.tags || []), tag];
  try { await patchCode(state.detail.code.slug, { tags }); render({ refetch: false, keepScroll: true }); }
  catch (e) { toast(e.message); }
}
async function onRule() {
  const kind = $("#rule-kind").value;
  const value = kind === "device" ? $("#rule-device").value : $("#rule-loc").value.trim();
  const url = $("#rule-url").value.trim();
  if (!value) { toast("Add a device or location"); return; }
  const rules = [...(state.detail.code.rules || []), { type: kind, value, url }];
  try { await patchCode(state.detail.code.slug, { rules }); toast("Rule added"); render({ refetch: false, keepScroll: true }); }
  catch (e) { toast(e.message); }
}
async function onEdit(form) {
  const data = Object.fromEntries(new FormData(form));
  try {
    await patchCode(state.detail.code.slug, { name: data.name, url: data.url, notes: data.notes });
    closeModal();
    toast("Saved");
    render({ refetch: false, keepScroll: true });
  } catch (e) { const err = $("#edit-error"); if (err) err.textContent = e.message; }
}
async function onCustomize(form) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const fg = $("#c-fg-text").value.trim();
    const bg = $("#c-bg-text").value.trim();
    await patchCode(state.detail.code.slug, { style: { fg, bg }, logoData: $("#c-logo-data").value });
    closeModal();
    toast("Customization saved");
    render({ refetch: false, keepScroll: true });
  } catch (e) { const err = $("#c-error"); if (err) err.textContent = e.message; btn.disabled = false; }
}
async function onBulk() {
  const lines = $("#bulk-text").value.split(/\n/).map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const also = $("#bulk-also").checked;
  const results = [];
  for (const line of lines) {
    const [url, name] = line.split(/[,\t]/).map((s) => (s || "").trim());
    try {
      const c = await api("/api/codes", { method: "POST", body: JSON.stringify({ url, name: name || "", type: "qr", alsoLink: also }) });
      results.push("Created /r/" + c.slug);
    } catch (e) { results.push(line + ": " + e.message); }
  }
  state.codes = await api("/api/codes");
  const box = $("#bulk-results");
  if (box) box.innerHTML = results.map((r) => "<div>" + esc(r) + "</div>").join("") || "<div>Add at least one URL.</div>";
  toast(results.length ? "Bulk create finished" : "Nothing to create");
}
async function onSettings(form) {
  const data = Object.fromEntries(new FormData(form));
  const fg = hexOk(data.defaultFgText) ? data.defaultFgText : data.defaultFg;
  const bg = hexOk(data.defaultBgText) ? data.defaultBgText : data.defaultBg;
  try {
    state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ workspaceName: data.workspaceName, defaultFg: fg, defaultBg: bg }) });
    $("#brand-name").textContent = state.settings.workspaceName || "Liberty";
    $("#account-label").innerHTML = "<strong>" + esc(state.settings.workspaceName) + "</strong><div class='muted small'>Admin session</div>";
    toast("Saved");
    render({ refetch: false, keepScroll: true });
  } catch (e) { toast(e.message); }
}
async function moveRule(index, dir) {
  const rules = [...(state.detail.code.rules || [])];
  const next = index + dir;
  if (next < 0 || next >= rules.length) return;
  const [row] = rules.splice(index, 1);
  rules.splice(next, 0, row);
  await patchCode(state.detail.code.slug, { rules });
  render({ refetch: false, keepScroll: true });
}
async function downloadPng() {
  const c = state.detail.code;
  const canvas = document.createElement("canvas");
  const logo = c.logoData ? await loadImage(c.logoData) : null;
  drawQr(canvas, c.slug, styleOf(c), logo);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  downloadBlob(c.slug + ".png", blob);
}
function downloadSvg() {
  const c = state.detail.code;
  const svg = qrSvg(c.slug, styleOf(c), c.logoData || "");
  downloadBlob(c.slug + ".svg", new Blob([svg], { type: "image/svg+xml" }));
}
function downloadCsv() {
  const model = currentModel();
  if (!model) return;
  downloadBlob(model.slug + "-analytics.csv", new Blob([toCsv(model)], { type: "text/csv" }));
}
function downloadWorkspaceCsv() {
  const model = workspaceModel(state.analyticsFrom, state.analyticsTo).all;
  model.from = state.analyticsFrom;
  model.to = state.analyticsTo;
  model.channel = "engagements";
  const lines = [["metric", "engagements", model.total], ["metric", "from", model.from], ["metric", "to", model.to]];
  for (const row of model.series) lines.push(["day", row.date, row.value]);
  for (const [dim, map] of [["country", model.country], ["city", model.city], ["browser", model.browser], ["os", model.os], ["device", model.device]]) {
    for (const [k, n] of Object.entries(map)) lines.push([dim, k, n]);
  }
  downloadBlob("analytics.csv", new Blob([lines.map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv" }));
}

async function handleAction(el) {
  const act = el.dataset.act;
  if (act !== "toggle-menu" && act !== "toggle-dates" && act !== "toggle-rule") {
    document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
  }
  if (act === "logout") {
    await api("/api/auth", { method: "DELETE" });
    state.codes = [];
    state.detail = null;
    showLogin();
    return;
  }
  if (act === "mode") {
    state.draftUrl = $("#dest-url")?.value || "";
    state.alsoLink = !!$("#also-link")?.checked;
    state.createMode = el.dataset.mode === "link" ? "link" : "qr";
    state.focus = "#dest-url";
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "home-range") { state.homeRange = el.dataset.range; render({ refetch: false, keepScroll: true }); return; }
  if (act === "toggle-dates") { $("#date-pop")?.classList.toggle("hidden"); return; }
  if (act === "preset") {
    const keys = lastN(Number(el.dataset.days));
    const from = $("#from-date"), to = $("#to-date");
    if (from && to) { from.value = keys[0]; to.value = keys.at(-1); }
    return;
  }
  if (act === "apply-dates") {
    const from = $("#from-date")?.value, to = $("#to-date")?.value;
    if (!from || !to) return;
    const a = from <= to ? from : to, b = from <= to ? to : from;
    if (el.dataset.target === "analytics") { state.analyticsFrom = a; state.analyticsTo = b; }
    else { state.detailFrom = a; state.detailTo = b; }
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "loc-tab") { state.locTab = el.dataset.tab === "cities" ? "cities" : "countries"; render({ refetch: false, keepScroll: true }); return; }
  if (act === "toggle-menu") {
    const menu = $("#menu-" + el.dataset.menu);
    if (!menu) return;
    const open = menu.classList.contains("hidden");
    document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
    if (open) menu.classList.remove("hidden");
    return;
  }
  if (act === "toggle-rule") { $("#rule-form")?.classList.toggle("hidden"); return; }
  if (act === "customize-latest") {
    const code = state.codes.find((c) => c.hasQr);
    if (!code) { toast("Create a QR code first"); return; }
    state.openCustomize = true;
    go("qrcodes/" + code.slug);
    return;
  }
  if (act === "bulk") { openBulk(); return; }
  if (act === "close-modal") { closeModal(); return; }
  if (!state.detail?.code && !["close-modal", "pick-compare"].includes(act) && route().name !== "analytics") {
    if (act === "dl-workspace-csv") { downloadWorkspaceCsv(); return; }
  }
  if (act === "dl-workspace-csv") { downloadWorkspaceCsv(); return; }
  const code = state.detail?.code;
  if (!code && act !== "pick-compare") return;
  if (act === "edit") return openEdit();
  if (act === "customize") return openCustomize();
  if (act === "copy-link") return copyText(shortUrl(code.slug));
  if (act === "pause") { await patchCode(code.slug, { paused: !code.paused }); toast(code.paused ? "Resumed" : "Paused"); render({ refetch: false, keepScroll: true }); return; }
  if (act === "del") {
    openModal("<h2>Delete this code?</h2><p>Printed QR codes and the short link /r/" + esc(code.slug) + ' will stop working.</p><div class="row end"><button class="btn ghost" type="button" data-act="close-modal">Cancel</button><button class="btn danger" type="button" data-act="confirm-del">Delete</button></div>');
    return;
  }
  if (act === "confirm-del") {
    const slug = state.detail.code.slug;
    const qr = route().name !== "links";
    await api("/api/codes/" + encodeURIComponent(slug), { method: "DELETE" });
    closeModal();
    state.codes = state.codes.filter((c) => c.slug !== slug);
    state.detail = null;
    toast("Deleted");
    go(qr ? "qrcodes" : "links");
    return;
  }
  if (act === "del-tag") {
    const tags = (code.tags || []).filter((t) => t !== el.dataset.tag);
    await patchCode(code.slug, { tags });
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "make-link") { await patchCode(code.slug, { hasLink: true }); toast("Short link created"); render({ refetch: false, keepScroll: true }); return; }
  if (act === "make-qr") { await patchCode(code.slug, { hasQr: true }); toast("QR code created"); go("qrcodes/" + code.slug); return; }
  if (act === "rule-up") return moveRule(Number(el.dataset.i), -1);
  if (act === "rule-down") return moveRule(Number(el.dataset.i), 1);
  if (act === "rule-del") {
    const rules = (code.rules || []).filter((_, i) => i !== Number(el.dataset.i));
    await patchCode(code.slug, { rules });
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "dl-png") return downloadPng().catch((e) => toast(e.message));
  if (act === "dl-svg") return downloadSvg();
  if (act === "dl-csv") return downloadCsv();
  if (act === "compare-pick") return openCompare(el.dataset.kind || "qr");
  if (act === "pick-compare") {
    state.compareMode = "code";
    state.compareSlug = el.dataset.slug;
    state.compareReady = false;
    state.compareStats = null;
    closeModal();
    render({ refetch: false, keepScroll: true });
    try {
      const data = await api("/api/codes/" + encodeURIComponent(el.dataset.slug));
      if (state.compareSlug === el.dataset.slug) { state.compareStats = data.stats; state.compareReady = true; render({ refetch: false, keepScroll: true }); }
    } catch (e) { toast(e.message); }
    return;
  }
  if (act === "clear-logo") { const input = $("#c-logo-data"); if (input) { input.value = ""; paintCustomize(); } }
}

function paintSearch() {
  const box = $("#search-results");
  const q = state.search.toLowerCase();
  if (!q) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const hits = state.codes.filter((c) => [c.name, c.slug, c.url, ...(c.tags || [])].join(" ").toLowerCase().includes(q)).slice(0, 8);
  box.classList.remove("hidden");
  box.innerHTML = hits.map((c) => '<button type="button" data-go="' + (c.hasQr ? "qrcodes/" : "links/") + encodeURIComponent(c.slug) + '"><strong>' + esc(c.name || c.slug) + '</strong><span class="muted small">' + (c.hasQr ? "QR code" : "Short link") + " · /r/" + esc(c.slug) + "</span></button>").join("") || '<div class="muted pad">No matches</div>';
}

document.body.addEventListener("click", (e) => {
  const popOpener = e.target.closest("[data-pop]");
  if (popOpener) { togglePop(popOpener.dataset.pop); return; }
  if (e.target.closest("#menu-btn")) { setSidebar(!$("#sidebar").classList.contains("open")); return; }
  if (e.target.id === "overlay") { setSidebar(false); return; }
  if (e.target.id === "slug-toggle") { $("#slug-wrap")?.classList.toggle("hidden"); return; }
  const goEl = e.target.closest("[data-go]");
  const actEl = e.target.closest("[data-act]");
  if (!e.target.closest(".pop") && !e.target.closest(".menu-wrap") && !e.target.closest(".range-wrap") && !e.target.closest(".search")) {
    document.querySelectorAll(".menu,#date-pop").forEach((m) => m.classList.add("hidden"));
    closePops();
  }
  if (goEl) {
    if (goEl.dataset.mode) state.createMode = goEl.dataset.mode === "link" ? "link" : "qr";
    if (goEl.dataset.focus) state.focus = goEl.dataset.focus;
    go(goEl.dataset.go);
    return;
  }
  if (actEl) handleAction(actEl).catch((err) => toast(err.message));
});
document.body.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.act) return;
  e.preventDefault();
  const act = form.dataset.act;
  const run = act === "create" ? onCreate : act === "save-rule" ? onRule : act === "add-tag" ? () => onTag(form) : act === "save-edit" ? () => onEdit(form) : act === "save-customize" ? () => onCustomize(form) : act === "save-bulk" ? onBulk : act === "save-settings" ? () => onSettings(form) : null;
  if (run) Promise.resolve(run()).catch((err) => toast(err.message));
});
document.body.addEventListener("change", (e) => {
  if (e.target.id === "compare-select") {
    state.compareMode = e.target.value === "prev" ? "prev" : e.target.value === "code" ? "code" : "none";
    if (state.compareMode !== "code") { state.compareSlug = ""; state.compareReady = false; }
    render({ refetch: false, keepScroll: true });
  }
  if (e.target.id === "rule-kind") {
    $("#rule-device-wrap")?.classList.toggle("hidden", e.target.value !== "device");
    $("#rule-loc-wrap")?.classList.toggle("hidden", e.target.value !== "location");
  }
  if (e.target.id === "c-fg" || e.target.id === "c-fg-text") { syncColorPair("#c-fg", "#c-fg-text", e.target); paintCustomize(); }
  if (e.target.id === "c-bg" || e.target.id === "c-bg-text") { syncColorPair("#c-bg", "#c-bg-text", e.target); paintCustomize(); }
  if (e.target.id === "c-file" && e.target.files?.[0]) {
    fileToLogo(e.target.files[0]).then((url) => { $("#c-logo-data").value = url; paintCustomize(); }).catch((err) => { const box = $("#c-error"); if (box) box.textContent = err.message; else toast(err.message); });
  }
  if (e.target.name === "defaultFg" || e.target.name === "defaultFgText") syncColorPair("[name=defaultFg]", "[name=defaultFgText]", e.target);
  if (e.target.name === "defaultBg" || e.target.name === "defaultBgText") syncColorPair("[name=defaultBg]", "[name=defaultBgText]", e.target);
});
document.body.addEventListener("input", (e) => {
  if (e.target.id === "c-fg-text" || e.target.id === "c-bg-text") {
    if (e.target.id === "c-fg-text") syncColorPair("#c-fg", "#c-fg-text", e.target);
    else syncColorPair("#c-bg", "#c-bg-text", e.target);
    paintCustomize();
  }
});
$("#search").addEventListener("input", () => {
  state.search = $("#search").value.trim();
  paintSearch();
  const name = route().name;
  if (name === "links" || name === "qrcodes") render({ refetch: false, keepScroll: true });
});
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.textContent = "";
  try {
    await api("/api/auth", { method: "POST", body: JSON.stringify({ password: $("#pw").value }) });
    await enter();
  } catch (ex) { err.textContent = ex.message; }
});
window.addEventListener("hashchange", () => { if (!$("#shell").classList.contains("hidden")) render(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closePops(); document.querySelectorAll(".menu,#date-pop").forEach((m) => m.classList.add("hidden")); } });

async function enter() {
  state.settings = await api("/api/settings");
  state.codes = await api("/api/codes");
  $("#boot").classList.add("hidden");
  $("#login").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  $("#brand-name").textContent = state.settings.workspaceName || "Liberty";
  $("#account-label").innerHTML = "<strong>" + esc(state.settings.workspaceName || "Liberty") + "</strong><div class='muted small'>Admin session</div>";
  ensureRanges();
  if (!location.hash || location.hash === "#") location.replace("#/home");
  else render();
}
async function boot() {
  try {
    const me = await api("/api/auth");
    if (!me.authenticated) return showLogin();
    await enter();
  } catch (e) { showLogin(e.message === "Unauthorized" ? "" : e.message); }
}
boot();
