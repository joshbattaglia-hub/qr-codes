import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/** Product calendar for scan buckets. Matches the Liberty / expresshelp.site audience. */
export const METRICS_TZ = "Australia/Sydney";
export const PUBLIC_FALLBACK = "https://expresshelp.site";
export const DEFAULT_SETTINGS = {
  workspaceName: "Liberty",
  defaultFg: "#111827",
  defaultBg: "#ffffff",
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const DEVICE_VALUES = ["mobile", "tablet", "desktop", "ios", "android", "windows", "macos", "chromeos", "linux"];

let storeFactory = null;
export function setStoreFactory(fn) { storeFactory = fn; }

function openStore(name) {
  if (storeFactory) return storeFactory(name);
  return getStore({ name, consistency: "strong" });
}

export const codes = () => openStore("codes");
export const stats = () => openStore("stats");
export const settingsStore = () => openStore("settings");
export const pagesStore = () => openStore("pages");
export const pageViews = () => openStore("page-views");
export const submissionsStore = () => openStore("submissions");
export const competitionsStore = () => openStore("competitions");
export const compEntries = () => openStore("comp-entries");
export const compFiles = () => openStore("comp-files");
export const compViews = () => openStore("comp-views");
export const sitesStore = () => openStore("sites");
export const staffStore = () => openStore("staff");
export const templatesStore = () => openStore("templates");
export const vouchersStore = () => openStore("vouchers");
export const healthStore = () => openStore("health");

export function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env && typeof Netlify.env.get === "function") {
      const v = Netlify.env.get(name);
      if (v != null && v !== "") return v;
    }
  } catch { /* fall through to process.env */ }
  return process.env[name] || "";
}

export function publicBase() {
  return (env("PUBLIC_URL") || PUBLIC_FALLBACK).replace(/\/$/, "");
}

const secret = () => crypto.createHash("sha256").update("qr-sess:" + env("ADMIN_PASSWORD")).digest();

export function checkPassword(p) {
  const a = Buffer.from(String(p || ""));
  const b = Buffer.from(env("ADMIN_PASSWORD") || "");
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieBase(req) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* leave insecure for local http */ }
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function makeCookie(req) {
  const exp = Date.now() + 7 * 864e5;
  const sig = crypto.createHmac("sha256", secret()).update(String(exp)).digest("hex");
  return `qr_admin=${exp}.${sig}; ${cookieBase(req)}; Max-Age=604800`;
}

export function clearCookie(req) {
  return `qr_admin=; ${cookieBase(req)}; Max-Age=0`;
}

export function authed(req) {
  const m = (req.headers.get("cookie") || "").match(/qr_admin=(\d+)\.([a-f0-9]+)/);
  if (!m || +m[1] < Date.now()) return false;
  const sig = crypto.createHmac("sha256", secret()).update(m[1]).digest("hex");
  try {
    return sig.length === m[2].length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(m[2]));
  } catch { return false; }
}

export const json = (s, o, h = {}) => new Response(JSON.stringify(o), {
  status: s,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...h },
});

/** One-way visitor key. The raw IP is never stored. */
export function visitorHash(ip, ua) {
  return crypto.createHmac("sha256", secret()).update(String(ip || "") + "\n" + String(ua || "")).digest("hex").slice(0, 24);
}

export function parseUA(ua = "") {
  let os = "Other", device = "Desktop", browser = "Other";
  if (/iPhone|iPod/.test(ua)) { os = "iOS"; device = "Mobile"; }
  else if (/iPad/.test(ua)) { os = "iPadOS"; device = "Tablet"; }
  else if (/Android/.test(ua)) { os = "Android"; device = /Mobile/.test(ua) ? "Mobile" : "Tablet"; }
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";
  if (/bot|crawl|spider|curl|wget|python|preview/i.test(ua)) device = "Bot/Other";
  if (/Edg\/|EdgiOS/.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera|OPiOS/.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS/.test(ua)) browser = "Firefox";
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return { os, device, browser };
}

