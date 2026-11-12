import { CODE39_DEFAULTS, readLayout, validatePayload, parseBatch, code39Svg, safeAssetName, zipStore, printHtml } from "./code39.mjs";
import { countryGroupKey } from "./country.mjs";
import { paintTickets, ticketAction, ticketShell } from "./tickets-ui.mjs";

const PUBLIC_FALLBACK = "https://expresshelp.site";
const DEVICE_OPTIONS = [
  ["mobile", "Mobile"], ["tablet", "Tablet"], ["desktop", "Desktop"],
  ["ios", "iOS"], ["android", "Android"], ["windows", "Windows"],
  ["macos", "macOS"], ["chromeos", "ChromeOS"], ["linux", "Linux"],
];

const state = {
  codes: [],
  settings: { workspaceName: "Liberty", publicUrl: PUBLIC_FALLBACK, defaultFg: "#111827", defaultBg: "#ffffff" },
  detail: null,
  pages: [],
  pageDetail: null,
  pageDraft: null,
  competitions: [],
  compDetail: null,
  compDraft: null,
  compView: { period: "current", status: "all" },
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
  actor: { role: "head", siteIds: null, name: "Head office" },
  sites: [],
  staff: [],
  templates: [],
  posDrafts: [],
  posDraft: null,
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
  let name = parts[0] || "home";
  if (name === "campaigns") name = "competitions";
  return { name, id: parts[1] ? decodeURIComponent(parts[1]) : "" };
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
async function entraLoginState() {
  const box = $("#entra-setup");
  const link = $("#entra-signin");
  if (!box || !link) return;
  try {
    const status = await fetch("/api/identity/entra/status", { credentials: "same-origin" }).then((res) => res.json());
    const ret = "/admin" + (location.hash && /^#\/pos\/p[a-f0-9]{8}$/.test(location.hash) ? location.hash : "");
    link.href = "/api/identity/entra/start?returnTo=" + encodeURIComponent(ret);
    if (!status.configured) {
      link.hidden = true;
      box.textContent = "Microsoft sign-in is not operational. Add the single-tenant Entra tenant id, client id, client secret, session secret, and verified object-id role map. No account is granted from an email address.";
      return;
    }
    link.hidden = false;
    box.textContent = status.testIssuer ? "Local test issuer only. This is not the workplace tenant." : "Work account sign-in is configured. Access still depends on a verified object id.";
  } catch { box.textContent = "Microsoft sign-in is not operational."; }
}
function showLogin(message, focusEmail) {
  $("#boot").classList.add("hidden");
  $("#shell").classList.add("hidden");
  $("#login").classList.remove("hidden");
  const err = $("#login-error");
  if (err) err.textContent = message || "";
  entraLoginState();
  Promise.resolve(otpLoginState()).then(() => {
    if (!focusEmail) return;
    document.getElementById("otp-card")?.scrollIntoView({ block: "center" });
    document.getElementById("otp-email")?.focus();
  });
}
function paintAvatar() {
  const name = String(state.actor?.name || state.settings?.workspaceName || "Liberty").trim();
  const letter = (name.match(/[A-Za-z0-9]/) || ["L"])[0].toUpperCase();
  const avatar = document.querySelector(".avatar");
  if (avatar) avatar.textContent = letter;
}
async function otpLoginState() {
  const box = $("#otp-setup");
  const form = $("#otp-form");
  const mock = $("#otp-mock");
  if (!box || !form) return;
  try {
    const status = await fetch("/api/identity/otp/status", { credentials: "same-origin" }).then((res) => res.json());
    if (!status.operational) {
      form.hidden = true;
      box.textContent = status.setup || "Email codes are not operational. No code is sent.";
      return;
    }
    form.hidden = false;
    if (mock) mock.hidden = !status.mock;
    box.textContent = "A code works only for an address on the explicit allowlist. The email domain does not grant access.";
  } catch { box.textContent = "Email codes are not operational."; }
}
async function submitOtp(event) {
  event.preventDefault();
  const error = $("#otp-error");
  const status = $("#otp-status");
  if (error) error.textContent = "";
  const email = $("#otp-email")?.value || "";
  const codeWrap = $("#otp-code-wrap");
  const code = $("#otp-code")?.value || "";
  const verifying = codeWrap && !codeWrap.hidden && code.trim();
  const path = verifying ? "/api/identity/otp/verify" : "/api/identity/otp/start";
  const body = verifying ? { email, code } : { email };
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!verifying) {
    if (!response.ok) {
      if (error) error.textContent = payload.error || "Email codes are not operational.";
      return;
    }
    if (status) status.textContent = payload.message || "";
    if (codeWrap) codeWrap.hidden = false;
    const verify = $("#otp-verify");
    if (verify) verify.hidden = false;
    $("#otp-code")?.focus();
    return;
  }
  if (!response.ok) {
    if (error) error.textContent = payload.error || "That code was not accepted.";
    return;
  }
  state.actor = { authenticated: true, ...(payload.identity || {}), role: payload.role };
  await enter();
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
      for (const [name, n] of Object.entries(days?.[key]?.[ch]?.[dim] || {})) {
        const bucket = dim === "country" ? countryGroupKey(name) : name;
        out[bucket] = (out[bucket] || 0) + n;
      }
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
function viewSources() { return [...(state.pages || []), ...(state.competitions || [])]; }
function pageHits(keys) {
  return viewSources().reduce((n, p) => n + keys.reduce((s, day) => s + (Number(p.daily?.[day]) || 0), 0), 0);
}
function pageSeries(keys) {
  return keys.map((date) => ({ date, value: viewSources().reduce((s, p) => s + (Number(p.daily?.[date]) || 0), 0) }));
}
function countryLabel(key) {
  const code = countryGroupKey(key);
  if (!code || code === "Unknown") return "Unknown";
  if (/^[A-Z]{2}$/.test(code)) {
    try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch { return code; }
  }
  return code;
}
function flagFor(key) {
  const code = countryGroupKey(key);
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
  const pageNow = pageHits(keys);
  const pagePrev = pageHits(prev);
  const engagements = sumChannel(state.codes, keys, "all") + pageNow;
  const prevEng = sumChannel(state.codes, prev, "all") + pagePrev;
  const clicks = sumChannel(state.codes, keys, "click");
  const prevClicks = sumChannel(state.codes, prev, "click");
  const scans = sumChannel(state.codes, keys, "scan");
  const prevScans = sumChannel(state.codes, prev, "scan");
  const series = keys.map((date, i) => ({ date, value: state.codes.reduce((s, c) => s + bucketN(c.days, date, "all"), 0) + pageSeries(keys)[i].value }));
  const compare = prev.map((date, i) => ({ date, value: state.codes.reduce((s, c) => s + bucketN(c.days, date, "all"), 0) + pageSeries(prev)[i].value }));
  const dEng = metricDelta(engagements, prevEng);
  const dClick = metricDelta(clicks, prevClicks);
  const dScan = metricDelta(scans, prevScans);
  const dPage = metricDelta(pageNow, pagePrev);
  const label = n === 1 ? "last 1 day" : "last " + n + " days";
  const rangeLabel = keys.length === 1 ? shortDate(keys[0]) : shortDate(keys[0]) + " – " + shortDate(keys.at(-1));
  const prevLabel = prev.length === 1 ? shortDate(prev[0]) : shortDate(prev[0]) + " – " + shortDate(prev.at(-1));
  const items = checklist();
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  return remindersHtml() + siteOverviewHtml() + '<div class="mode-toggle" data-testid="mode-toggle"><div class="seg">' +
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
    '<div><div class="metric-label">Page clicks</div><div class="metric-value" data-testid="page-clicks">' + num(pageNow) + ' <span class="delta ' + dPage.cls + '">' + dPage.text + "</span></div></div></div>" +
    '<div class="row end" style="margin-top:12px"><button class="btn ghost" type="button" data-go="analytics">Explore Analytics →</button></div></div>' +
    '<div class="card" style="margin-top:16px"><div class="card-head"><h2>Do more with Liberty</h2><div class="ring-wrap">' + pct + "%" + ring(pct) + "</div></div>" +
    items.map((item) => '<div class="check-item"><div class="dot' + (item.done ? " on" : "") + '">' + (item.done ? "✓" : "") + '</div><div><strong>' + esc(item.title) + '</strong><div class="muted small">' + esc(item.body) + "</div></div></div>").join("") +
    "</div>";
}
function siteName(id) {
  if (!id) return "Unassigned";
  return (state.sites || []).find((site) => site.id === id)?.name || "Unassigned";
}
function siteOptions(selected) {
  const head = state.actor?.role === "head";
  const sites = state.sites || [];
  const blank = head ? '<option value=""' + (!selected ? " selected" : "") + ">Unassigned</option>" : "";
  return blank + sites.map((site) => '<option value="' + esc(site.id) + '"' + (site.id === selected ? " selected" : "") + ">" + esc(site.name) + "</option>").join("");
}
function remindersHtml() {
  const items = (state.competitions || []).flatMap((comp) => comp.reminders || []);
  if (!items.length) return "";
  const label = { "upcoming-draw": "Draw coming up", "overdue-draw": "Draw overdue", closing: "Closing soon", "past-close": "Past closing date" };
  return '<div class="card" data-testid="reminders"><div class="card-head"><h2>Draw reminders</h2><p class="muted small">Australia/Melbourne. These stay in the admin.</p></div>' +
    items.map((item) => '<a class="rule" href="' + esc(item.href) + '"><strong>' + esc(label[item.kind] || item.kind) + "</strong> " + esc(item.name) + ' <span class="muted">' + esc(item.date) + "</span></a>").join("") + "</div>";
}
function siteOverviewHtml() {
  const groups = new Map();
  const add = (siteId, kind) => {
    const key = siteId || "";
    if (!groups.has(key)) groups.set(key, { codes: 0, pages: 0, competitions: 0 });
    groups.get(key)[kind] += 1;
  };
  for (const code of state.codes || []) add(code.siteId, "codes");
  for (const page of state.pages || []) add(page.siteId, "pages");
  for (const comp of state.competitions || []) add(comp.siteId, "competitions");
  if (state.actor?.role !== "head") groups.delete("");
  const cards = [...groups.entries()].map(([id, counts]) => '<button type="button" class="metric-card" data-go="sites" data-testid="site-card"><strong>' + esc(siteName(id)) + '</strong><span class="muted small">' + counts.codes + " codes · " + counts.pages + " pages · " + counts.competitions + " competitions</span></button>").join("");
  if (!cards && !(state.sites || []).length) return '<div class="card" data-testid="site-overview"><h2>Sites</h2><p class="muted">No sites yet. Head office can add locations without moving existing records.</p></div>';
  return '<div class="card" data-testid="site-overview"><div class="card-head"><h2>' + (state.actor?.role === "head" ? "All sites" : "Your sites") + '</h2><button class="btn ghost" type="button" data-go="sites">Open</button></div><div class="metrics">' + cards + "</div></div>";
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
    kv("Site", esc(siteName(code.siteId))) +
    kv("Link check", esc(code.health?.status || state.detail?.health?.status || "unchecked") + (code.health?.checkedAt || state.detail?.health?.checkedAt ? " · " + esc(code.health?.checkedAt || state.detail?.health?.checkedAt) : "")) +
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
    '<button class="btn ghost wide" type="button" data-act="code-poster" data-size="a4">A4 poster</button>' +
    '<button class="btn ghost wide" type="button" data-act="check-link">Check destination</button>' +
    (code.hasLink ? '<a class="btn ghost wide" href="#/links/' + encodeURIComponent(code.slug) + '">View short link</a>' : '<button class="btn ghost wide" type="button" data-act="make-link">+ Create short link</button>') +
    "</div>";
}
function linkSide(code) {
  if (code.hasQr) {
    return '<div class="card" data-testid="qr-preview"><div class="qr-stage">' + qrSvg(code.slug, styleOf(code), code.logoData || "") + "</div>" +
      '<button class="text-btn" type="button" data-act="customize">Customize</button>' +
      '<button class="btn ghost wide" type="button" data-act="check-link">Check destination</button>' +
      '<a class="btn ghost wide" href="#/qrcodes/' + encodeURIComponent(code.slug) + '">View QR code</a></div>';
  }
  return '<div class="card empty"><div class="empty-mark">L</div><h2>No QR code yet</h2><p class="muted">Create one that points at this same short link.</p><button class="btn" type="button" data-act="make-qr">Create QR code</button><button class="btn ghost wide" type="button" data-act="check-link">Check destination</button></div>';
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
    for (const [k, n] of Object.entries(src[dim] || {})) {
      const bucket = dim === "country" ? countryGroupKey(k) : k;
      into[dim][bucket] = (into[dim][bucket] || 0) + n;
    }
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
  const breakdownTotal = model.all.total;
  const pagesNow = pageHits(keys);
  const pagesPrev = pageHits(prev);
  const dPages = metricDelta(pagesNow, pagesPrev);
  model.all.total += pagesNow;
  prevModel.all.total += pagesPrev;
  const pageLine = pageSeries(keys);
  const prevPageLine = pageSeries(prev);
  model.all.series = model.all.series.map((row, i) => ({ date: row.date, value: row.value + pageLine[i].value }));
  prevModel.all.series = prevModel.all.series.map((row, i) => ({ date: row.date, value: row.value + (prevPageLine[i]?.value || 0) }));
  const dAll = metricDelta(model.all.total, prevModel.all.total);
  const ranked = (channel) => state.codes.map((c) => ({ ...c, count: c.days ? rangeKeys(from, to).reduce((s, day) => s + bucketN(c.days, day, channel), 0) : 0 })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 8);
  return '<div class="page-head"><h1>Analytics</h1><button class="btn ghost" type="button" data-act="dl-workspace-csv">Download CSV</button></div>' +
    '<div class="card"><div class="toolbar"><div class="range-wrap"><button class="btn ghost" type="button" data-act="toggle-dates">' + esc(longDate(from) + " → " + longDate(to)) + "</button>" + datePop("analytics", from, to) + "</div></div>" +
    '<div class="metrics four"><div><div class="metric-label">Total engagements</div><div class="metric-value">' + num(model.all.total) + ' <span class="delta ' + dAll.cls + '">' + dAll.text + "</span></div></div>" +
    '<div><div class="metric-label">Link clicks</div><div class="metric-value">' + num(model.click.total) + "</div></div>" +
    '<div><div class="metric-label">QR Code scans</div><div class="metric-value">' + num(model.scan.total) + "</div></div>" +
    '<div><div class="metric-label">Page clicks</div><div class="metric-value">' + num(pagesNow) + ' <span class="delta ' + dPages.cls + '">' + dPages.text + "</span></div></div></div>" +
    areaChart(model.all.series, prevModel.all.series) +
    '<div class="legend"><span><i class="swatch"></i> This period</span><span><i class="swatch alt"></i> Previous period</span></div></div>' +
    '<div class="split"><div class="card"><h2>Top links</h2><div class="table-wrap">' + topTable(ranked("click").filter((c) => c.hasLink), "Clicks") + '</div></div><div class="card"><h2>Top QR codes</h2><div class="table-wrap">' + topTable(ranked("scan").filter((c) => c.hasQr), "Scans") + "</div></div></div>" +
    '<div class="split"><div class="card" data-testid="by-location"><div class="card-head"><h2>By location</h2><div class="tabs"><button type="button" data-act="loc-tab" data-tab="countries" class="' + (state.locTab !== "cities" ? "on" : "") + '">Countries</button><button type="button" data-act="loc-tab" data-tab="cities" class="' + (state.locTab === "cities" ? "on" : "") + '">Cities</button></div></div><div class="table-wrap">' + dimTable(state.locTab === "cities" ? model.all.city : model.all.country, breakdownTotal, state.locTab === "cities" ? "City" : "Country", "Engagements") + '</div></div>' +
    '<div class="card" data-testid="by-browser"><h2>By browser</h2><div class="table-wrap">' + dimTable(model.all.browser, breakdownTotal, "Browser", "Engagements") + "</div></div></div>" +
    '<div class="card" data-testid="by-os"><h2>By operating system</h2><div class="table-wrap">' + dimTable(model.all.os, breakdownTotal, "Operating system", "Engagements") + "</div></div>";
}
function domainsPage() {
  return '<div class="page-head"><h1>Custom domains</h1></div><div class="card"><div class="card-head"><h2>' + esc(host()) + '</h2><span class="badge ok">Active</span></div><p>Primary domain for every short link and QR code.</p><p class="break"><strong>' + esc(base()) + "/r/&lt;slug&gt;</strong></p></div>" +
    '<div class="card"><h2>Adding another domain</h2><p class="muted">Extra hostnames are attached in Netlify and at your DNS host. This admin does not sell or provision domains.</p>' +
    '<div class="table-wrap"><table><thead><tr><th>Type</th><th>Host</th><th>Value</th></tr></thead><tbody>' +
    "<tr><td>A</td><td>@</td><td>75.2.60.5</td></tr><tr><td>CNAME</td><td>www</td><td>liberty-qr-353.netlify.app</td></tr>" +
    "</tbody></table></div></div>";
}
function settingsPage() {
  const s = state.settings;
  return '<div class="page-head"><h1>Settings</h1></div><form class="card" data-act="save-settings"><label class="field"><span>Workspace name</span><input name="workspaceName" type="text" maxlength="40" value="' + esc(s.workspaceName) + '"></label>' +
    '<div class="split"><label class="field"><span>Default QR foreground</span><span class="color-row"><input name="defaultFg" type="color" value="' + esc(s.defaultFg) + '"><input name="defaultFgText" type="text" value="' + esc(s.defaultFg) + '"></span></label>' +
    '<label class="field"><span>Default QR background</span><span class="color-row"><input name="defaultBg" type="color" value="' + esc(s.defaultBg) + '"><input name="defaultBgText" type="text" value="' + esc(s.defaultBg) + '"></span></label></div>' +
    '<label class="field"><span>Public URL</span><input type="text" readonly value="' + esc(s.publicUrl) + '"></label>' +
    '<p class="muted small">Short links stay on ' + esc(base()) + "/r/&lt;slug&gt;. The admin password is the ADMIN_PASSWORD environment variable and is not changed here. This session cookie lasts 7 days.</p>" +
    '<div class="row"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="logout">Log out</button></div></form>' + staffSettings();
}
const PAGE_COLORS = [
  ["background", "Background"],
  ["text", "Text"],
  ["accent", "Accent"],
  ["button", "Button"],
  ["buttonText", "Button text"],
];
const FIELD_TYPES = [["text", "Text"], ["email", "Email"], ["phone", "Phone"], ["dropdown", "Dropdown"], ["checkbox", "Checkbox"], ["textarea", "Text area"]];
function blankPage() {
  return {
    slug: "", name: "", title: "", heading: "", body: "", heroUrl: "", heroData: "",
    buttonLabel: "", buttonUrl: "",
    colors: { background: "#f4f6fb", text: "#1c2434", accent: "#0e1b4d", button: "#1f4bdb", buttonText: "#ffffff" },
    fields: [
      { id: "name", type: "text", label: "Name", required: true, options: [] },
      { id: "email", type: "email", label: "Email", required: true, options: [] },
    ],
    submitLabel: "Send", thankYou: "Thanks, we have your message.", status: "draft", codeSlug: "",
  };
}
function pagesList() {
  const q = state.search.toLowerCase();
  const rows = (state.pages || []).filter((p) => !q || [p.name, p.slug, p.title, p.heading].join(" ").toLowerCase().includes(q));
  const body = rows.map((p) => '<tr class="clickable" data-go="pages/' + encodeURIComponent(p.slug) + '"><td><strong>' + esc(p.name || p.slug) + '</strong><div class="muted small">/p/' + esc(p.slug) + '</div></td><td class="break">' + esc(base() + "/p/" + p.slug) + '</td><td>' + (p.status === "published" ? '<span class="badge ok">Published</span>' : '<span class="badge muted">Draft</span>') + '</td><td class="num">' + num(p.submissions || 0) + '</td><td>' + esc(formatCreated(p.created)) + "</td></tr>").join("");
  return '<div class="page-head"><h1>Pages</h1><button class="btn" type="button" data-go="pages/new">Create page</button></div><div class="card table-wrap" data-testid="pages-list">' +
    (rows.length ? "<table><thead><tr><th>Name</th><th>Public URL</th><th>Status</th><th class='num'>Submissions</th><th>Created</th></tr></thead><tbody>" + body + "</tbody></table>" : '<div class="empty"><div class="empty-mark">L</div><h2>No pages yet</h2><p class="muted">' + (state.search ? "No matches for that search." : "Create a landing page to collect a form on expresshelp.site.") + "</p></div>") + "</div>";
}
function capturePageDraft() {
  const form = document.getElementById("page-editor");
  const d = state.pageDraft;
  if (!form || !d) return;
  const val = (name) => form.querySelector('[name="' + name + '"]')?.value ?? "";
  d.name = val("name");
  d.title = val("title");
  d.heading = val("heading");
  d.body = val("body");
  d.heroUrl = val("heroUrl");
  d.heroData = val("heroData");
  d.buttonLabel = val("buttonLabel");
  d.buttonUrl = val("buttonUrl");
  d.submitLabel = val("submitLabel") || "Send";
  d.thankYou = val("thankYou");
  if (!d.slug) d.slugInput = val("slug");
  d.colors = { ...d.colors };
  for (const [key] of PAGE_COLORS) {
    const color = form.querySelector('[name="color-' + key + '"]')?.value;
    if (hexOk(color)) d.colors[key] = color;
  }
  d.fields = (d.fields || []).map((f) => {
    const card = form.querySelector('[data-field="' + f.id + '"]');
    if (!card) return f;
    const options = card.querySelector('[name="options"]')?.value || "";
    return {
      ...f,
      label: card.querySelector('[name="label"]')?.value ?? f.label,
      required: !!card.querySelector('[name="required"]')?.checked,
      options: f.type === "dropdown" ? options.split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
  });
}
function fieldCard(f) {
  const options = f.type === "dropdown" ? '<label class="field"><span>Options, comma separated</span><input name="options" value="' + esc((f.options || []).join(", ")) + '"></label>' : "";
  return '<div class="field-card" data-field="' + esc(f.id) + '"><div class="row"><strong>' + esc(FIELD_TYPES.find((t) => t[0] === f.type)?.[1] || f.type) + '</strong><span class="grow"></span>' +
    '<button class="btn ghost" type="button" data-act="field-up" data-id="' + esc(f.id) + '">↑</button>' +
    '<button class="btn ghost" type="button" data-act="field-down" data-id="' + esc(f.id) + '">↓</button>' +
    '<button class="btn ghost" type="button" data-act="remove-field" data-id="' + esc(f.id) + '">Remove</button></div>' +
    '<label class="field"><span>Label</span><input name="label" maxlength="80" value="' + esc(f.label) + '"></label>' + options +
    '<label class="check"><input name="required" type="checkbox"' + (f.required ? " checked" : "") + "> Required</label></div>";
}
function pageEditor() {
  const d = state.pageDraft || blankPage();
  const code = d.codeSlug ? codeBySlug(d.codeSlug) : null;
  const colors = PAGE_COLORS.map(([key, label]) => '<label class="field"><span>' + label + '</span><span class="color-row"><input type="color" name="color-' + key + '" value="' + esc(d.colors[key]) + '"><input type="text" value="' + esc(d.colors[key]) + '" data-color-text="' + key + '"></span></label>').join("");
  const heroSrc = d.heroData || d.heroUrl;
  const linked = !d.slug ? '<p class="muted">Save the page before creating a QR code or short link.</p>' : '<div class="row">' +
    (code?.hasQr ? '<a class="btn ghost" href="#/qrcodes/' + encodeURIComponent(code.slug) + '">View QR code</a>' : '<button class="btn ghost" type="button" data-act="page-qr">Create QR code</button>') +
    (code?.hasLink ? '<a class="btn ghost" href="#/links/' + encodeURIComponent(code.slug) + '">View short link</a>' : '<button class="btn ghost" type="button" data-act="page-link">Create short link</button>') +
    "</div>" + (code ? '<p class="muted small break">' + esc(shortUrl(code.slug)) + " → " + esc(base() + "/p/" + d.slug) + "</p>" : "");
  const views = pageAnalytics();
  return '<div class="page-head"><button class="icon-btn" type="button" data-go="pages" aria-label="Back">←</button><h1>' + esc(d.name || "New page") + "</h1>" +
    (d.slug ? (d.status === "published" ? '<span class="badge ok">Published</span>' : '<span class="badge muted">Draft</span>') : "") + "</div>" +
    '<form id="page-editor" data-act="save-page" data-testid="page-editor">' +
    '<div class="card"><div class="card-head"><h2>Content</h2></div>' +
    '<label class="field"><span>Name</span><input name="name" required maxlength="140" value="' + esc(d.name) + '"></label>' +
    (d.slug ? '<p class="break" data-testid="page-url"><strong>' + esc(base() + "/p/" + d.slug) + "</strong></p>" : '<label class="field"><span>Slug (optional)</span><input name="slug" maxlength="41" placeholder="auto-generated" value="' + esc(d.slugInput || "") + '"></label>') +
    '<label class="field"><span>Title</span><input name="title" maxlength="140" value="' + esc(d.title) + '" placeholder="Browser title"></label>' +
    '<label class="field"><span>Heading</span><input name="heading" maxlength="180" value="' + esc(d.heading) + '"></label>' +
    '<label class="field"><span>Body</span><textarea name="body" maxlength="8000">' + esc(d.body) + "</textarea></label>" +
    '<label class="field"><span>Hero image URL</span><input name="heroUrl" type="url" value="' + esc(d.heroUrl) + '" placeholder="https://…"></label>' +
    '<input type="hidden" name="heroData" value="' + esc(d.heroData || "") + '">' +
    '<label class="field"><span>Or upload a logo / hero image</span><input id="hero-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>' +
    (heroSrc ? '<div class="row"><img id="hero-preview" alt="" src="' + esc(heroSrc) + '" style="width:72px;height:72px;object-fit:contain;border-radius:12px;background:#fff"><button class="btn ghost" type="button" data-act="clear-hero">Remove upload</button></div>' : '<img id="hero-preview" alt="" hidden>') +
    '<div class="split"><label class="field"><span>Button label</span><input name="buttonLabel" maxlength="40" value="' + esc(d.buttonLabel) + '"></label><label class="field"><span>Button URL</span><input name="buttonUrl" type="url" value="' + esc(d.buttonUrl) + '" placeholder="https://…"></label></div>' +
    '<div class="split">' + colors + "</div></div>" +
    '<div class="card"><div class="card-head"><h2>Form</h2></div><p class="muted">Text, email, phone, dropdown, checkbox, and text area. Required fields must be filled before a submission is stored.</p>' +
    (d.fields || []).map(fieldCard).join("") +
    '<div class="row" style="margin-top:12px"><select id="new-field-type" aria-label="Field type">' + FIELD_TYPES.map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") + '</select><button class="btn ghost" type="button" data-act="add-field">Add field</button></div>' +
    '<label class="field"><span>Submit button text</span><input name="submitLabel" maxlength="40" value="' + esc(d.submitLabel || "Send") + '"></label>' +
    '<label class="field"><span>Thank-you message</span><textarea name="thankYou" maxlength="1000">' + esc(d.thankYou) + "</textarea></label></div>" +
    '<div class="row"><button class="btn" type="submit">Save</button>' +
    (d.slug ? '<button class="btn ghost" type="button" data-act="publish-page">' + (d.status === "published" ? "Unpublish" : "Publish") + '</button><button class="btn danger" type="button" data-act="del-page">Delete</button>' : "") +
    '<p class="err" id="page-error"></p></div></form>' +
    '<div class="card"><div class="card-head"><h2>Settings</h2></div>' +
    (d.slug && d.status === "published" ? '<p><a href="' + esc(base() + "/p/" + d.slug) + '" target="_blank" rel="noreferrer">Open public page</a></p>' : '<p class="muted">Draft pages are not publicly reachable.</p>') +
    "<h2>QR code and short link</h2><p class=\"muted\">Optional. Both point at this page’s public URL.</p>" + linked + "</div>" +
    submissionsBlock() + views;
}
function submissionsBlock() {
  const d = state.pageDraft;
  const items = state.pageDetail?.submissions || [];
  if (!d?.slug) return '<div class="card"><h2>Submissions</h2><p class="muted">Save the page before it can collect responses.</p></div>';
  const head = "<th>Submitted</th>" + (d.fields || []).map((f) => "<th>" + esc(f.label) + "</th>").join("");
  const body = items.map((item) => "<tr><td>" + esc(formatCreated(item.at)) + "</td>" + (d.fields || []).map((f) => "<td>" + esc(item.values?.[f.id] || "") + "</td>").join("") + "</tr>").join("");
  return '<div class="card" data-testid="submissions"><div class="card-head"><h2>Submissions (' + items.length + ')</h2><button class="btn ghost" type="button" data-act="page-csv">Export CSV</button></div>' +
    (items.length ? '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" : '<p class="muted">No submissions yet.</p>') + "</div>";
}
function pageAnalytics() {
  const stats = state.pageDetail?.stats;
  if (!state.pageDraft?.slug || !stats) return '<div class="card"><h2>Analytics</h2><p class="muted">Page views appear here after the page is published and visited.</p></div>';
  const keys = lastN(30);
  const series = keys.map((date) => ({ date, value: stats.daily?.[date] || 0 }));
  const total = series.reduce((s, row) => s + row.value, 0);
  const seen = new Set();
  for (const key of keys) for (const hash of stats.visitors?.[key] || []) seen.add(hash);
  return '<div class="card" data-testid="page-analytics"><h2>Analytics</h2><div class="stat-pair"><div class="stat-box"><div class="muted">Page views</div><div class="num">' + num(total) + '</div><div class="sub">Last 30 days</div></div><div class="stat-box"><div class="muted">Unique</div><div class="num">' + num(seen.size) + '</div><div class="sub">Visitors</div></div></div>' +
    areaChart(series) + '<p class="muted small">All-time views: ' + num(stats.total || 0) + ". These views are the Home page clicks for this page.</p></div>";
}
function moveField(id, dir) {
  capturePageDraft();
  const fields = state.pageDraft.fields;
  const index = fields.findIndex((f) => f.id === id);
  const next = index + dir;
  if (index < 0 || next < 0 || next >= fields.length) return;
  const [row] = fields.splice(index, 1);
  fields.splice(next, 0, row);
  render({ refetch: false, keepScroll: true });
}
function syncPageColor(source) {
  const row = source.closest(".color-row");
  if (!row) return;
  const color = row.querySelector('input[type="color"]');
  const text = row.querySelector('input[type="text"]');
  if (!color || !text) return;
  if (source === color) text.value = color.value;
  else if (hexOk(text.value.trim())) color.value = text.value.trim();
}
function pagePayload(d) {
  return {
    name: d.name, title: d.title, heading: d.heading, body: d.body, heroUrl: d.heroUrl, heroData: d.heroData,
    buttonLabel: d.buttonLabel, buttonUrl: d.buttonUrl, colors: d.colors, fields: d.fields,
    submitLabel: d.submitLabel, thankYou: d.thankYou,
  };
}
async function savePage() {
  capturePageDraft();
  const d = state.pageDraft;
  const err = $("#page-error");
  try {
    if (!d.slug) {
      const created = await api("/api/pages", { method: "POST", body: JSON.stringify({ ...pagePayload(d), slug: (d.slugInput || "").trim() }) });
      state.pages = await api("/api/pages");
      toast("Page created");
      go("pages/" + created.slug);
    } else {
      await api("/api/pages/" + encodeURIComponent(d.slug), { method: "PATCH", body: JSON.stringify(pagePayload(d)) });
      state.pages = await api("/api/pages");
      toast("Saved");
      render();
    }
  } catch (e) { if (err) err.textContent = e.message; else toast(e.message); }
}
async function publishPage() {
  const d = state.pageDraft;
  if (!d?.slug) { toast("Save the page first"); return; }
  const status = d.status === "published" ? "draft" : "published";
  await api("/api/pages/" + encodeURIComponent(d.slug), { method: "PATCH", body: JSON.stringify({ status }) });
  state.pages = await api("/api/pages");
  toast(status === "published" ? "Published" : "Unpublished");
  render();
}
async function deletePage() {
  const slug = state.pageDraft?.slug;
  if (!slug) return;
  await api("/api/pages/" + encodeURIComponent(slug), { method: "DELETE" });
  closeModal();
  state.pages = (state.pages || []).filter((p) => p.slug !== slug);
  state.pageDraft = null;
  state.pageDetail = null;
  toast("Deleted");
  go("pages");
}
async function attachPageCode(kind) {
  const page = state.pageDraft;
  if (!page?.slug) { toast("Save the page first"); return; }
  const url = base() + "/p/" + page.slug;
  let code = page.codeSlug ? codeBySlug(page.codeSlug) : null;
  if (!code) {
    code = await api("/api/codes", { method: "POST", body: JSON.stringify({ url, name: page.name || page.slug, type: kind === "link" ? "link" : "qr" }) });
    await api("/api/pages/" + encodeURIComponent(page.slug), { method: "PATCH", body: JSON.stringify({ codeSlug: code.slug }) });
  } else if (kind === "link" && !code.hasLink) {
    await api("/api/codes/" + encodeURIComponent(code.slug), { method: "PATCH", body: JSON.stringify({ hasLink: true }) });
  } else if (kind === "qr" && !code.hasQr) {
    await api("/api/codes/" + encodeURIComponent(code.slug), { method: "PATCH", body: JSON.stringify({ hasQr: true }) });
  }
  state.codes = await api("/api/codes");
  toast(kind === "link" ? "Short link ready" : "QR code ready");
  render();
}
function downloadPageCsv() {
  const page = state.pageDetail?.page || state.pageDraft;
  const items = state.pageDetail?.submissions || [];
  if (!page) return;
  const headers = ["submitted_at", ...(page.fields || []).map((f) => f.label)];
  const lines = [headers.map(csvCell).join(",")];
  for (const item of items) lines.push([item.at, ...(page.fields || []).map((f) => item.values?.[f.id] || "")].map(csvCell).join(","));
  downloadBlob((page.slug || "page") + "-submissions.csv", new Blob([lines.join("\n")], { type: "text/csv" }));
}
const COMP_ROLES = [["", "—"], ["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["rego", "Rego"], ["receipt", "Receipt number"], ["receiptPhoto", "Receipt photo"], ["over18", "Over 18"], ["consent", "Consent"], ["site", "Site"]];
function blankCompetition() {
  return {
    slug: "", name: "", sites: ["Lansvale"], prize: "", status: "draft", start: new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), end: "",
    schedule: { type: "weekly", count: 8 },
    fields: [
      { id: "name", type: "text", label: "Name", required: true, role: "name", options: [] },
      { id: "email", type: "email", label: "Email", required: false, role: "email", options: [] },
      { id: "phone", type: "phone", label: "Mobile", required: false, role: "phone", options: [] },
      { id: "receipt", type: "text", label: "Receipt number", required: false, role: "receipt", options: [] },
      { id: "photo", type: "file", label: "Receipt photo", required: false, role: "receiptPhoto", options: [] },
      { id: "over18", type: "checkbox", label: "I am 18 or older", required: true, role: "over18", options: [] },
      { id: "consent", type: "checkbox", label: "I agree to the terms", required: true, role: "consent", options: [] },
    ],
    eligibility: { onePerPerson: true, dedupeEmail: true, dedupePhone: true, dedupeRego: false, dedupeReceipt: true },
    terms: "", termsUrl: "", heading: "", body: "", submitLabel: "Enter", thankYou: "You're in the draw. Good luck.",
    heroUrl: "", heroData: "", logoData: "",
    colors: { background: "#f4f6fb", text: "#1c2434", accent: "#0e1b4d", button: "#1f4bdb", buttonText: "#ffffff" },
    codeSlug: "", currentPeriod: 1, winners: [],
  };
}
function competitionsList() {
  const q = state.search.toLowerCase();
  const rows = (state.competitions || []).filter((c) => !q || [c.name, c.slug, ...(c.sites || [])].join(" ").toLowerCase().includes(q));
  const body = rows.map((c) => {
    const status = c.status === "active" ? '<span class="badge ok">Active</span>' : c.status === "ended" ? '<span class="badge">Ended</span>' : '<span class="badge muted">Draft</span>';
    const dates = [c.start, c.end].filter(Boolean).join(" – ") || "—";
    return '<tr class="clickable" data-go="competitions/' + encodeURIComponent(c.slug) + '"><td><strong>' + esc(c.name) + '</strong><div class="muted small">/c/' + esc(c.slug) + '</div></td><td>' + esc((c.sites || []).join(", ") || "—") + "</td><td>" + status + "</td><td>" + esc(dates) + '</td><td class="num">' + num(c.valid || 0) + '</td><td>' + esc(c.nextDraw || "—") + "</td></tr>";
  }).join("");
  return '<div class="page-head"><h1>Competitions</h1><button class="btn" type="button" data-go="competitions/new">Create competition</button></div><div class="card table-wrap" data-testid="competitions-list">' +
    (rows.length ? "<table><thead><tr><th>Name</th><th>Sites</th><th>Status</th><th>Dates</th><th class='num'>Valid entries</th><th>Next draw</th></tr></thead><tbody>" + body + "</tbody></table>" : '<div class="empty"><div class="empty-mark">L</div><h2>No competitions yet</h2><p class="muted">Run a site draw with one entry per person and a fresh pool each week.</p></div>') + "</div>";
}
function captureCompDraft() {
  const form = document.getElementById("comp-editor");
  const d = state.compDraft;
  if (!form || !d) return;
  const val = (name) => form.querySelector('[name="' + name + '"]')?.value ?? "";
  d.name = val("name");
  d.sites = val("sites").split(",").map((s) => s.trim()).filter(Boolean);
  d.prize = val("prize");
  d.start = val("start");
  d.end = val("end");
  d.heading = val("heading");
  d.body = val("body");
  d.terms = val("terms");
  d.termsUrl = val("termsUrl");
  d.heroUrl = val("heroUrl");
  d.heroData = val("heroData");
  d.logoData = val("logoData");
  const primary = form.querySelector('[name="comp-primary"]')?.value;
  d.colors = {
    background: form.querySelector('[name="comp-bg"]')?.value || "#f4f6fb",
    text: form.querySelector('[name="comp-text"]')?.value || "#1c2434",
    button: primary || "#1f4bdb",
    buttonText: "#ffffff",
    accent: primary || "#0e1b4d",
  };
  d.submitLabel = val("submitLabel") || "Enter";
  d.thankYou = val("thankYou");
  d.status = val("status") || d.status;
  const site = form.querySelector('[name="siteId"]');
  if (site) d.siteId = site.value;
  d.voucher = {
    enabled: !!form.querySelector('[name="voucherEnabled"]')?.checked,
    label: val("voucherLabel"),
    terms: val("voucherTerms"),
    expires: val("voucherExpires"),
    maxIssues: Number(val("voucherMax")) || 0,
  };
  if (!d.slug) d.slugInput = val("slug");
  d.schedule = { type: val("scheduleType") === "single" ? "single" : "weekly", count: Number(val("scheduleCount")) || 8 };
  d.eligibility = {
    onePerPerson: !!form.querySelector('[name="onePerPerson"]')?.checked,
    dedupeEmail: !!form.querySelector('[name="dedupeEmail"]')?.checked,
    dedupePhone: !!form.querySelector('[name="dedupePhone"]')?.checked,
    dedupeRego: !!form.querySelector('[name="dedupeRego"]')?.checked,
    dedupeReceipt: !!form.querySelector('[name="dedupeReceipt"]')?.checked,
  };
  d.fields = (d.fields || []).map((f) => {
    const card = form.querySelector('[data-cfield="' + f.id + '"]');
    if (!card) return f;
    return {
      ...f,
      label: card.querySelector('[name="label"]')?.value ?? f.label,
      required: !!card.querySelector('[name="required"]')?.checked,
      role: card.querySelector('[name="role"]')?.value || "",
      options: f.type === "dropdown" ? (card.querySelector('[name="options"]')?.value || "").split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
  });
}
function compFieldCard(f) {
  const roles = COMP_ROLES.map(([v, l]) => '<option value="' + v + '"' + (f.role === v ? " selected" : "") + ">" + l + "</option>").join("");
  const options = f.type === "dropdown" ? '<label class="field"><span>Options, comma separated</span><input name="options" value="' + esc((f.options || []).join(", ")) + '"></label>' : "";
  return '<div class="field-card" data-cfield="' + esc(f.id) + '"><div class="row"><strong>' + esc(f.type) + '</strong><span class="grow"></span>' +
    '<button class="btn ghost" type="button" data-act="cfield-up" data-id="' + esc(f.id) + '">↑</button>' +
    '<button class="btn ghost" type="button" data-act="cfield-down" data-id="' + esc(f.id) + '">↓</button>' +
    '<button class="btn ghost" type="button" data-act="remove-cfield" data-id="' + esc(f.id) + '">Remove</button></div>' +
    '<label class="field"><span>Label</span><input name="label" value="' + esc(f.label) + '"></label>' +
    '<label class="field"><span>Maps to</span><select name="role">' + roles + "</select></label>" + options +
    '<label class="check"><input name="required" type="checkbox"' + (f.required ? " checked" : "") + "> Required</label></div>";
}
function competitionEditor() {
  const d = state.compDraft || blankCompetition();
  const stats = state.compDetail?.stats;
  const code = d.codeSlug ? codeBySlug(d.codeSlug) : null;
  const check = (name, label) => '<label class="check"><input type="checkbox" name="' + name + '"' + (d.eligibility?.[name] ? " checked" : "") + "> " + label + "</label>";
  return '<div class="page-head"><button class="icon-btn" type="button" data-go="competitions" aria-label="Back">←</button><h1>' + esc(d.name || "New competition") + "</h1>" +
    (d.slug ? (d.status === "active" ? '<span class="badge ok">Active</span>' : d.status === "ended" ? '<span class="badge">Ended</span>' : '<span class="badge muted">Draft</span>') : "") + "</div>" +
    (stats ? '<div class="metrics four"><div><div class="metric-label">Valid entries</div><div class="metric-value">' + num(stats.valid) + '</div></div><div><div class="metric-label">Unique entrants</div><div class="metric-value">' + num(stats.unique) + '</div></div><div><div class="metric-label">Duplicates</div><div class="metric-value">' + num(stats.duplicates) + '</div></div><div><div class="metric-label">Draws remaining</div><div class="metric-value">' + num(stats.drawsRemaining) + "</div></div></div>" : "") +
    '<form id="comp-editor" data-act="save-comp" data-testid="comp-editor"><div class="card"><div class="card-head"><h2>Competition</h2></div>' +
    '<label class="field"><span>Name</span><input name="name" required maxlength="140" value="' + esc(d.name) + '"></label>' +
    (d.slug ? '<p data-testid="comp-url"><strong>' + esc(base() + "/c/" + d.slug) + "</strong></p>" : '<label class="field"><span>Slug (optional)</span><input name="slug" maxlength="41" placeholder="lansvale-free-fuel" value="' + esc(d.slugInput || "") + '"></label>') +
    '<label class="field"><span>Location</span><select name="siteId" data-testid="comp-site">' + siteOptions(d.siteId || "") + "</select></label>" +
    '<label class="field"><span>Sites, comma separated</span><input name="sites" value="' + esc((d.sites || []).join(", ")) + '"></label>' +
    '<label class="field"><span>Prize</span><input name="prize" value="' + esc(d.prize) + '"></label>' +
    '<div class="split"><label class="field"><span>Start</span><input name="start" type="date" value="' + esc(d.start || "") + '"></label><label class="field"><span>End</span><input name="end" type="date" value="' + esc(d.end || "") + '"></label></div>' +
    '<div class="split"><label class="field"><span>Draw schedule</span><select name="scheduleType"><option value="weekly"' + (d.schedule?.type !== "single" ? " selected" : "") + '>Weekly</option><option value="single"' + (d.schedule?.type === "single" ? " selected" : "") + ">Single draw</option></select></label>" +
    '<label class="field"><span>Number of draws</span><input name="scheduleCount" type="number" min="1" max="52" value="' + esc(d.schedule?.count || 8) + '"></label></div>' +
    '<label class="field"><span>Status</span><select name="status"><option value="draft"' + (d.status === "draft" ? " selected" : "") + '>Draft</option><option value="active"' + (d.status === "active" ? " selected" : "") + '>Active</option><option value="ended"' + (d.status === "ended" ? " selected" : "") + ">Ended</option></select></label>" +
    '<label class="field"><span>Heading</span><input name="heading" value="' + esc(d.heading) + '"></label>' +
    '<label class="field"><span>Body</span><textarea name="body">' + esc(d.body) + "</textarea></label>" +
    '<label class="field"><span>Terms</span><textarea name="terms">' + esc(d.terms) + "</textarea></label>" +
    '<label class="field"><span>Terms link</span><input name="termsUrl" type="url" value="' + esc(d.termsUrl) + '"></label>' +
    "<h2>One entry per period</h2><div class=\"row\">" +
    check("onePerPerson", "One entry per person") + check("dedupeEmail", "Dedupe email") + check("dedupePhone", "Dedupe phone") + check("dedupeRego", "Dedupe rego") + check("dedupeReceipt", "Dedupe receipt hash") + "</div>" +
    '<p class="muted small">Times and draw windows use Australia/Melbourne. Email, phone, and rego are checked inside the current period. A receipt number or photo hash is checked across the whole competition. An active competition always shows this form, including before the start date and when the link has ?qr=1.</p>' +
    '<h2>Voucher</h2><p class="muted small">Leave this off. It is not enabled by saving the competition. An offer needs text, terms, an expiry, and a maximum number of vouchers.</p>' +
    '<label class="check"><input type="checkbox" name="voucherEnabled" data-testid="voucher-enabled"' + (d.voucher?.enabled ? " checked" : "") + "> Enable a single-use voucher</label>" +
    '<label class="field"><span>Offer text</span><input name="voucherLabel" value="' + esc(d.voucher?.label || "") + '" placeholder="Written by you"></label>' +
    '<label class="field"><span>Terms</span><textarea name="voucherTerms" placeholder="Written by you">' + esc(d.voucher?.terms || "") + "</textarea></label>" +
    '<div class="split"><label class="field"><span>Expiry</span><input name="voucherExpires" type="date" value="' + esc(d.voucher?.expires || "") + '"></label>' +
    '<label class="field"><span>Maximum issued</span><input name="voucherMax" type="number" min="1" max="500" value="' + esc(d.voucher?.maxIssues || "") + '"></label></div></div>' +
    compDesign(d) +
    '<div class="card"><div class="card-head"><h2>Entry form</h2></div>' + (d.fields || []).map(compFieldCard).join("") +
    '<div class="row" style="margin-top:12px"><select id="new-cfield-type">' + ["text", "email", "phone", "dropdown", "checkbox", "textarea", "file"].map((t) => '<option value="' + t + '">' + t + "</option>").join("") + '</select><button class="btn ghost" type="button" data-act="add-cfield">Add field</button></div>' +
    '<label class="field"><span>Submit button</span><input name="submitLabel" value="' + esc(d.submitLabel || "Enter") + '"></label>' +
    '<label class="field"><span>Thank-you message</span><textarea name="thankYou">' + esc(d.thankYou) + "</textarea></label></div>" +
    '<div class="row"><button class="btn" type="submit">Save</button>' + (d.slug ? '<button class="btn danger" type="button" data-act="del-comp">Delete</button>' : "") + '<p class="err" id="comp-error"></p></div></form>' +
    compManage();
}
function compManage() {
  const d = state.compDraft;
  if (!d?.slug) return '<div class="card"><h2>Entries</h2><p class="muted">Save the competition before taking entries.</p></div>';
  const entries = state.compDetail?.entries || [];
  const view = state.compView || { period: "current", status: "all" };
  const period = view.period === "current" ? (d.currentPeriod || 1) : view.period;
  const filtered = entries.filter((e) => {
    if (view.period !== "all" && String(e.period) !== String(period)) return false;
    if (view.status !== "all" && e.status !== view.status) return false;
    return true;
  });
  const periods = Math.max(d.schedule?.type === "single" ? 1 : Number(d.schedule?.count) || 1, d.currentPeriod || 1);
  const periodOptions = '<option value="current"' + (view.period === "current" ? " selected" : "") + ">Current period</option>" +
    Array.from({ length: periods }, (_, i) => '<option value="' + (i + 1) + '"' + (String(view.period) === String(i + 1) ? " selected" : "") + ">Period " + (i + 1) + "</option>").join("") +
    '<option value="all"' + (view.period === "all" ? " selected" : "") + ">All periods</option>";
  const rows = filtered.map((e) => "<tr><td>" + esc(e.id) + "</td><td>" + esc(e.melbourne || formatCreated(e.at)) + "</td><td>" + esc(e.name) + "</td><td>" + esc(e.contact) + "</td><td>" + esc(e.contactType || "") + "</td><td>" + esc(e.site || "") + "</td><td>" + esc(e.status) + (e.duplicateReason ? '<div class="muted small">' + esc(e.duplicateReason) + "</div>" : "") + "</td><td>" + (e.receiptStored ? "Photo" : esc(e.receiptNumber || e.receiptUrl || "")) + "</td></tr>").join("");
  const winners = (d.winners || []).filter((w) => !w.superseded);
  const code = d.codeSlug ? codeBySlug(d.codeSlug) : null;
  const scans = code ? (code.scans || 0) : 0;
  const accepted = entries.filter((e) => e.status === "valid" || e.status === "archived").length;
  const byDay = {};
  for (const e of entries) byDay[e.formDate] = (byDay[e.formDate] || 0) + 1;
  const keys = lastN(30);
  const series = keys.map((date) => ({ date, value: byDay[date] || 0 }));
  const bySite = {};
  for (const e of entries) if (e.site) bySite[e.site] = (bySite[e.site] || 0) + 1;
  return '<div class="card" data-testid="poster-tools"><div class="card-head"><h2>Poster, template, and copy</h2></div>' +
    '<p class="muted small">Posters print the existing public page address. A copy is a new draft with a new link and no entries.</p>' +
    '<div class="row"><button class="btn" type="button" data-act="comp-poster" data-size="a4">A4 poster</button><button class="btn ghost" type="button" data-act="comp-poster" data-size="a3">A3 poster</button>' +
    '<button class="btn ghost" type="button" data-act="save-template">Save as template</button></div>' +
    '<form data-act="copy-comp" data-testid="copy-comp" class="stack"><p class="muted small">The copy is a new draft. Change the location, prize, or dates before you create it.</p>' +
    '<label class="field"><span>Copy name</span><input name="name" value="' + esc((d.name || "Competition") + " copy") + '"></label>' +
    '<label class="field"><span>Location</span><select name="siteId">' + siteOptions(d.siteId || "") + "</select></label>" +
    '<label class="field"><span>Prize</span><input name="prize" value="' + esc(d.prize || "") + '"></label>' +
    '<div class="split"><label class="field"><span>Start</span><input name="start" type="date" value="' + esc(d.start || "") + '"></label><label class="field"><span>End</span><input name="end" type="date" value="' + esc(d.end || "") + '"></label></div>' +
    '<button class="btn ghost" type="submit">Copy promotion</button></form></div>' +
    '<div class="card"><div class="card-head"><h2>QR code and short link</h2></div>' +
    (code ? '<p class="break">' + esc(shortUrl(code.slug)) + ' → ' + esc(base() + "/c/" + d.slug) + '</p><div class="row"><a class="btn ghost" href="#/qrcodes/' + encodeURIComponent(code.slug) + '">View QR code</a><a class="btn ghost" href="#/links/' + encodeURIComponent(code.slug) + '">View short link</a></div>' : '<p class="muted">Saving an active competition creates both automatically.</p>') + "</div>" +
    '<div class="card" data-testid="comp-entries"><div class="card-head"><h2>Entries</h2><div class="row"><select id="comp-period">' + periodOptions + '</select><select id="comp-status">' +
    ["all", "valid", "duplicate", "archived"].map((s) => '<option value="' + s + '"' + (view.status === s ? " selected" : "") + ">" + s + "</option>").join("") +
    '</select><button class="btn ghost" type="button" data-act="comp-csv">Export CSV</button><button class="btn" type="button" data-act="comp-draw">Draw winner</button></div></div>' +
    '<p class="muted small">The draw uses valid entries in period ' + esc(d.currentPeriod || 1) + " only (" + num((state.compDetail?.stats?.currentValid) || 0) + " ready). After the draw they are archived and the next period starts empty.</p>" +
    (filtered.length ? '<div class="table-wrap"><table><thead><tr><th>Entry</th><th>When (Melbourne)</th><th>Name</th><th>Contact</th><th>Type</th><th>Site</th><th>Status</th><th>Receipt</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<p class="muted">No entries in this view.</p>') + "</div>" +
    '<div class="card"><div class="card-head"><h2>Winners</h2></div>' +
    (winners.length ? winners.map((w) => '<div class="rule" data-testid="winner-' + esc(w.id) + '"><strong>Draw ' + w.drawNumber + "</strong> " + esc(w.name) + " · " + esc(w.contact || "No contact recorded") + ' <span class="muted">' + esc(w.melbourne) + " · pool " + w.poolSize + "</span>" +
      '<span class="badge">' + esc(w.collection?.status || "pending") + "</span>" +
      '<button class="btn ghost" type="button" data-act="comp-redraw" data-draw="' + w.drawNumber + '">Redraw</button>' +
      '<button class="btn ghost" type="button" data-act="winner-notice" data-winner="' + esc(w.id) + '">Review notice</button></div>' +
      '<form class="row" data-act="save-collection" data-winner="' + esc(w.id) + '"><select name="status"><option value="pending">Pending</option><option value="collected">Collected</option><option value="unclaimed">Unclaimed</option></select><input name="notes" type="text" maxlength="500" placeholder="Collection note" value="' + esc(w.collection?.notes || "") + '"><button class="btn ghost" type="submit">Save collection</button></form>').join("") : '<p class="muted">No winners drawn yet.</p>') +
    '<div id="notice-draft" data-testid="notice-draft"></div></div>' +
    '<div class="card"><h2>Import</h2><p class="muted">Paste CSV with the sheet columns (Entry ID, Name, Contact, Contact Type, Status, Duplicate Reason, Timestamp) or JSON in an entries array is accepted by the API.</p>' +
    '<textarea id="comp-import" placeholder="Entry ID,Name,Contact,Contact Type,Status"></textarea><button class="btn ghost" type="button" data-act="comp-import">Import CSV</button></div>' +
    '<div class="card"><h2>Analytics</h2><p class="muted">Entries over the last 30 days. QR scans on the linked code: ' + num(scans) + ". Accepted entries: " + num(accepted) + (scans ? " · conversion " + Math.round((accepted / scans) * 100) + "%" : "") + ".</p>" +
    areaChart(series) + "<div class=\"table-wrap\">" + dimTable(bySite, accepted || entries.length, "Site", "Entries") + "</div></div>";
}
function moveCompField(id, dir) {
  captureCompDraft();
  const fields = state.compDraft.fields;
  const index = fields.findIndex((f) => f.id === id);
  const next = index + dir;
  if (index < 0 || next < 0 || next >= fields.length) return;
  const [row] = fields.splice(index, 1);
  fields.splice(next, 0, row);
  render({ refetch: false, keepScroll: true });
}
function compPayload(d) {
  return {
    name: d.name, sites: d.sites, prize: d.prize, status: d.status, start: d.start, end: d.end, schedule: d.schedule,
    fields: d.fields, eligibility: d.eligibility, terms: d.terms, termsUrl: d.termsUrl, heading: d.heading, body: d.body,
    submitLabel: d.submitLabel, thankYou: d.thankYou,
    colors: d.colors, heroUrl: d.heroUrl, heroData: d.heroData, logoData: d.logoData,
    siteId: d.siteId || "",
    voucher: { enabled: !!d.voucher?.enabled, label: d.voucher?.label || "", terms: d.voucher?.terms || "", expires: d.voucher?.expires || "", maxIssues: Number(d.voucher?.maxIssues) || 0 },
  };
}
function compDesign(d) {
  const colors = { background: "#f4f6fb", text: "#1c2434", accent: "#0e1b4d", button: "#1f4bdb", buttonText: "#ffffff", ...(d.colors || {}) };
  const picker = (name, label, value) => '<label class="field"><span>' + label + '</span><span class="color-row"><input type="color" name="' + name + '" value="' + esc(value) + '"><input type="text" data-color-text="1" value="' + esc(value) + '"></span></label>';
  const hero = d.heroData || d.heroUrl;
  const logo = d.logoData;
  return '<div class="card" data-testid="comp-design"><div class="card-head"><h2>Design</h2></div>' +
    '<div class="split">' + picker("comp-bg", "Background", colors.background) + picker("comp-text", "Text", colors.text) + picker("comp-primary", "Primary / button", colors.button) + "</div>" +
    '<label class="field"><span>Hero image URL</span><input name="heroUrl" type="url" value="' + esc(d.heroUrl || "") + '" placeholder="https://…"></label>' +
    '<input type="hidden" name="heroData" value="' + esc(d.heroData || "") + '"><input type="hidden" name="logoData" value="' + esc(d.logoData || "") + '">' +
    '<div class="split"><label class="field"><span>Hero image upload</span><input id="comp-hero-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>' +
    '<label class="field"><span>Logo upload</span><input id="comp-logo-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label></div>' +
    '<div class="row"><button class="btn ghost" type="button" data-act="clear-comp-hero">Remove hero</button><button class="btn ghost" type="button" data-act="clear-comp-logo">Remove logo</button></div>' +
    '<p class="muted small">Preview uses the colours and images above. Save to publish them on the public page.</p>' +
    '<div id="comp-preview" class="phone-preview" data-testid="comp-preview"><div class="screen" style="background:' + esc(colors.background) + ";color:" + esc(colors.text) + '">' +
    (logo ? '<img class="preview-logo" alt="" src="' + esc(logo) + '">' : '<div class="preview-mark" style="background:' + esc(colors.button) + '">L</div>') +
    (hero ? '<img class="preview-hero" alt="" src="' + esc(hero) + '">' : '<img class="preview-hero" alt="" hidden>') +
    '<h2 style="color:' + esc(colors.button) + '">' + esc(d.heading || d.name || "Competition") + "</h2>" +
    '<p class="preview-prize" style="color:' + esc(colors.button) + '"' + (d.prize ? "" : " hidden") + ">" + esc(d.prize || "") + "</p>" +
    '<p class="preview-body">' + esc(d.body || "") + "</p>" +
    '<div class="preview-field">Name</div><div class="preview-field">Email</div>' +
    '<div class="preview-btn" style="background:' + esc(colors.button) + '">' + esc(d.submitLabel || "Enter") + "</div></div></div></div>";
}
function paintCompPreview() {
  const screen = document.querySelector("#comp-preview .screen");
  if (!screen) return;
  const bg = document.querySelector('[name="comp-bg"]')?.value || "#f4f6fb";
  const text = document.querySelector('[name="comp-text"]')?.value || "#1c2434";
  const primary = document.querySelector('[name="comp-primary"]')?.value || "#1f4bdb";
  if (![bg, text, primary].every(hexOk)) return;
  screen.style.background = bg;
  screen.style.color = text;
  const title = screen.querySelector("h2");
  const prizeEl = screen.querySelector(".preview-prize");
  const bodyEl = screen.querySelector(".preview-body");
  const btn = screen.querySelector(".preview-btn");
  const heading = document.querySelector('#comp-editor [name="heading"]')?.value;
  const name = document.querySelector('#comp-editor [name="name"]')?.value;
  const prize = document.querySelector('#comp-editor [name="prize"]')?.value || "";
  const body = document.querySelector('#comp-editor [name="body"]')?.value || "";
  if (title) { title.textContent = heading || name || "Competition"; title.style.color = primary; }
  if (prizeEl) { prizeEl.textContent = prize; prizeEl.hidden = !prize; prizeEl.style.color = primary; }
  if (bodyEl) bodyEl.textContent = body;
  if (btn) { btn.style.background = primary; btn.textContent = document.querySelector('#comp-editor [name="submitLabel"]')?.value || "Enter"; }
  const hero = document.querySelector('[name="heroData"]')?.value || document.querySelector('#comp-editor [name="heroUrl"]')?.value;
  const heroEl = screen.querySelector(".preview-hero");
  if (heroEl) { heroEl.hidden = !hero; if (hero) heroEl.src = hero; }
  const logo = document.querySelector('[name="logoData"]')?.value;
  let logoEl = screen.querySelector(".preview-logo");
  let mark = screen.querySelector(".preview-mark");
  if (logo) {
    if (!logoEl) {
      logoEl = document.createElement("img");
      logoEl.className = "preview-logo";
      logoEl.alt = "";
      screen.prepend(logoEl);
    }
    logoEl.hidden = false;
    logoEl.src = logo;
    if (mark) mark.hidden = true;
  } else if (logoEl) logoEl.hidden = true;
  if (!logo && mark) { mark.hidden = false; mark.style.background = primary; }
}
async function ensureCompCode(comp) {
  if (comp.codeSlug || comp.status !== "active") return comp;
  const code = await api("/api/codes", { method: "POST", body: JSON.stringify({ url: base() + "/c/" + comp.slug, name: comp.name || comp.slug, type: "qr", alsoLink: true, siteId: comp.siteId || "" }) });
  state.codes = await api("/api/codes");
  return api("/api/competitions/" + encodeURIComponent(comp.slug), { method: "PATCH", body: JSON.stringify({ codeSlug: code.slug }) });
}
async function saveCompetition() {
  captureCompDraft();
  const d = state.compDraft;
  const err = $("#comp-error");
  try {
    let saved;
    if (!d.slug) saved = await api("/api/competitions", { method: "POST", body: JSON.stringify({ ...compPayload(d), slug: (d.slugInput || "").trim() }) });
    else saved = await api("/api/competitions/" + encodeURIComponent(d.slug), { method: "PATCH", body: JSON.stringify(compPayload(d)) });
    saved = await ensureCompCode(saved);
    state.competitions = await api("/api/competitions");
    toast("Saved");
    if (!d.slug) go("competitions/" + saved.slug);
    else render();
  } catch (e) { if (err) err.textContent = e.message; else toast(e.message); }
}
async function drawCompetition(redraw, drawNumber) {
  const slug = state.compDraft?.slug;
  if (!slug) return;
  const result = await api("/api/competitions/" + encodeURIComponent(slug) + "/draw", { method: "POST", body: JSON.stringify({ redraw: !!redraw, drawNumber: Number(drawNumber) || 0 }) });
  state.competitions = await api("/api/competitions");
  toast((redraw ? "Redraw: " : "Winner: ") + (result.winner?.name || "drawn"));
  render();
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] || ""])));
}
async function importCompetition() {
  const slug = state.compDraft?.slug;
  const rows = parseCsv($("#comp-import")?.value || "");
  if (!slug || !rows.length) { toast("Add a CSV with a header row"); return; }
  const result = await api("/api/competitions/" + encodeURIComponent(slug) + "/import", { method: "POST", body: JSON.stringify({ entries: rows }) });
  toast("Imported " + result.imported);
  render();
}
function downloadCompCsv() {
  const entries = state.compDetail?.entries || [];
  const headers = ["Entry ID", "Campaign", "Timestamp", "Melbourne", "Name", "Contact", "Normalised Contact", "Contact Type", "Site", "Period", "Status", "Duplicate Reason", "Matched Entry ID", "Receipt Hash", "Over 18", "Consent"];
  const lines = [headers.map(csvCell).join(",")];
  for (const e of entries) lines.push([e.id, e.campaign, e.at, e.melbourne, e.name, e.contact, e.contactNorm, e.contactType, e.site, e.period, e.status, e.duplicateReason, e.matchedEntryId, e.receiptHash || e.photoHash, e.over18 ? "yes" : "", e.consent ? "yes" : ""].map(csvCell).join(","));
  downloadBlob((state.compDraft?.slug || "competition") + "-entries.csv", new Blob([lines.join("\n")], { type: "text/csv" }));
}
function sitesPage() {
  const head = state.actor?.role === "head";
  const groups = new Map();
  const ensure = (id) => { if (!groups.has(id)) groups.set(id, { codes: [], pages: [], competitions: [] }); return groups.get(id); };
  for (const site of state.sites || []) ensure(site.id);
  if (head) ensure("");
  for (const code of state.codes || []) ensure(code.siteId || "").codes.push(code);
  for (const page of state.pages || []) ensure(page.siteId || "").pages.push(page);
  for (const comp of state.competitions || []) ensure(comp.siteId || "").competitions.push(comp);
  if (!head) groups.delete("");
  const block = (kind, rows) => rows.map((row) => '<form class="row" data-act="assign-site"><input type="hidden" name="kind" value="' + kind + '"><input type="hidden" name="slug" value="' + esc(row.slug) + '"><span class="grow">' + esc(row.name || row.slug) + '</span><select name="siteId">' + siteOptions(row.siteId || "") + '</select><button class="btn ghost" type="submit">Assign</button></form>').join("") || '<p class="muted">None</p>';
  const cards = [...groups.entries()].map(([id, group]) => '<section class="card" data-testid="site-group"><h2>' + esc(siteName(id)) + "</h2><h3>QR codes and links</h3>" + block("code", group.codes) + "<h3>Pages</h3>" + block("page", group.pages) + "<h3>Competitions</h3>" + block("competition", group.competitions) + "</section>").join("");
  return '<div class="page-head"><h1>Sites</h1></div>' +
    (head ? '<form class="card" data-act="create-site" data-testid="create-site"><label class="field"><span>New location</span><input name="name" required maxlength="80" placeholder="Location name"></label><button class="btn" type="submit">Add site</button><p class="muted small">Existing records stay unassigned until someone moves them.</p></form>' +
      '<form class="card" data-act="preview-import" data-testid="site-import"><h2>Import locations</h2><p class="muted small">Head office only. Preview is the default. Held rows are not written. LOC, address, operational region, and geographic state stay separate. Nothing here grants staff access.</p><label class="field"><span>JSON rows</span><textarea name="rows" id="import-rows" placeholder=\'[{"loc":"LOC1","name":"North","address":"1 Main Street","operationalRegion":"North","geographicState":"","sourceRef":"row-1"}]\'></textarea></label><button class="btn" type="submit">Preview import</button><div id="import-report"></div></form>' : "") +
    (cards || '<div class="card"><p class="muted">No sites are assigned to this login.</p></div>');
}
function staffSettings() {
  if (state.actor?.role !== "head") return "";
  const rows = (state.staff || []).map((person) => '<form class="row" data-act="save-staff"><input type="hidden" name="id" value="' + esc(person.id) + '"><strong class="grow">' + esc(person.name) + '</strong><span class="muted">' + esc(person.email) + "</span>" +
    '<select name="siteId"><option value="">No site</option>' + (state.sites || []).map((site) => '<option value="' + esc(site.id) + '"' + (person.siteIds?.[0] === site.id ? " selected" : "") + ">" + esc(site.name) + "</option>").join("") + "</select>" +
    '<label class="check"><input name="disabled" type="checkbox"' + (person.disabled ? " checked" : "") + '> Disabled</label><button class="btn ghost" type="submit">Update</button></form>').join("");
  return '<form class="card" data-act="create-staff" data-testid="staff-editor"><h2>Staff</h2><p class="muted small">Managers only see the site you assign. Passwords are stored as a hash and are not shown again. Nobody is created until you submit this form.</p>' +
    '<div class="split"><label class="field"><span>Name</span><input name="name" required></label><label class="field"><span>Email</span><input name="email" type="email" required></label></div>' +
    '<div class="split"><label class="field"><span>Password</span><input name="password" type="password" minlength="10" required autocomplete="new-password"></label><label class="field"><span>Site</span><select name="siteId"><option value="">No site yet</option>' + (state.sites || []).map((site) => '<option value="' + esc(site.id) + '">' + esc(site.name) + "</option>").join("") + "</select></label></div>" +
    '<button class="btn" type="submit">Create manager</button></form>' + (rows ? '<div class="card" data-testid="staff-list">' + rows + "</div>" : "");
}
function blankPos() {
  return { offer: "", conditions: "", start: "", end: "", siteIds: [], posRedemption: "single-use", codeValue: "", distribution: "shareable-claim-link", claimCap: 100, approvalStatus: "draft" };
}
function posList() {
  const rows = state.posDrafts || [];
  const body = rows.map((draft) => '<tr class="clickable" data-go="pos/' + esc(draft.id) + '"><td><strong>' + esc(draft.offer) + '</strong><div class="muted small">' + esc(draft.codeValue) + '</div></td><td>' + esc(draft.posRedemption) + '</td><td>' + esc(draft.approvalStatus || "draft") + '</td><td>Pending POS confirmation</td><td>' + esc((draft.sites || []).map((site) => site.name).join(", ") || "Unassigned") + "</td></tr>").join("");
  return '<div class="page-head"><h1>POS setup</h1><button class="btn" type="button" data-go="pos/new">New draft</button></div><div class="warn-banner" data-testid="pos-provisional">Provisional. Quickfuel has not confirmed a barcode or import format. Nothing here activates an offer.</div><div class="card table-wrap" data-testid="pos-list">' +
    (rows.length ? "<table><thead><tr><th>Offer</th><th>POS request</th><th>Approval</th><th>Quickfuel</th><th>Sites</th></tr></thead><tbody>" + body + "</tbody></table>" : '<div class="empty"><h2>No POS drafts</h2><p class="muted">Create a package for a point-of-sale provider. It stays pending.</p></div>') + "</div>";
}
function posEditor() {
  const draft = state.posDraft || blankPos();
  const selected = new Set(draft.siteIds || []);
  const sites = (state.sites || []).map((site) => '<label class="check"><input type="checkbox" name="siteIds" value="' + esc(site.id) + '"' + (selected.has(site.id) ? " checked" : "") + "> " + esc(site.name) + "</label>").join("") || '<p class="muted">No sites yet. Head office can still save an unassigned draft.</p>';
  const preview = draft.id ? '<img data-testid="pos-barcode" alt="Code 128 barcode" src="/api/pos-drafts/' + encodeURIComponent(draft.id) + "/barcode.svg?v=" + encodeURIComponent(draft.updated || "") + '">' : '<p class="muted">Save the draft to preview the barcode.</p>';
  const approved = draft.approvalStatus === "approved" && draft.approvalCurrent;
  const status = draft.identityStatus || state.identityStatus || {};
  const mailMode = status.mailMode || (status.mailConfigured ? "resend" : "disabled");
  const mailOff = mailMode === "disabled";
  const mailCopy = mailMode === "mock" ? "Local test mail only. No message leaves this process and no provider is configured." : mailMode === "resend" ? "The configured email service is available." : (status.mailSetup || "Email is not configured. Set RESEND_API_KEY and RESEND_FROM. Nothing is sent.");
  const preparer = state.actor?.role === "preparer";
  const approverMatch = state.actor?.role === "approver" && draft.approvalStatus === "pending" && (state.actor?.approverKey === "neil" || state.actor?.approverKey === "joshua");
  const history = (draft.history || []).map((item) => "<li>" + esc(item.action) + " · rev " + esc(item.revision) + " · " + esc(item.approverKey || item.role || "") + " · " + esc(item.at) + "</li>").join("");
  return '<div class="page-head"><button class="icon-btn" type="button" data-go="pos" aria-label="Back">←</button><h1>' + esc(draft.offer || "POS draft") + '</h1><span class="badge">' + esc(approved ? "Approved" : "Draft / unapproved") + '</span></div>' +
    '<div class="warn-banner" data-testid="pos-provisional">Provisional Code 128 artwork. This is not a Quickfuel format, not a GTIN, and not an activated web voucher. A single-use choice is a request to the point-of-sale provider, not enforcement by this barcode.</div>' +
    '<div class="warn-banner" data-testid="pos-approval-note">Neil or Joshua may approve. One verified approver is enough. The shared head-office password cannot approve, and an email address alone is not an identity.</div>' +
    '<form class="card" data-act="save-pos" data-testid="pos-editor"><div class="card-head"><h2>' + (approved ? "Approved revision" : "Draft") + "</h2></div>" +
    '<label class="field"><span>Offer</span><input name="offer" required maxlength="140" value="' + esc(draft.offer || "") + '"></label>' +
    '<label class="field"><span>Conditions</span><textarea name="conditions" required maxlength="2000">' + esc(draft.conditions || "") + "</textarea></label>" +
    '<div class="split"><label class="field"><span>Valid from</span><input name="start" type="date" required value="' + esc(draft.start || "") + '"></label><label class="field"><span>Valid through</span><input name="end" type="date" required value="' + esc(draft.end || "") + '"></label></div>' +
    '<p class="muted small">Boundaries use Australia/Melbourne, from 00:00 on the start date through 23:59:59 on the end date.</p>' +
    '<fieldset><legend>Eligible sites</legend>' + sites + "</fieldset>" +
    '<label class="field"><span>POS redemption request</span><select name="posRedemption"><option value="single-use"' + (draft.posRedemption !== "reusable" ? " selected" : "") + '>Single-use request</option><option value="reusable"' + (draft.posRedemption === "reusable" ? " selected" : "") + ">Reusable request</option></select></label>" +
    '<label class="field"><span>Distribution</span><select name="distribution"><option value="shareable-claim-link" selected>Shareable claim link (unpublished)</option></select></label>' +
    '<label class="field"><span>Claim cap</span><input name="claimCap" type="number" min="1" max="5000" required value="' + esc(draft.claimCap || 100) + '"></label>' +
    '<label class="field"><span>Barcode type</span><input value="Code 128" readonly></label>' +
    '<label class="field"><span>Barcode value</span><input name="codeValue" maxlength="48" value="' + esc(draft.codeValue || "") + '" placeholder="Leave blank to allocate EH-POS-…"></label>' +
    '<p class="muted small">Other barcode formats are not generated. Quickfuel confirmation stays pending. Saving a material change clears approval.</p>' +
    '<div class="row"><button class="btn" type="submit">Save draft</button>' + (draft.id ? '<button class="btn ghost" type="button" data-act="pos-download">Download draft package</button>' : "") + "</div>" +
    '<p class="err" id="pos-error"></p></form>' +
    '<div class="card" data-testid="pos-mail">' +
    '<h2>Send for approval</h2><p class="muted small" data-testid="pos-mail-status">' + esc(mailCopy) + "</p><p>Send for approval emails both Neil (nanderson@libertyretail.com.au) and Joshua (jbattaglia@libertyretail.com.au). Either verified approver is enough.</p>" +
    (preparer && draft.id ? '<button class="btn" type="button" data-act="pos-approval-request"' + (mailOff ? " disabled" : "") + ">Send for approval</button>" : '<p class="muted">Sign in with a verified preparer identity to send for approval. No preparer accounts are created automatically.</p>') +
    "</div>" +
    (approved ? '<div class="card" data-testid="pos-quickfuel"><h2>Send to Quickfuel</h2><p data-testid="quickfuel-recipient">Recipient: support@quickfuel.com.au</p><p class="muted small">This box is only here because the current revision is approved. It does not appear for a pending, rejected, expired, or edited request. Approval does not send this.</p>' +
      (preparer ? '<label class="check"><input id="pos-confirm-send" type="checkbox"> I am sending this approved revision to support@quickfuel.com.au</label><button class="btn" type="button" data-act="pos-send-quickfuel"' + (mailOff ? " disabled" : "") + ">Send to Quickfuel</button>" : '<p class="muted">The requester confirms this send.</p>') + "</div>" : '<p class="muted" data-testid="pos-quickfuel-hidden">Send to Quickfuel is hidden until Neil or Joshua approves this revision.</p>') +
    (approverMatch ? '<div class="card"><h2>Your decision</h2><div class="row"><button class="btn" type="button" data-act="pos-approve">Approve</button><button class="btn ghost" type="button" data-act="pos-reject">Reject</button></div></div>' : "") +
    '<div class="card"><h2>Approval history</h2>' + (history ? "<ul>" + history + "</ul>" : '<p class="muted">No approval events.</p>') + "</div>" +
    '<div class="card" data-testid="pos-claim-preview"><h2>Claim preview</h2><p>Draft preview. The claim link is not published. Shareable claim distribution stays off until recorded Quickfuel confirmation and an explicit activation.</p><p class="muted small">Cap ' + esc(draft.claimCap || "") + ". " + esc(draft.posRedemption || "") + " is a point-of-sale request, not enforcement by the barcode.</p></div>" +
    '<div class="card" data-testid="pos-preview"><h2>Barcode preview</h2>' + preview + "</div>";
}
async function savePos(form) {
  const data = new FormData(form);
  const body = {
    offer: data.get("offer"),
    conditions: data.get("conditions"),
    start: data.get("start"),
    end: data.get("end"),
    siteIds: data.getAll("siteIds"),
    posRedemption: data.get("posRedemption"),
    distribution: data.get("distribution") || "shareable-claim-link",
    claimCap: Number(data.get("claimCap") || 100),
    codeValue: data.get("codeValue") || "",
    etag: state.posDraft?.etag || "",
  };
  const err = $("#pos-error");
  try {
    const saved = state.posDraft?.id
      ? await api("/api/pos-drafts/" + encodeURIComponent(state.posDraft.id), { method: "PATCH", body: JSON.stringify(body) })
      : await api("/api/pos-drafts", { method: "POST", body: JSON.stringify(body) });
    state.posDrafts = await api("/api/pos-drafts");
    toast("Draft saved");
    if (!state.posDraft?.id) go("pos/" + saved.id);
    else { state.posDraft = saved; render({ refetch: false, keepScroll: true }); }
  } catch (e) { if (err) err.textContent = e.message; else toast(e.message); }
}
function assetValues() {
  const form = document.getElementById("asset-form");
  const data = new FormData(form);
  return {
    heading: String(data.get("heading") ?? ""),
    payload: String(data.get("payload") ?? ""),
    batch: String(data.get("batch") ?? ""),
    uppercase: data.get("uppercase") === "on",
    moduleMm: data.get("moduleMm"),
    ratio: data.get("ratio"),
    barHeightMm: data.get("barHeightMm"),
    quietModules: data.get("quietModules"),
    labelWidthMm: data.get("labelWidthMm"),
    labelHeightMm: data.get("labelHeightMm"),
  };
}
function assetModel() {
  const values = assetValues();
  const layout = readLayout(values);
  const single = layout.errors.length ? { error: layout.errors[0] } : validatePayload(values.payload, { uppercase: values.uppercase });
  const batch = layout.errors.length ? { items: [], errors: layout.errors.map((error) => ({ line: 0, error })) } : parseBatch(values.batch, { uppercase: values.uppercase });
  return { values, layout, single, batch };
}
function assetLabel(payload, layout, heading) {
  const drawn = code39Svg(payload, layout, heading);
  return { payload, heading, ...drawn, name: safeAssetName(payload) + ".svg" };
}
function paintAsset() {
  const preview = document.getElementById("asset-preview");
  const notes = document.getElementById("asset-notes");
  if (!preview || !notes) return;
  const model = assetModel();
  const blocks = [];
  if (model.single.error) blocks.push('<p class="err" data-testid="asset-single-error">' + esc(model.single.error) + "</p>");
  else {
    const label = assetLabel(model.single.payload, model.layout, model.values.heading);
    const converted = model.single.converted ? '<p class="small">Entered ' + esc(model.values.payload) + ". Encoded " + esc(label.payload) + " because uppercase conversion is confirmed.</p>" : "";
    const overflow = label.notes.map((note) => '<p class="err" data-testid="asset-overflow">' + esc(note) + "</p>").join("");
    blocks.push('<div data-testid="asset-barcode">' + label.svg + "</div>" + converted + overflow + '<p class="small muted">File size ' + label.widthMm.toFixed(1) + " × " + label.heightMm.toFixed(1) + " mm. The on-screen picture may scale to fit. The downloaded file keeps these millimetres.</p>");
  }
  if (model.layout.errors.length) blocks.push("");
  else if (!String(model.values.batch).replace(/\r/g, "").split("\n").some((line) => line !== "")) {
    blocks.push('<p class="muted small">Batch is empty. Add one ID per line when you want a sheet.</p>');
  } else if (model.batch.errors.length) {
    blocks.push('<div data-testid="asset-batch-errors">' + model.batch.errors.slice(0, 8).map((item) => '<p class="err">Line ' + item.line + ": " + esc(item.error) + "</p>").join("") + "</div>");
  } else {
    const shown = model.batch.items.slice(0, 3).map((item) => {
      const label = assetLabel(item.payload, model.layout, model.values.heading);
      const converted = item.converted ? "<figcaption class=\"small\">Encoded " + esc(item.payload) + " from " + esc(item.entered) + "</figcaption>" : "";
      return "<figure>" + label.svg + converted + "</figure>";
    }).join("");
    const extra = model.batch.items.length > 3 ? '<p class="small muted">' + (model.batch.items.length - 3) + " more IDs are included in the ZIP and the print sheet.</p>" : "";
    blocks.push('<div data-testid="asset-batch">' + shown + extra + "</div>");
  }
  preview.innerHTML = blocks.join("");
  notes.textContent = "Code 39, no checksum. A scanner may report ]A0 before the ID. That prefix is not in the bars or the text.";
}
function saveAssetBlob(name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function assetStatus(message) {
  const status = document.getElementById("asset-copy");
  if (status) status.textContent = message;
}
async function copyAssetSvg(svg) {
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(svg);
      copied = true;
    }
  } catch { copied = false; }
  if (!copied) {
    try {
      const area = document.createElement("textarea");
      area.value = svg;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    } catch { copied = false; }
  }
  assetStatus(copied ? "SVG copied." : "Copy was blocked. The SVG was not copied. Download it instead.");
}
function printAssetHtml(html) {
  let frame = document.getElementById("asset-print-frame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "asset-print-frame";
    frame.title = "Asset label print";
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
  }
  const doc = frame.contentDocument;
  doc.open();
  doc.write(html);
  doc.close();
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    assetStatus("Print dialog opened. The labels are in a hidden frame, not a new window.");
  } catch {
    assetStatus("Print could not be opened in this browser.");
  }
}
function uniqueAssetName(payload, used) {
  const stem = safeAssetName(payload);
  let name = stem + ".svg";
  let n = 2;
  while (used.has(name)) {
    name = stem.slice(0, 70) + "-" + n + ".svg";
    n += 1;
  }
  used.add(name);
  return name;
}
function assetAction(act) {
  const model = assetModel();
  if (model.layout.errors.length) {
    assetStatus(model.layout.errors[0]);
    return;
  }
  const heading = model.values.heading;
  if (act === "asset-download" || act === "asset-copy" || act === "asset-print") {
    if (model.single.error) {
      assetStatus(model.single.error);
      return;
    }
    const label = assetLabel(model.single.payload, model.layout, heading);
    if (act === "asset-download") {
      saveAssetBlob(label.name, label.svg, "image/svg+xml");
      assetStatus("Downloaded " + label.name + ".");
    } else if (act === "asset-copy") return copyAssetSvg(label.svg);
    else printAssetHtml(printHtml([label]));
    return;
  }
  if (model.batch.errors.length) {
    assetStatus("Fix the batch before exporting. Nothing was downloaded.");
    return;
  }
  if (!model.batch.items.length) {
    assetStatus("Add at least one ID to the batch.");
    return;
  }
  const used = new Set();
  const labels = model.batch.items.map((item) => {
    const label = assetLabel(item.payload, model.layout, heading);
    label.name = uniqueAssetName(item.payload, used);
    return label;
  });
  if (act === "asset-zip") {
    const zip = zipStore(labels.map((label) => ({ name: label.name, data: label.svg })));
    saveAssetBlob("asset-barcodes.zip", zip, "application/zip");
    assetStatus("Downloaded asset-barcodes.zip with " + labels.length + " SVG files.");
  } else if (act === "asset-sheet") printAssetHtml(printHtml(labels));
}
function assetPage() {
  const d = CODE39_DEFAULTS;
  return '<div class="asset-page" id="asset-page" data-testid="asset-page"><div class="page-head"><div><p class="asset-kicker">Asset labels</p><h1>Asset Barcodes</h1><p class="muted">Equipment stickers use standard Code 39. This tab does not create POS vouchers, offers, or claim links.</p></div></div>'
    + '<form id="asset-form" class="asset-layout"><div class="card"><h2>Single ID</h2><label class="field"><span>Asset ID</span><input name="payload" data-testid="asset-id" value="' + esc(d.payload) + '" autocomplete="off" spellcheck="false" maxlength="40"></label>'
    + '<label class="check"><input type="checkbox" name="uppercase" value="on"> Convert lower-case letters to uppercase. I confirm this change.</label>'
    + '<label class="field"><span>Label heading</span><input name="heading" data-testid="asset-heading" value="' + esc(d.heading) + '" maxlength="80"></label>'
    + '<h2>Batch</h2><label class="field"><span>One ID per line</span><textarea name="batch" data-testid="asset-batch" maxlength="4000" placeholder="LOC50924&#10;TEST-1"></textarea></label>'
    + '<p class="small muted">Empty lines are skipped. Up to 40 IDs, 40 characters each. Interior spaces stay in the ID.</p>'
    + '<h2>Label size</h2><div class="asset-dims">'
    + '<label class="field"><span>Label width (mm)</span><input name="labelWidthMm" type="number" min="20" max="150" step="1" value="' + d.labelWidthMm + '"></label>'
    + '<label class="field"><span>Label height (mm)</span><input name="labelHeightMm" type="number" min="15" max="80" step="1" value="' + d.labelHeightMm + '"></label>'
    + '<label class="field"><span>Narrow module (mm)</span><input name="moduleMm" type="number" min="0.19" max="1" step="0.01" value="' + d.moduleMm + '"></label>'
    + '<label class="field"><span>Wide to narrow</span><input name="ratio" type="number" min="2" max="3" step="0.1" value="' + d.ratio + '"></label>'
    + '<label class="field"><span>Bar height (mm)</span><input name="barHeightMm" type="number" min="5" max="40" step="0.5" value="' + d.barHeightMm + '"></label>'
    + '<label class="field"><span>Quiet zone (modules)</span><input name="quietModules" type="number" min="10" max="30" step="1" value="' + d.quietModules + '"></label>'
    + '</div><p class="small muted">Quiet zone stays at least 10 narrow modules. If the bars do not fit the label, the message says so. The module width is not reduced to force a fit.</p>'
    + '<div class="asset-actions"><button class="btn" type="button" data-act="asset-download">Download SVG</button><button class="btn ghost" type="button" data-act="asset-copy">Copy SVG</button><button class="btn ghost" type="button" data-act="asset-print">Print label</button><button class="btn ghost" type="button" data-act="asset-zip">Download batch ZIP</button><button class="btn ghost" type="button" data-act="asset-sheet">Print sheet</button></div>'
    + '<p id="asset-copy" class="small" role="status" data-testid="asset-status"></p></div>'
    + '<div class="card"><h2>Preview</h2><div id="asset-preview" class="asset-preview"></div><p id="asset-notes" class="asset-note small"></p></div></form></div>';
}
function visitorDenied() {
  return '<h2>Visitor records are restricted</h2><p data-testid="visitor-denied">Visitor records are restricted. Sign in with your authorised email account to view them.</p><p><button class="btn" type="button" data-act="visitor-email-signin" data-testid="visitor-email-signin">Sign in with email</button></p>';
}
function visitorPage() {
  return '<div id="visitor-page" data-testid="visitor-page"><div class="page-head"><div><h1>Visitor log</h1><p class="muted">One general form. The visitor types the site. It is not a site from the directory, and it is not tied to a site QR.</p></div></div><div id="visitor-body" class="card">Loading…</div></div>';
}
async function paintVisitor() {
  const box = document.getElementById("visitor-body");
  if (!box) return;
  if (route().id) return paintVisitorRecord(route().id);
  const readiness = await fetch("/api/visitor-log/readiness", { credentials: "same-origin" }).then((res) => res.json()).catch(() => null);
  if (!readiness?.granted) {
    box.innerHTML = visitorDenied();
    return;
  }
  const params = new URLSearchParams();
  const status = document.getElementById("visitor-status")?.value || "all";
  const from = document.getElementById("visitor-from")?.value || "";
  const to = document.getElementById("visitor-to")?.value || "";
  const location = document.getElementById("visitor-location")?.value || "";
  if (status && status !== "all") params.set("status", status);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (location) params.set("location", location);
  const listed = await fetch("/api/visitor-log/visits?" + params.toString(), { credentials: "same-origin" }).then((res) => res.json());
  const settings = await fetch("/api/visitor-log/settings", { credentials: "same-origin" }).then((res) => res.json());
  const maintenance = await fetch("/api/visitor-log/maintenance", { credentials: "same-origin" }).then((res) => res.json()).catch(() => ({ numbers: [] }));
  const maintenanceFields = [0, 1, 2, 3].map((i) => '<label class="field"><span>Maintenance line ' + (i + 1) + '</span><input id="visitor-maintenance-' + i + '" type="tel" inputmode="tel" maxlength="24" placeholder="Blank to hide" value="' + esc((maintenance.numbers || [])[i] || "") + '" data-testid="visitor-maintenance-input"></label>').join("");
  const rows = (listed.visits || []).map((visit) => {
    const notes = [visit.issues ? "In: " + visit.issues : "", visit.signOutIssues ? "Out: " + visit.signOutIssues : ""].filter(Boolean).join(" · ");
    const brief = notes.length > 80 ? notes.slice(0, 77) + "…" : notes;
    return '<tr data-testid="visitor-row"><td><button class="text-btn" type="button" data-go="visitors/' + esc(visit.id) + '">' + esc(visit.location) + '</button></td><td>' + esc(visit.name) + '</td><td>' + esc(visit.phone) + '</td><td>' + esc(visit.signedInMelbourne) + '</td><td>' + esc(visit.signedOutMelbourne || "On site") + '</td><td>' + (visit.cardReturned ? "Yes" : "") + '</td><td>' + esc(visit.photoStatus) + '</td><td>' + esc(brief) + '</td><td>' + (visit.photoStatus === "stored" ? '<button class="btn ghost" type="button" data-act="visitor-photo" data-id="' + esc(visit.id) + '">View ID</button>' : "") + (visit.onSite ? ' <button class="btn ghost" type="button" data-act="visitor-recover" data-id="' + esc(visit.id) + '">Replace receipt</button>' : "") + '</td></tr>';
  }).join("");
  box.innerHTML = '<p data-testid="visitor-blockers">' + esc((readiness.blockers || []).join(", ") || "Collection is open for this test configuration.") + '</p>'
    + '<p class="muted">Sign in: <a href="/visit/sign-in">/visit/sign-in</a>. Sign out: <a href="/visit/sign-out">/visit/sign-out</a>. The combined page remains at <a href="/visit">/visit</a>.</p>'
    + '<div class="asset-dims"><label class="field"><span>On site or history</span><select id="visitor-status"><option value="all">All</option><option value="in">On site</option><option value="out">Signed out</option></select></label>'
    + '<label class="field"><span>From</span><input id="visitor-from" type="date" value="' + esc(from) + '"></label>'
    + '<label class="field"><span>To</span><input id="visitor-to" type="date" value="' + esc(to) + '"></label>'
    + '<label class="field"><span>Location contains</span><input id="visitor-location" value="' + esc(location) + '"></label></div>'
    + '<div class="asset-actions"><button class="btn ghost" type="button" data-act="visitor-filter">Apply filters</button><button class="btn ghost" type="button" data-act="visitor-export">Export CSV</button></div>'
    + '<div class="table-wrap" data-testid="visitor-list"><table><thead><tr><th>Location</th><th>Name</th><th>Phone</th><th>Signed in</th><th>Signed out</th><th>Card</th><th>Photo</th><th>Issues</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="9">No visits.</td></tr>') + '</tbody></table></div>'
    + '<h2>Notifications</h2><p class="muted">Off unless you explicitly enable them. The only eligible recipient is Joshua\'s existing visitor-log access. Saving this does not grant access to anyone else.</p>'
    + '<label class="check"><input id="visitor-enabled" type="checkbox"' + (settings.enabled ? " checked" : "") + '> Enabled</label>'
    + '<label class="field"><span>Events</span><select id="visitor-events"><option value="both">Sign-in and sign-out</option><option value="in">Sign-in only</option><option value="out">Sign-out only</option></select></label>'
    + '<button class="btn" type="button" data-act="visitor-save">Save notification settings</button><p id="visitor-note" class="small"></p>'
    + '<h2>Maintenance phone numbers</h2><p class="muted">Shown to visitors on the "Thanks for signing in" screen under "Need the locker access code? Call maintenance:". Same numbers for every site and form. Leave all four blank to hide the block. No staff names are shown.</p>'
    + '<div data-testid="visitor-maintenance">' + maintenanceFields + '</div>'
    + '<button class="btn" type="button" data-act="visitor-maintenance-save">Save maintenance numbers</button><p id="visitor-maintenance-note" class="small"></p>'
    + '<h2>Spreadsheet connection</h2><p class="muted">The public form stays closed. This writes one synthetic row on the Visits tab and then clears it. No email is sent.</p>'
    + '<label class="check"><input id="visitor-sheet-check" type="checkbox"> I am running the one synthetic sheet check.</label>'
    + '<button class="btn" type="button" data-act="visitor-sheet-check">Run connection check</button><p id="visitor-sheet-note" class="small" data-testid="visitor-sheet-note"></p>';
  const events = document.getElementById("visitor-events");
  if (events && settings.events) events.value = settings.events;
  const statusSelect = document.getElementById("visitor-status");
  if (statusSelect) statusSelect.value = status || "all";
}
async function paintVisitorRecord(id) {
  const box = document.getElementById("visitor-body");
  const readiness = await fetch("/api/visitor-log/readiness", { credentials: "same-origin" }).then((res) => res.json()).catch(() => null);
  if (!readiness?.granted) {
    box.innerHTML = visitorDenied();
    return;
  }
  const response = await fetch("/api/visitor-log/visits/" + encodeURIComponent(id), { credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    box.innerHTML = '<p data-testid="visitor-missing">' + esc(body.error || "That record is not available.") + '</p><p><button class="btn ghost" type="button" data-go="visitors">Back</button></p>';
    return;
  }
  const visit = body.visit;
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="visitors">Back</button></p>'
    + '<div data-testid="visitor-record"><h2>' + esc(visit.location) + '</h2>'
    + '<p>' + esc(visit.name) + ' · ' + esc(visit.phone) + ' · ' + esc(visit.company) + '</p>'
    + '<p>Signed in ' + esc(visit.signedInMelbourne) + '</p>'
    + '<p>Signed out ' + esc(visit.signedOutMelbourne || "Still on site") + '</p>'
    + '<p>Shell card ' + (visit.cardReturned ? "returned" : "not recorded") + '</p>'
    + '<p>Photo ' + esc(visit.photoStatus) + '</p>'
    + (visit.issues ? '<p data-testid="visitor-issues-in">Sign-in: ' + esc(visit.issues) + '</p>' : '')
    + (visit.signOutIssues ? '<p data-testid="visitor-issues-out">Sign-out: ' + esc(visit.signOutIssues) + '</p>' : '')
    + (visit.review ? '<p data-testid="visitor-review">Flagged for review: ' + esc(visit.review) + '</p>' : '')
    + (visit.photoStatus === "stored" ? '<button class="btn" type="button" data-act="visitor-photo" data-id="' + esc(visit.id) + '">View ID photo</button>' : '')
    + '<p class="err">Deleting removes the written record and the ID photo. This cannot be undone in Express Help.</p>'
    + '<label class="check"><input id="visitor-delete-confirm" type="checkbox"> I understand this permanently deletes the record.</label>'
    + '<button class="btn danger" type="button" data-act="visitor-delete" data-id="' + esc(visit.id) + '">Delete record</button>'
    + '</div><p id="visitor-note" class="small"></p>';
}
async function visitorAction(button) {
  const act = button.dataset.act;
  if (act === "visitor-filter") return paintVisitor();
  if (act === "visitor-export") {
    const response = await fetch("/api/visitor-log/export", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Export was not available");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "visitor-log.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return;
  }
  if (act === "visitor-photo") {
    const response = await fetch("/api/visitor-log/visits/" + encodeURIComponent(button.dataset.id) + "/photo", { credentials: "same-origin" });
    if (!response.ok) throw new Error("The ID photo is not available");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  if (act === "visitor-recover") {
    const response = await fetch("/api/visitor-log/visits/" + encodeURIComponent(button.dataset.id) + "/recover", { method: "POST", credentials: "same-origin" });
    const body = await response.json().catch(() => ({}));
    const note = document.getElementById("visitor-note");
    if (note) note.textContent = response.ok ? "Replacement receipt, shown once: " + body.receipt : (body.error || "Recovery failed");
    return;
  }
  if (act === "visitor-delete") {
    if (!document.getElementById("visitor-delete-confirm")?.checked) throw new Error("Confirm the permanent deletion first.");
    const response = await fetch("/api/visitor-log/visits/" + encodeURIComponent(button.dataset.id) + "/delete", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The record was not deleted");
    location.hash = "#/visitors";
    return;
  }
  if (act === "visitor-sheet-check") {
    if (!document.getElementById("visitor-sheet-check")?.checked) throw new Error("Confirm the connection check first.");
    const response = await fetch("/api/visitor-log/sheet-check", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "CHECK" }),
    });
    const body = await response.json().catch(() => ({}));
    const note = document.getElementById("visitor-sheet-note");
    const stage = typeof body.stage === "string" && /^[a-z-]+$/.test(body.stage) ? body.stage : "";
    if (note) note.textContent = response.ok ? (body.ok ? "verified" : stage || "The check did not finish") : (body.error || "The check did not run");
    return;
  }
  if (act === "visitor-maintenance-save") {
    const numbers = [0, 1, 2, 3].map((i) => document.getElementById("visitor-maintenance-" + i)?.value || "");
    const response = await fetch("/api/visitor-log/maintenance", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ numbers }),
    });
    const body = await response.json().catch(() => ({}));
    const note = document.getElementById("visitor-maintenance-note");
    const shown = (body.numbers || []).filter(Boolean).length;
    if (note) note.textContent = response.ok ? (shown ? "Saved. " + shown + " number" + (shown === 1 ? "" : "s") + " shown to visitors." : "Saved. The block is hidden.") : (body.error || "Numbers were not saved");
    return;
  }
  if (act === "visitor-save") {
    const response = await fetch("/api/visitor-log/settings", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: document.getElementById("visitor-enabled").checked, events: document.getElementById("visitor-events").value }),
    });
    const body = await response.json().catch(() => ({}));
    const note = document.getElementById("visitor-note");
    if (note) note.textContent = response.ok ? (body.enabled ? "Notifications enabled for " + body.recipient : "Notifications are off.") : (body.error || "Settings were not saved");
  }
}
function placeholder(title, body) {
  return '<div class="page-head"><h1>' + title + '</h1></div><div class="card empty"><div class="empty-mark">L</div><h2>' + title + '</h2><p class="muted">' + body + "</p></div>";
}
function pageFor(r) {
  if (r.name === "home") return homeHtml();
  if (r.name === "links") return listHtml("link");
  if (r.name === "qrcodes") return listHtml("qr");
  if (r.name === "analytics") return analyticsPage();
  if (r.name === "pages") return pagesList();
  if (r.name === "competitions") return competitionsList();
  if (r.name === "sites") return sitesPage();
  if (r.name === "pos") return posList();
  if (r.name === "assets") return assetPage();
  if (r.name === "visitors") return visitorPage();
  if (r.name === "tickets") return ticketShell();
  if (r.name === "domains") return domainsPage();
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
  } else if (r.name === "pages" && r.id === "new") {
    if (routeChanged) state.pageDraft = blankPage();
    state.pageDetail = null;
    view.innerHTML = pageEditor();
  } else if (r.name === "pages" && r.id) {
    if (!(opts.refetch === false && state.pageDraft?.slug === r.id)) {
      if (!keep) view.innerHTML = '<div class="card muted">Loading…</div>';
      try {
        const data = await api("/api/pages/" + encodeURIComponent(r.id));
        if (gen !== renderGen) return;
        state.pageDetail = data;
        state.pageDraft = structuredClone(data.page);
      } catch (e) {
        if (gen !== renderGen) return;
        view.innerHTML = '<div class="card"><h2>Not found</h2><p>' + esc(e.message) + '</p><p><button class="btn ghost" type="button" data-go="pages">Pages</button></p></div>';
        return;
      }
    }
    view.innerHTML = pageEditor();
  } else if (r.name === "competitions" && r.id === "new") {
    if (routeChanged) state.compDraft = blankCompetition();
    state.compDetail = null;
    view.innerHTML = competitionEditor();
  } else if (r.name === "competitions" && r.id) {
    if (!(opts.refetch === false && state.compDraft?.slug === r.id)) {
      if (!keep) view.innerHTML = '<div class="card muted">Loading…</div>';
      try {
        const data = await api("/api/competitions/" + encodeURIComponent(r.id));
        if (gen !== renderGen) return;
        state.compDetail = data;
        state.compDraft = structuredClone(data.competition);
      } catch (e) {
        if (gen !== renderGen) return;
        view.innerHTML = '<div class="card"><h2>Not found</h2><p>' + esc(e.message) + '</p><p><button class="btn ghost" type="button" data-go="competitions">Competitions</button></p></div>';
        return;
      }
    }
    view.innerHTML = competitionEditor();
  } else if (r.name === "pos" && r.id) {
    try { state.identityStatus = await api("/api/identity/status"); } catch { state.identityStatus = null; }
    if (r.id === "new") {
      if (routeChanged) state.posDraft = blankPos();
    } else if (!(opts.refetch === false && state.posDraft?.id === r.id)) {
      if (!keep) view.innerHTML = '<div class="card muted">Loading…</div>';
      try {
        state.posDraft = await api("/api/pos-drafts/" + encodeURIComponent(r.id));
        state.identityStatus = await api("/api/identity/status").catch(() => null);
        if (gen !== renderGen) return;
      } catch (e) {
        if (gen !== renderGen) return;
        view.innerHTML = '<div class="card"><h2>Not found</h2><p>' + esc(e.message) + '</p><p><button class="btn ghost" type="button" data-go="pos">POS setup</button></p></div>';
        return;
      }
    }
    view.innerHTML = posEditor();
  } else {
    if (r.name !== "pages") state.pageDraft = state.pageDraft;
    view.innerHTML = pageFor(r);
    if (r.name === "assets") paintAsset();
    if (r.name === "visitors") paintVisitor();
    if (r.name === "tickets") paintTickets(r.id, state).catch((err) => { const box = document.getElementById("ticket-body"); if (box) box.textContent = err.message; });
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
    paintAvatar();
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
  if (act === "comp-poster" || act === "code-poster") return openPoster(act === "comp-poster" ? "/api/competitions/" + encodeURIComponent(state.compDraft.slug) + "/poster?size=" + (el.dataset.size || "a4") : "/api/codes/" + encodeURIComponent(state.detail.code.slug) + "/poster?size=" + (el.dataset.size || "a4"));
  if (act === "check-link") {
    const result = await api("/api/health", { method: "POST", body: JSON.stringify({ slug: state.detail.code.slug }) });
    state.detail.health = result.checked?.[0] || null;
    toast("Checked: " + (state.detail.health?.status || "unknown"));
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "save-template") {
    await api("/api/templates", { method: "POST", body: JSON.stringify({ kind: "competition", slug: state.compDraft.slug, name: state.compDraft.name }) });
    state.templates = await api("/api/templates");
    toast("Template saved");
    return;
  }
  if (act === "winner-notice") {
    const draft = await api("/api/competitions/" + encodeURIComponent(state.compDraft.slug) + "/winners/" + encodeURIComponent(el.dataset.winner) + "/notice");
    const box = $("#notice-draft");
    if (box) box.innerHTML = '<h3>Review only</h3><p class="muted small">' + (draft.recipientKnown ? "To: " + esc(draft.to) : esc(draft.recipientNote)) + "</p><pre data-testid=\"notice-text\">" + esc(draft.text) + '</pre><div class="row"><button class="btn ghost" type="button" data-act="copy-notice">Copy</button><button class="btn ghost" type="button" data-act="download-notice">Download</button></div>';
    state.notice = draft;
    return;
  }
  if (act === "copy-notice") { await copyText(state.notice?.text || ""); return; }
  if (act === "download-notice") {
    downloadBlob("prize-notice.txt", new Blob([state.notice?.text || ""], { type: "text/plain" }));
    return;
  }
  if (act === "apply-import") { await applyImport(); return; }
  if (act === "pos-approval-request" || act === "pos-approve" || act === "pos-reject" || act === "pos-send-quickfuel") {
    const path = act === "pos-approval-request" ? "/approval-request" : act === "pos-send-quickfuel" ? "/send-quickfuel" : "/decision";
    const body = { etag: state.posDraft?.etag, revision: state.posDraft?.revision, digest: state.posDraft?.materialDigest };
    if (act === "pos-approval-request") body.approverKey = "";
    if (act === "pos-approve") body.decision = "approve";
    if (act === "pos-reject") body.decision = "reject";
    if (act === "pos-send-quickfuel") {
      if (!$("#pos-confirm-send")?.checked) throw new Error("Confirm the Quickfuel recipient first");
      body.confirm = true;
      body.recipient = "support@quickfuel.com.au";
    }
    const result = await api("/api/pos-drafts/" + encodeURIComponent(state.posDraft.id) + path, { method: "POST", body: JSON.stringify(body) });
    if (result.draft) state.posDraft = result.draft;
    toast(result.mock ? "Recorded by the local mail mock. No provider was contacted." : result.sent ? "Email accepted by the provider" : (result.error || result.status || "Not sent"));
    render();
    return;
  }
  if (act === "pos-download") {
    const response = await fetch("/api/pos-drafts/" + encodeURIComponent(state.posDraft.id) + "/package", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not download the package");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "pos-setup-" + state.posDraft.id + ".zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  if (act === "visitor-email-signin") {
    await api("/api/auth", { method: "DELETE" });
    state.actor = { authenticated: false };
    state.codes = [];
    state.detail = null;
    showLogin("", true);
    return;
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
  if (act === "add-field") {
    capturePageDraft();
    const type = $("#new-field-type")?.value || "text";
    state.pageDraft.fields.push({ id: Math.random().toString(16).slice(2, 10), type, label: "New field", required: false, options: type === "dropdown" ? ["Option 1"] : [] });
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "remove-field") { capturePageDraft(); state.pageDraft.fields = state.pageDraft.fields.filter((f) => f.id !== el.dataset.id); render({ refetch: false, keepScroll: true }); return; }
  if (act === "field-up") return moveField(el.dataset.id, -1);
  if (act === "field-down") return moveField(el.dataset.id, 1);
  if (act === "clear-hero") {
    const hidden = document.querySelector("[name=heroData]");
    if (hidden) hidden.value = "";
    const preview = $("#hero-preview");
    if (preview) { preview.hidden = true; preview.removeAttribute("src"); }
    return;
  }
  if (act === "publish-page") return publishPage();
  if (act === "del-page") {
    openModal("<h2>Delete this page?</h2><p>The public URL and its submissions will be removed.</p><div class='row end'><button class='btn ghost' type='button' data-act='close-modal'>Cancel</button><button class='btn danger' type='button' data-act='confirm-del-page'>Delete</button></div>");
    return;
  }
  if (act === "confirm-del-page") return deletePage();
  if (act === "page-qr") return attachPageCode("qr");
  if (act === "page-link") return attachPageCode("link");
  if (act === "page-csv") return downloadPageCsv();
  if (act === "add-cfield") {
    captureCompDraft();
    const type = $("#new-cfield-type")?.value || "text";
    state.compDraft.fields.push({ id: Math.random().toString(16).slice(2, 10), type, label: "New field", required: false, role: "", options: type === "dropdown" ? ["Option 1"] : [] });
    render({ refetch: false, keepScroll: true });
    return;
  }
  if (act === "remove-cfield") { captureCompDraft(); state.compDraft.fields = state.compDraft.fields.filter((f) => f.id !== el.dataset.id); render({ refetch: false, keepScroll: true }); return; }
  if (act === "cfield-up") return moveCompField(el.dataset.id, -1);
  if (act === "cfield-down") return moveCompField(el.dataset.id, 1);
  if (act === "del-comp") {
    openModal("<h2>Delete this competition?</h2><p>Entries and the public page will be removed. Linked QR codes stay until you delete them.</p><div class='row end'><button class='btn ghost' type='button' data-act='close-modal'>Cancel</button><button class='btn danger' type='button' data-act='confirm-del-comp'>Delete</button></div>");
    return;
  }
  if (act === "confirm-del-comp") {
    const slug = state.compDraft?.slug;
    if (!slug) return;
    await api("/api/competitions/" + encodeURIComponent(slug), { method: "DELETE" });
    closeModal();
    state.competitions = (state.competitions || []).filter((c) => c.slug !== slug);
    toast("Deleted");
    go("competitions");
    return;
  }
  if (act === "comp-draw") {
    openModal("<h2>Draw a winner?</h2><p>One person is picked at random from this period’s valid entries. Those entries are then archived.</p><div class='row end'><button class='btn ghost' type='button' data-act='close-modal'>Cancel</button><button class='btn' type='button' data-act='confirm-draw'>Draw</button></div>");
    return;
  }
  if (act === "confirm-draw") { closeModal(); return drawCompetition(false); }
  if (act === "comp-redraw") return drawCompetition(true, el.dataset.draw);
  if (act === "comp-csv") return downloadCompCsv();
  if (act === "comp-import") return importCompetition();
  if (act === "clear-comp-hero") {
    const hidden = document.querySelector('#comp-editor [name="heroData"]');
    const url = document.querySelector('#comp-editor [name="heroUrl"]');
    if (hidden) hidden.value = "";
    if (url) url.value = "";
    paintCompPreview();
    return;
  }
  if (act === "clear-comp-logo") {
    const hidden = document.querySelector('#comp-editor [name="logoData"]');
    if (hidden) hidden.value = "";
    paintCompPreview();
    return;
  }
  if (act === "comp-filter") {
    captureCompDraft();
    state.compView = { period: $("#comp-period")?.value || "current", status: $("#comp-status")?.value || "all" };
    render({ refetch: false, keepScroll: true });
    return;
  }
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
  const hits = state.codes.filter((c) => [c.name, c.slug, c.url, ...(c.tags || [])].join(" ").toLowerCase().includes(q)).slice(0, 6);
  const pageHitsFound = (state.pages || []).filter((p) => [p.name, p.slug, p.title].join(" ").toLowerCase().includes(q)).slice(0, 4);
  const compHits = (state.competitions || []).filter((c) => [c.name, c.slug, ...(c.sites || [])].join(" ").toLowerCase().includes(q)).slice(0, 4);
  box.classList.remove("hidden");
  const buttons = hits.map((c) => '<button type="button" data-go="' + (c.hasQr ? "qrcodes/" : "links/") + encodeURIComponent(c.slug) + '"><strong>' + esc(c.name || c.slug) + '</strong><span class="muted small">' + (c.hasQr ? "QR code" : "Short link") + " · /r/" + esc(c.slug) + "</span></button>").concat(pageHitsFound.map((p) => '<button type="button" data-go="pages/' + encodeURIComponent(p.slug) + '"><strong>' + esc(p.name || p.slug) + '</strong><span class="muted small">Page · /p/' + esc(p.slug) + "</span></button>"), compHits.map((c) => '<button type="button" data-go="competitions/' + encodeURIComponent(c.slug) + '"><strong>' + esc(c.name || c.slug) + '</strong><span class="muted small">Competition · /c/' + esc(c.slug) + "</span></button>"));
  box.innerHTML = buttons.join("") || '<div class="muted pad">No matches</div>';
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
  if (actEl && actEl.closest("#ticket-page")) {
    Promise.resolve(ticketAction(actEl, state, go)).catch((err) => { const note = document.getElementById("ticket-note-msg"); if (note) note.textContent = err.message; else toast(err.message); });
    return;
  }
  if (actEl && actEl.closest("#visitor-page")) {
    Promise.resolve(visitorAction(actEl)).catch((err) => { const note = document.getElementById("visitor-note"); if (note) note.textContent = err.message; });
    return;
  }
  if (actEl && actEl.closest("#asset-page")) {
    Promise.resolve(assetAction(actEl.dataset.act)).catch((err) => assetStatus(err.message || "Asset label failed"));
    return;
  }
  if (actEl) handleAction(actEl).catch((err) => toast(err.message));
});
document.body.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.act) return;
  e.preventDefault();
  const act = form.dataset.act;
  const run = act === "create" ? onCreate : act === "save-rule" ? onRule : act === "add-tag" ? () => onTag(form) : act === "save-edit" ? () => onEdit(form) : act === "save-customize" ? () => onCustomize(form) : act === "save-bulk" ? onBulk : act === "save-settings" ? () => onSettings(form) : act === "save-page" ? () => savePage() : act === "save-comp" ? () => saveCompetition() : act === "create-site" ? () => createSite(form) : act === "assign-site" ? () => assignRecord(form) : act === "create-staff" ? () => createStaff(form) : act === "save-staff" ? () => saveStaff(form) : act === "save-collection" ? () => saveCollection(form) : act === "copy-comp" ? () => copyCompetition(form) : act === "save-pos" ? () => savePos(form) : act === "preview-import" ? () => previewImport(form) : null;
  if (run) Promise.resolve(run()).catch((err) => toast(err.message));
});
document.body.addEventListener("input", (e) => {
  if (e.target.closest && e.target.closest("#asset-form")) paintAsset();
});
document.body.addEventListener("change", (e) => {
  if (e.target.closest && e.target.closest("#asset-form")) paintAsset();
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
  if (e.target.name && (String(e.target.name).startsWith("color-") || ["comp-bg", "comp-text", "comp-primary"].includes(e.target.name))) syncPageColor(e.target);
  if (e.target.dataset && e.target.dataset.colorText) syncPageColor(e.target);
  if (e.target.id === "comp-period" || e.target.id === "comp-status") {
    captureCompDraft();
    state.compView = { period: $("#comp-period")?.value || "current", status: $("#comp-status")?.value || "all" };
    render({ refetch: false, keepScroll: true });
  }
  if ((e.target.id === "comp-hero-file" || e.target.id === "comp-logo-file") && e.target.files?.[0]) {
    const input = e.target;
    fileToLogo(input.files[0]).then((url) => {
      const name = input.id === "comp-hero-file" ? "heroData" : "logoData";
      const hidden = document.querySelector('#comp-editor [name="' + name + '"]');
      if (hidden) hidden.value = url;
      paintCompPreview();
    }).catch((err) => { const box = $("#comp-error"); if (box) box.textContent = err.message; else toast(err.message); });
  }
  if (e.target.id === "hero-file" && e.target.files?.[0]) {
    fileToLogo(e.target.files[0]).then((url) => {
      const hidden = document.querySelector("[name=heroData]");
      if (hidden) hidden.value = url;
      const preview = $("#hero-preview");
      if (preview) { preview.hidden = false; preview.src = url; }
    }).catch((err) => { const box = $("#page-error"); if (box) box.textContent = err.message; else toast(err.message); });
  }
});
document.body.addEventListener("input", (e) => {
  if (e.target.id === "c-fg-text" || e.target.id === "c-bg-text") {
    if (e.target.id === "c-fg-text") syncColorPair("#c-fg", "#c-fg-text", e.target);
    else syncColorPair("#c-bg", "#c-bg-text", e.target);
    paintCustomize();
  }
  if (e.target.dataset && e.target.dataset.colorText) syncPageColor(e.target);
  if (e.target.closest && e.target.closest("#comp-editor")) paintCompPreview();
});
$("#search").addEventListener("input", () => {
  state.search = $("#search").value.trim();
  paintSearch();
  const name = route().name;
  if (name === "links" || name === "qrcodes" || ((name === "pages" || name === "competitions") && !route().id)) render({ refetch: false, keepScroll: true });
});
async function previewImport(form) {
  const rows = JSON.parse(new FormData(form).get("rows") || "[]");
  const report = await api("/api/sites/import", { method: "POST", body: JSON.stringify({ dryRun: true, rows }) });
  const box = $("#import-report");
  if (box) box.innerHTML = '<p data-testid="import-counts">Create ' + esc(report.counts.create) + ", update " + esc(report.counts.update) + ", unchanged " + esc(report.counts.unchanged) + ", held " + esc(report.counts.held) + ". Sites " + esc(report.readback.sites) + ".</p>" +
    (report.rows || []).map((row) => "<p>" + esc(row.loc) + " " + esc(row.name) + " · " + esc(row.status) + " " + esc(row.reason || "") + "</p>").join("") +
    '<button class="btn" type="button" data-act="apply-import">Apply import</button>';
  state.importRows = rows;
}
async function applyImport() {
  const report = await api("/api/sites/import", { method: "POST", body: JSON.stringify({ dryRun: false, rows: state.importRows || [] }) });
  state.sites = await api("/api/sites");
  toast("Import applied. Create " + report.counts.create + ", held " + report.counts.held);
  render({ refetch: false, keepScroll: true });
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.textContent = "";
  try {
    const email = $("#staff-email")?.value.trim();
    const session = await api("/api/auth", { method: "POST", body: JSON.stringify(email ? { email, password: $("#pw").value } : { password: $("#pw").value }) });
    state.actor = {
      authenticated: true,
      role: session.role || "head",
      name: session.staff?.name || "Head office",
      siteIds: session.role === "manager" ? (session.staff?.siteIds || []) : null,
    };
    await enter();
  } catch (ex) { err.textContent = ex.message; }
});
$("#otp-form")?.addEventListener("submit", (event) => { submitOtp(event).catch((err) => { const box = $("#otp-error"); if (box) box.textContent = err.message; }); });
$("#otp-verify")?.addEventListener("click", () => { submitOtp({ preventDefault() {} }).catch((err) => { const box = $("#otp-error"); if (box) box.textContent = err.message; }); });
$("#identity-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#ident-error");
  err.textContent = "";
  try {
    const session = await api("/api/identity/session", { method: "POST", body: JSON.stringify({ login: $("#ident-login").value.trim(), password: $("#ident-pw").value }) });
    state.actor = { authenticated: true, ...(session.identity || {}), role: session.role };
    await enter();
  } catch (ex) { err.textContent = ex.message; }
});
window.addEventListener("hashchange", () => { if (!$("#shell").classList.contains("hidden")) render(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closePops(); document.querySelectorAll(".menu,#date-pop").forEach((m) => m.classList.add("hidden")); } });