export function readGeo(geo = {}) {
  const country = geo.country;
  const countryCode = (typeof country === "string" ? country : country?.code || "").toUpperCase();
  const countryName = typeof country === "string" ? country : (country?.name || "");
  const cityName = geo.city || "";
  const sub = geo.subdivision?.code || "";
  const city = cityName ? (sub ? `${cityName}, ${sub}` : cityName) : "";
  return {
    countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "",
    countryName: countryName || "",
    cityName,
    city,
  };
}

export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: METRICS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function lastNDays(n, end = new Date()) {
  const endKey = dayKey(end);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(addDays(endKey, -i));
  return keys;
}

export function previousKeys(keys) {
  if (!keys.length) return [];
  return keys.map((_, i) => addDays(keys[0], -(keys.length - i)));
}

export function daysBetween(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) return lastNDays(30);
  const keys = [];
  let cur = from <= to ? from : to;
  const end = from <= to ? to : from;
  while (cur <= end && keys.length < 400) {
    keys.push(cur);
    cur = addDays(cur, 1);
  }
  return keys;
}

export function validUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol); } catch { return false; }
}
export function validSlug(s) { return SLUG.test(s || ""); }
export function validColor(c) { return HEX.test(c || ""); }

export function validLogo(data) {
  if (data == null || data === "") return true;
  return typeof data === "string" && data.startsWith("data:image/png;base64,") && data.length <= 180000;
}

function bucket() {
  return { n: 0, u: [], browser: {}, os: {}, device: {}, country: {}, city: {}, referrer: {} };
}
function blankDay() { return { scan: bucket(), click: bucket() }; }

function addDim(map, key) {
  const k = String(key || "Unknown").slice(0, 80);
  map[k] = (map[k] || 0) + 1;
  const keys = Object.keys(map);
  if (keys.length > 80) {
    const drop = keys.filter((x) => x !== "Other").sort((a, b) => map[a] - map[b])[0];
    if (drop) {
      map.Other = (map.Other || 0) + map[drop];
      delete map[drop];
    }
  }
}

/** Split integer counts across day weights so legacy all-time breakdowns still filter by date. */
export function allocateCounts(map, weights) {
  const result = weights.map(() => ({}));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return result;
  for (const [name, count] of Object.entries(map || {})) {
    const n = Number(count) || 0;
    if (!n) continue;
    const exact = weights.map((w) => (n * w) / sum);
    const floors = exact.map((x) => Math.floor(x));
    let rem = n - floors.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; k < rem; k++) floors[order[k][1]]++;
    floors.forEach((c, i) => { if (c) result[i][name] = c; });
  }
  return result;
}

function ensureDay(day) {
  const scan = { ...bucket(), ...(day?.scan || {}) };
  const click = { ...bucket(), ...(day?.click || {}) };
  scan.u = Array.isArray(day?.scan?.u) ? day.scan.u : [];
  click.u = Array.isArray(day?.click?.u) ? day.click.u : [];
  for (const dim of ["browser", "os", "device", "country", "city", "referrer"]) {
    scan[dim] = { ...(day?.scan?.[dim] || {}) };
    click[dim] = { ...(day?.click?.[dim] || {}) };
  }
  scan.n = day?.scan?.n || 0;
  click.n = day?.click?.n || 0;
  return { scan, click };
}

export function migrateStats(raw) {
  if (!raw) return { v: 2, days: {}, last: null };
  if (raw.v === 2 && raw.days && typeof raw.days === "object") {
    const days = {};
    for (const [k, day] of Object.entries(raw.days)) days[k] = ensureDay(day);
    return { v: 2, days, last: raw.last || null };
  }
  const daily = { ...(raw.daily || {}) };
  let entries = Object.entries(daily).filter(([, n]) => n > 0);
  const total = raw.total || entries.reduce((s, [, n]) => s + n, 0);
  if (!entries.length && total) {
    const k = dayKey(raw.last ? new Date(raw.last) : new Date());
    entries = [[k, total]];
  }
  const weights = entries.map(([, n]) => n);
  const dims = ["device", "os", "referrer", "country", "city", "browser"];
  const allocated = {};
  for (const dim of dims) allocated[dim] = allocateCounts(raw[dim] || {}, weights);
  const days = {};
  entries.forEach(([day, n], i) => {
    const scan = bucket();
    scan.n = n;
    for (const dim of dims) scan[dim] = allocated[dim][i] || {};
    days[day] = { scan, click: bucket() };
  });
  return { v: 2, days, last: raw.last || null };
}

export function recordHit(raw, hit) {
  const s = migrateStats(raw);
  const channel = hit.channel === "click" ? "click" : "scan";
  const day = s.days[hit.day] || (s.days[hit.day] = blankDay());
  const b = day[channel];
  b.n += 1;
  addDim(b.browser, hit.browser);
  addDim(b.os, hit.os);
  addDim(b.device, hit.device);
  addDim(b.country, hit.country || "Unknown");
  addDim(b.city, hit.city || "Unknown");
  addDim(b.referrer, hit.referrer || "Direct / QR scan");
  if (hit.visitor) {
    b.u = b.u || [];
    if (!b.u.includes(hit.visitor) && b.u.length < 500) b.u.push(hit.visitor);
  }
  s.last = hit.at || new Date().toISOString();
  const cutoff = addDays(hit.day || dayKey(), -420);
  for (const k of Object.keys(s.days)) if (k < cutoff) delete s.days[k];
  return s;
}

export function channelFor(code, qrFlag) {
  const c = normalizeCode(code);
  // QR images use ?qr=1. Plain /r/<slug> is a click only for codes created with a short link.
  // Older printed codes have no marker, so unmarked visits stay scans.
  if (qrFlag) return "scan";
  if (c.hasLink && c.qrMarker) return "click";
  return "scan";
}

export function resolveDestination(code, ctx) {
  const parsed = parseUA(ctx.ua || "");
  const geo = ctx.geo || {};
  const matchers = {
    mobile: () => parsed.device === "Mobile",
    tablet: () => parsed.device === "Tablet",
    desktop: () => parsed.device === "Desktop",
    ios: () => parsed.os === "iOS" || parsed.os === "iPadOS",
    android: () => parsed.os === "Android",
    windows: () => parsed.os === "Windows",
    macos: () => parsed.os === "macOS",
    chromeos: () => parsed.os === "ChromeOS",
    linux: () => parsed.os === "Linux",
  };
  for (const rule of code.rules || []) {
    if (!rule || !validUrl(rule.url)) continue;
    if (rule.type === "device") {
      const fn = matchers[String(rule.value || "").toLowerCase()];
      if (fn && fn()) return rule.url;
    } else if (rule.type === "location") {
      const v = String(rule.value || "").trim().toLowerCase();
      if (!v) continue;
      const fields = [geo.countryCode, geo.countryName, geo.cityName, geo.city]
        .filter(Boolean).map((x) => String(x).toLowerCase());
      if (fields.includes(v)) return rule.url;
    }
  }
  return code.url;
}

export function collect(stats, keys, channel) {
  const s = migrateStats(stats);
  const channels = channel === "all" ? ["scan", "click"] : [channel === "click" ? "click" : "scan"];
  const dims = { browser: {}, os: {}, device: {}, country: {}, city: {}, referrer: {} };
  const visitors = new Set();
  let total = 0;
  const series = [];
  for (const key of keys) {
    let n = 0;
    const day = s.days[key];
    for (const ch of channels) {
      const b = day?.[ch];
      if (!b) continue;
      n += b.n || 0;
      for (const dim of Object.keys(dims)) {
        for (const [name, count] of Object.entries(b[dim] || {})) dims[dim][name] = (dims[dim][name] || 0) + count;
      }
      for (const h of b.u || []) visitors.add(h);
    }
    total += n;
    series.push({ date: key, value: n });
  }
  return { total, unique: visitors.size, series, ...dims };
}

export function codeTotals(stats) {
  const s = migrateStats(stats);
  let scans = 0, clicks = 0;
  for (const day of Object.values(s.days)) {
    scans += day.scan?.n || 0;
    clicks += day.click?.n || 0;
  }
  return { scans, clicks, total: scans + clicks, last: s.last || null };
}

function stripBucket(b) {
  if (!b) return { n: 0, browser: {}, os: {}, device: {}, country: {}, city: {}, referrer: {} };
  return {
    n: b.n || 0,
    browser: b.browser || {},
    os: b.os || {},
    device: b.device || {},
    country: b.country || {},
    city: b.city || {},
    referrer: b.referrer || {},
  };
}