async function openPoster(path) {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Could not build the poster");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank");
  if (!opened) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "poster.html";
    a.click();
  }
  toast("Poster ready");
}
async function copyCompetition(form) {
  const data = new FormData(form);
  const copy = await api("/api/competitions/" + encodeURIComponent(state.compDraft.slug) + "/copy", { method: "POST", body: JSON.stringify({ name: data.get("name"), siteId: data.get("siteId") || "", prize: data.get("prize") || "", start: data.get("start") || "", end: data.get("end") || "" }) });
  state.competitions = await api("/api/competitions");
  toast("Copied as a new draft");
  go("competitions/" + copy.slug);
}
async function createSite(form) {
  await api("/api/sites", { method: "POST", body: JSON.stringify({ name: new FormData(form).get("name") }) });
  state.sites = await api("/api/sites");
  toast("Site added");
  render({ refetch: false, keepScroll: true });
}
async function assignRecord(form) {
  const data = new FormData(form);
  const kind = data.get("kind");
  const slug = data.get("slug");
  const siteId = data.get("siteId");
  const path = kind === "page" ? "/api/pages/" : kind === "competition" ? "/api/competitions/" : "/api/codes/";
  await api(path + encodeURIComponent(slug), { method: "PATCH", body: JSON.stringify({ siteId }) });
  state.codes = await api("/api/codes");
  state.pages = await api("/api/pages");
  state.competitions = await api("/api/competitions");
  toast("Assignment saved");
  render({ refetch: false, keepScroll: true });
}
async function createStaff(form) {
  const data = new FormData(form);
  await api("/api/staff", { method: "POST", body: JSON.stringify({ name: data.get("name"), email: data.get("email"), password: data.get("password"), siteIds: data.get("siteId") ? [data.get("siteId")] : [] }) });
  form.reset();
  state.staff = await api("/api/staff");
  toast("Manager created");
  render({ refetch: false, keepScroll: true });
}
async function saveStaff(form) {
  const data = new FormData(form);
  await api("/api/staff/" + encodeURIComponent(data.get("id")), { method: "PATCH", body: JSON.stringify({ disabled: !!data.get("disabled"), siteIds: data.get("siteId") ? [data.get("siteId")] : [] }) });
  state.staff = await api("/api/staff");
  toast("Manager updated");
  render({ refetch: false, keepScroll: true });
}
async function saveCollection(form) {
  const data = new FormData(form);
  await api("/api/competitions/" + encodeURIComponent(state.compDraft.slug) + "/winners/" + encodeURIComponent(form.dataset.winner) + "/collection", { method: "POST", body: JSON.stringify({ status: data.get("status"), notes: data.get("notes") }) });
  toast("Collection saved");
  render();
}
async function enter() {
  const identity = state.actor?.kind === "verified-identity";
  const jobs = identity
    ? [api("/api/sites"), api("/api/pos-drafts")]
    : [api("/api/settings"), api("/api/codes"), api("/api/pages"), api("/api/competitions"), api("/api/sites"), api("/api/templates"), api("/api/pos-drafts")];
  if (state.actor?.role === "head") jobs.push(api("/api/staff"));
  const loaded = await Promise.all(jobs);
  if (identity) {
    state.settings = { workspaceName: "Liberty" };
    state.codes = [];
    state.pages = [];
    state.competitions = [];
    state.templates = [];
    state.sites = loaded[0];
    state.posDrafts = loaded[1];
    state.staff = [];
  } else {
    const [settings, codes, pages, competitions, sites, templates, posDrafts, staff] = loaded;
    state.settings = settings;
    state.codes = codes;
    state.pages = pages;
    state.competitions = competitions;
    state.sites = sites;
    state.templates = templates;
    state.posDrafts = posDrafts;
    state.staff = staff || [];
  }
  $("#boot").classList.add("hidden");
  $("#login").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  $("#brand-name").textContent = state.settings.workspaceName || "Liberty";
  const roleLabel = state.actor?.kind === "verified-identity" ? (state.actor.role === "approver" ? "Approver" : state.actor.role === "preparer" ? "Preparer" : "No access") + (state.actor.provider === "otp" ? " · email code" : "") : state.actor?.role === "manager" ? "Site manager" : "Head office";
  $("#account-label").innerHTML = "<strong>" + esc(state.actor?.name || state.settings.workspaceName || "Liberty") + "</strong><div class='muted small'>" + roleLabel + "</div>";
  paintAvatar();
  ensureRanges();
  if (!location.hash || location.hash === "#") location.replace("#/home");
  else render();
}
async function boot() {
  try {
    const me = await api("/api/auth");
    if (me.authenticated) {
      state.actor = me;
      await enter();
      return;
    }
    const ident = await api("/api/identity/session");
    if (!ident.authenticated) return showLogin();
    state.actor = { authenticated: true, ...(ident.identity || {}), role: ident.role };
    await enter();
  } catch (e) { showLogin(e.message === "Unauthorized" ? "" : e.message); }
}
boot();