/** List payload omits visitor hashes. */
export function statsForList(raw) {
  const s = migrateStats(raw);
  const days = {};
  for (const [k, day] of Object.entries(s.days)) {
    days[k] = { scan: stripBucket(day.scan), click: stripBucket(day.click) };
  }
  return { v: 2, days, last: s.last || null, ...codeTotals(s) };
}

export function normalizeCode(c) {
  if (!c) return c;
  const legacy = c.hasQr == null && c.hasLink == null;
  const style = { fg: DEFAULT_SETTINGS.defaultFg, bg: DEFAULT_SETTINGS.defaultBg, ...(c.style || {}) };
  if (!validColor(style.fg)) style.fg = DEFAULT_SETTINGS.defaultFg;
  if (!validColor(style.bg)) style.bg = DEFAULT_SETTINGS.defaultBg;
  return {
    slug: c.slug,
    url: c.url,
    name: c.name || "",
    notes: c.notes || "",
    paused: !!c.paused,
    created: c.created,
    updated: c.updated || null,
    tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t)).filter(Boolean).slice(0, 20) : [],
    hasQr: legacy ? true : !!c.hasQr,
    hasLink: legacy ? false : !!c.hasLink,
    qrMarker: legacy ? false : !!c.qrMarker,
    destinationType: "url",
    style,
    logoData: typeof c.logoData === "string" ? c.logoData : "",
    rules: Array.isArray(c.rules) ? c.rules : [],
    siteId: typeof c.siteId === "string" ? c.siteId : "",
  };
}

export function publicCode(c, { logo = false } = {}) {
  const n = normalizeCode(c);
  n.hasLogo = !!n.logoData;
  if (!logo) n.logoData = "";
  return n;
}

function cleanTags(tags) {
  const out = [];
  const seen = new Set();
  for (const raw of tags || []) {
    const t = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

export function sanitizeRules(rules) {
  if (!Array.isArray(rules)) return { error: "Rules must be a list" };
  if (rules.length > 25) return { error: "Up to 25 routing rules" };
  const out = [];
  for (const rule of rules) {
    const type = rule?.type === "location" ? "location" : rule?.type === "device" ? "device" : "";
    if (!type) return { error: "Each rule needs a device or location type" };
    const value = String(rule.value || "").trim().slice(0, 80);
    if (!value) return { error: "Each rule needs a value" };
    if (type === "device" && !DEVICE_VALUES.includes(value.toLowerCase())) return { error: "Unknown device rule" };
    if (!validUrl(rule.url)) return { error: "Rule destination must be a valid http(s) URL" };
    out.push({
      id: String(rule.id || crypto.randomBytes(6).toString("hex")).slice(0, 40),
      type,
      value: type === "device" ? value.toLowerCase() : value,
      url: rule.url,
    });
  }
  return { rules: out };
}

export function applyPatch(code, body) {
  const c = { ...code };
  if (body.url !== undefined) {
    if (!validUrl(body.url)) return { error: "Destination must be a valid http(s) URL" };
    c.url = body.url;
  }
  if (body.name !== undefined) c.name = String(body.name).slice(0, 120);
  if (body.notes !== undefined) c.notes = String(body.notes).slice(0, 2000);
  if (body.paused !== undefined) c.paused = !!body.paused;
  if (body.tags !== undefined) c.tags = cleanTags(body.tags);
  if (body.hasLink !== undefined) c.hasLink = !!body.hasLink;
  if (body.hasQr !== undefined) c.hasQr = !!body.hasQr;
  if (body.style !== undefined) {
    const fg = body.style?.fg ?? c.style?.fg;
    const bg = body.style?.bg ?? c.style?.bg;
    if (!validColor(fg) || !validColor(bg)) return { error: "Colours must be hex values like #112233" };
    c.style = { fg, bg };
  }
  if (body.logoData !== undefined) {
    if (!validLogo(body.logoData)) return { error: "Logo must be a PNG under 120 KB" };
    c.logoData = body.logoData || "";
  }
  if (body.rules !== undefined) {
    const r = sanitizeRules(body.rules);
    if (r.error) return r;
    c.rules = r.rules;
  }
  if (!c.hasQr && !c.hasLink) return { error: "Keep a QR code, a short link, or both" };
  c.updated = new Date().toISOString();
  return { code: c };
}

export function buildCode(body, settings) {
  if (!validUrl(body.url)) return { error: "Destination must be a valid http(s) URL" };
  let hasQr = true;
  let hasLink = false;
  if (body.type === "link") { hasQr = false; hasLink = true; }
  if (body.hasQr != null) hasQr = !!body.hasQr;
  if (body.hasLink != null || body.alsoLink != null) hasLink = !!(body.hasLink || body.alsoLink);
  if (!hasQr && !hasLink) return { error: "Choose a QR code, a short link, or both" };
  const fg = body.style?.fg || settings?.defaultFg || DEFAULT_SETTINGS.defaultFg;
  const bg = body.style?.bg || settings?.defaultBg || DEFAULT_SETTINGS.defaultBg;
  if (!validColor(fg) || !validColor(bg)) return { error: "Colours must be hex values like #112233" };
  const rules = body.rules ? sanitizeRules(body.rules) : { rules: [] };
  if (rules.error) return rules;
  return {
    code: {
      url: body.url,
      name: String(body.name || "").slice(0, 120),
      notes: String(body.notes || "").slice(0, 2000),
      tags: cleanTags(body.tags),
      paused: false,
      created: new Date().toISOString(),
      hasQr,
      hasLink,
      qrMarker: true,
      destinationType: "url",
      style: { fg, bg },
      logoData: "",
      rules: rules.rules,
    },
  };
}

export async function readSettings() {
  const stored = await settingsStore().get("workspace", { type: "json" }).catch(() => null);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored || {}),
    publicUrl: publicBase(),
    workspaceName: String(stored?.workspaceName || DEFAULT_SETTINGS.workspaceName).slice(0, 40) || "Liberty",
    defaultFg: validColor(stored?.defaultFg) ? stored.defaultFg : DEFAULT_SETTINGS.defaultFg,
    defaultBg: validColor(stored?.defaultBg) ? stored.defaultBg : DEFAULT_SETTINGS.defaultBg,
  };
}

/**
 * In-memory blob stand-in for the local dev server and tests.
 * `onlyIfNew` and `onlyIfMatch` are synchronous compare-and-set, matching
 * Netlify Blobs `If-None-Match: *` and `If-Match` writes.
 */
export function memoryBackend() {
  const buckets = new Map();
  let seq = 0;
  return (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const m = buckets.get(name);
    const read = (key) => {
      if (!m.has(key)) return null;
      const row = m.get(key);
      if (row && row.__memblob) return row;
      return { __memblob: true, etag: "legacy", data: row };
    };
    const write = (key, data, opts = {}) => {
      const current = read(key);
      if (opts.onlyIfNew && current) return { modified: false };
      if (opts.onlyIfMatch != null && opts.onlyIfMatch !== "") {
        if (!current || current.etag !== opts.onlyIfMatch) return { modified: false };
      }
      const etag = "m" + (++seq).toString(16);
      m.set(key, { __memblob: true, etag, data: JSON.parse(JSON.stringify(data)) });
      return { etag, modified: true };
    };
    return {
      async get(key, opts) {
        const row = read(key);
        if (!row) return null;
        if (opts?.type === "json") return JSON.parse(JSON.stringify(row.data));
        return row.data;
      },
      async getWithMetadata(key, opts) {
        const row = read(key);
        if (!row) return null;
        const data = opts?.type === "json" ? JSON.parse(JSON.stringify(row.data)) : row.data;
        return { data, etag: row.etag, metadata: {} };
      },
      async setJSON(key, val, opts) { return write(key, val, opts || {}); },
      async delete(key) { m.delete(key); },
      async list(opts) {
        const prefix = opts?.prefix || "";
        return { blobs: [...m.keys()].filter((key) => String(key).startsWith(prefix)).map((key) => ({ key, etag: read(key)?.etag })) };
      },
    };
  };
}
