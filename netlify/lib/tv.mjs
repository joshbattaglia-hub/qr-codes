/**
 * Truckies Lounge TV feed (public, read-only). Headlines from public trucking RSS feeds, Open-Meteo weather,
 * VicEmergency warnings (Victoria only) and the nearest Liberty sites. Nothing here writes real data:
 * the only writes are cache entries in the "tv-cache" store.
 */
import { getStore } from "@netlify/blobs";
import { settingsStore, sitesStore } from "./lib.mjs";

export const FALLBACK_LOCATION = { lat: -37.8136, lng: 144.9631, label: "Melbourne CBD" };
export const NEWS_FEEDS = [
  { source: "Big Rigs", url: "https://www.bigrigs.com.au/feed/" },
  { source: "Owner//Driver", url: "https://www.ownerdriver.com.au/feed" },
  { source: "Fully Loaded", url: "https://www.fullyloaded.com.au/feed" },
  { source: "Prime Mover", url: "https://www.primemovermag.com.au/feed/" },
];
export const VICEMERGENCY_URL = "https://emergency.vic.gov.au/public/osom-geojson.json";
export const NEWS_TTL_MS = 20 * 60 * 1000;
export const WEATHER_TTL_MS = 15 * 60 * 1000;
export const WARNINGS_TTL_MS = 10 * 60 * 1000;
export const SITES_TTL_MS = 30 * 60 * 1000;
export const WARNING_RADIUS_KM = 100;
export const SETTINGS_KEY = "tv-lounge";
// Standard "compatible" bot format that names this service. Some publishers reject agents without the Mozilla/5.0 prefix.
const USER_AGENT = "Mozilla/5.0 (compatible; ExpressHelpTV/1.0; +https://expresshelp.site/tv/truckies-lounge)";
const VIC_BOX = { minLat: -39.3, maxLat: -33.9, minLng: 140.9, maxLng: 150.1 };

let cacheFactory = null;
let fetchImpl = null;
let clock = () => Date.now();
export function setTvTestHooks({ cache = null, fetch = null, now = null } = {}) {
  cacheFactory = cache;
  fetchImpl = fetch;
  clock = typeof now === "function" ? now : () => Date.now();
}
function cacheStore() {
  return cacheFactory ? cacheFactory("tv-cache") : getStore({ name: "tv-cache", consistency: "strong" });
}
function doFetch(url, options) {
  return (fetchImpl || globalThis.fetch)(url, options);
}

/* ---------- helpers ---------- */

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validCoords(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === "" || lng === "" || lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  // Australia and nearby waters only.
  if (la < -45 || la > -9 || ln < 110 || ln > 155) return null;
  return { lat: Math.round(la * 10000) / 10000, lng: Math.round(ln * 10000) / 10000 };
}

/** Melbourne UTC offset in minutes at the given instant (handles daylight saving). */
export function melbourneOffsetMinutes(at = clock()) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((asUtc - Math.floor(at / 60000) * 60000) / 60000);
}

const STATE_WORDS = /\b(VIC|Victoria|QLD|Qld|Queensland|NSW|N\.S\.W\.?|WA|W\.A\.?|SA|S\.A\.?|NT|N\.T\.?|TAS|Tasmania)\b\.?/gi;
const STREET = /\b(Rd|Road|St|Street|Hwy|Highway|Ave|Av|Avenue|Dr|Drive|Pde|Parade|Promenade|Tce|Terrace|Way|Cres|Crescent|Bvd|Blvd|Boulevard|Ct|Court|Pl|Place|Lane|Ln|Cct|Circuit|Esp|Esplanade|Fwy|Freeway)\b\.?/gi;

function tidy(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().replace(/^[,\s]+|[,\s]+$/g, "");
  if (t && t === t.toUpperCase()) return t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  if (t && t === t.toLowerCase()) return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return t;
}

/** Best-effort suburb from the free-text imported address. Returns "" when it cannot tell. */
export function suburbFromAddress(address) {
  let text = String(address || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/\b\d{4}\s*$/, "").trim();
  let parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  parts = parts.map((p) => p.replace(STATE_WORDS, "").replace(/\b\d{4}\b/g, "").trim()).filter(Boolean);
  if (parts.length >= 2) {
    const after = parts.slice(1).find((p) => !/^\d/.test(p));
    if (after) return tidy(after);
  }
  const one = (parts[0] || "").replace(/\s+/g, " ");
  let last = -1;
  let match;
  STREET.lastIndex = 0;
  while ((match = STREET.exec(one))) last = match.index + match[0].length;
  if (last > 0 && last < one.length) return tidy(one.slice(last));
  return "";
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Headlines only (title, source, time). Article bodies and descriptions are ignored. */
export function parseRss(xml, source, limit = 10) {
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || ""))) && items.length < limit) {
    const block = m[0];
    const title = decodeEntities((block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).slice(0, 200);
    const date = decodeEntities((block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i) || block.match(/<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i) || [])[1]);
    const at = Date.parse(date);
    if (title) items.push({ title, source, publishedAt: Number.isFinite(at) ? new Date(at).toISOString() : "" });
  }
  return items;
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, application/json;q=0.9, */*;q=0.5" }, signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (text.length > 3_000_000) throw new Error("too large");
    return text;
  } finally { clearTimeout(timer); }
}

/** Cached section: fresh entry if young enough, otherwise refresh; on failure return the last good entry marked stale. */
async function cached(key, ttl, load) {
  const store = cacheStore();
  const hit = await store.get(key, { type: "json" }).catch(() => null);
  if (hit && clock() - Date.parse(hit.fetchedAt) < ttl) return { ...hit, stale: false };
  try {
    const data = await load();
    const entry = { fetchedAt: new Date(clock()).toISOString(), data };
    await store.setJSON(key, entry).catch(() => null);
    return { ...entry, stale: false };
  } catch (error) {
    if (hit) return { ...hit, stale: true };
    return { fetchedAt: "", data: null, stale: true, error: "unavailable" };
  }
}

/* ---------- sections ---------- */

export async function loadNews() {
  return cached("news/v1", NEWS_TTL_MS, async () => {
    const results = await Promise.all(NEWS_FEEDS.map(async (feed) => {
      try { return { source: feed.source, ok: true, items: parseRss(await fetchText(feed.url), feed.source, 10) }; }
      catch { return { source: feed.source, ok: false, items: [] }; }
    }));
    const seen = new Set();
    const items = results.flatMap((r) => r.items)
      .filter((item) => { const k = item.title.toLowerCase().replace(/[^a-z0-9]/g, ""); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
      .slice(0, 24);
    if (!items.length) throw new Error("no headlines");
    return { items, feeds: results.map((r) => ({ source: r.source, ok: r.ok, count: r.items.length })) };
  });
}

export async function loadWeather(loc) {
  const lat = loc.lat.toFixed(2);
  const lng = loc.lng.toFixed(2);
  return cached("weather/" + lat + "," + lng, WEATHER_TTL_MS, async () => {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lng
      + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,is_day"
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max"
      + "&timezone=auto&forecast_days=4&wind_speed_unit=kmh";
    const data = JSON.parse(await fetchText(url));
    if (!data?.current || !data?.daily) throw new Error("bad weather");
    const c = data.current;
    return {
      current: { temp: c.temperature_2m, feelsLike: c.apparent_temperature, humidity: c.relative_humidity_2m, code: c.weather_code, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, gusts: c.wind_gusts_10m, rain: c.precipitation, isDay: c.is_day, time: c.time },
      daily: (data.daily.time || []).map((date, i) => ({ date, code: data.daily.weather_code[i], max: data.daily.temperature_2m_max[i], min: data.daily.temperature_2m_min[i], rainChance: data.daily.precipitation_probability_max?.[i] ?? null, wind: data.daily.wind_speed_10m_max?.[i] ?? null })),
      timezone: data.timezone || "",
    };
  });
}

export function insideVictoria(loc) {
  return loc.lat >= VIC_BOX.minLat && loc.lat <= VIC_BOX.maxLat && loc.lng >= VIC_BOX.minLng && loc.lng <= VIC_BOX.maxLng;
}

function featurePoint(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  const first = (coords) => (Array.isArray(coords) && typeof coords[0] === "number" ? coords : Array.isArray(coords) ? first(coords[0]) : null);
  if (g.type === "GeometryCollection") return featurePoint({ geometry: (g.geometries || []).find((x) => x.type === "Point") || g.geometries?.[0] });
  const p = first(g.coordinates);
  return p ? { lng: p[0], lat: p[1] } : null;
}

/** VicEmergency public feed: current warnings (not incidents) within the radius. Victoria only. */
export async function loadWarnings(loc) {
  if (!insideVictoria(loc)) return { status: "not-covered", items: [], note: "Automatic warnings cover Victoria only (VicEmergency). For other states check bom.gov.au." };
  const feed = await cached("warnings/vic/v1", WARNINGS_TTL_MS, async () => {
    const data = JSON.parse(await fetchText(VICEMERGENCY_URL));
    if (!Array.isArray(data?.features)) throw new Error("bad feed");
    return data.features
      .filter((f) => f?.properties?.feedType === "warning")
      .map((f) => ({ point: featurePoint(f), title: String(f.properties.sourceTitle || f.properties.name || f.properties.category2 || "Warning").slice(0, 160), level: String(f.properties.action || f.properties.category1 || f.properties.status || "").slice(0, 60), location: String(f.properties.location || "").slice(0, 120), updated: String(f.properties.updated || f.properties.created || "") }))
      .filter((w) => w.point);
  });
  if (!feed.data) return { status: "unavailable", items: [], note: "Warnings are unavailable right now." };
  const items = feed.data
    .map((w) => ({ ...w, km: Math.round(haversineKm(loc, w.point)) }))
    .filter((w) => w.km <= WARNING_RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 5)
    .map(({ point, ...rest }) => rest);
  return { status: feed.stale ? "stale" : "ok", items, fetchedAt: feed.fetchedAt, note: items.length ? "" : "No current VicEmergency warnings within " + WARNING_RADIUS_KM + " km." };
}

/** Public site list: name, LOC code, suburb, coordinates when the record has them. No contacts or internal fields. */
export async function loadSites() {
  return cached("sites/v1", SITES_TTL_MS, async () => {
    const { blobs } = await sitesStore().list();
    const rows = await Promise.all(blobs.filter((b) => /^s[a-f0-9]{8}$/.test(b.key)).map((b) => sitesStore().get(b.key, { type: "json" }).catch(() => null)));
    return rows.filter((r) => r && r.name && !r.hold).map((r) => {
      const coords = validCoords(r.lat ?? r.latitude, r.lng ?? r.lon ?? r.longitude);
      const out = { id: r.id, loc: String(r.loc || ""), name: String(r.name), suburb: suburbFromAddress(r.address) };
      if (coords) { out.lat = coords.lat; out.lng = coords.lng; }
      if (typeof r.diesel === "boolean") out.diesel = r.diesel;
      if (typeof r.truckAccess === "boolean") out.truckAccess = r.truckAccess;
      return out;
    });
  });
}

export function nearestSites(sites, loc, count = 5) {
  return sites.filter((s) => s.lat != null).map((s) => ({ ...s, km: Math.round(haversineKm(loc, s) * 10) / 10 })).sort((a, b) => a.km - b.km).slice(0, count);
}

/* ---------- location ---------- */

export function cleanTvSettings(raw) {
  const site = String(raw?.site || "").trim().slice(0, 40);
  const coords = validCoords(raw?.lat, raw?.lng);
  return { site, lat: coords ? coords.lat : null, lng: coords ? coords.lng : null, label: String(raw?.label || "").trim().slice(0, 60) };
}

export async function readTvSettings() {
  return cleanTvSettings(await settingsStore().get(SETTINGS_KEY, { type: "json" }).catch(() => null));
}

export async function saveTvSettings(body) {
  const next = cleanTvSettings(body);
  if ((body?.lat !== "" && body?.lat != null) || (body?.lng !== "" && body?.lng != null)) {
    if (next.lat == null) return { status: 400, error: "Latitude and longitude must both be set to a point in Australia (for example -37.8136 and 144.9631)." };
  }
  if (next.site) {
    const sites = (await loadSites()).data || [];
    if (!sites.some((s) => s.loc.toLowerCase() === next.site.toLowerCase() || s.id === next.site)) return { status: 400, error: "Unknown site code." };
  }
  await settingsStore().setJSON(SETTINGS_KEY, { ...next, updatedAt: new Date(clock()).toISOString() });
  return { status: 200, body: next };
}

function findSite(sites, code) {
  const c = String(code || "").trim().toLowerCase();
  return c ? sites.find((s) => s.loc.toLowerCase() === c || s.id === c) || null : null;
}

/** URL lat/lng, then URL site, then the admin default, then Melbourne CBD. */
export function resolveLocation({ params, settings, sites }) {
  const notes = [];
  const urlCoords = validCoords(params.get("lat"), params.get("lng"));
  if (urlCoords) return { ...urlCoords, label: String(params.get("label") || "").slice(0, 60) || "Custom location", source: "url-coords", notes };
  if ((params.get("lat") || params.get("lng")) && !urlCoords) notes.push("The lat/lng in the address were not valid.");
  const tryCode = (code, source) => {
    if (!code) return null;
    const site = findSite(sites, code);
    if (!site) { notes.push("Site " + code + " was not found."); return null; }
    if (site.lat == null) { notes.push(site.name + " has no map coordinates yet."); return null; }
    return { lat: site.lat, lng: site.lng, label: site.name, siteId: site.id, source, notes };
  };
  const fromUrl = tryCode(params.get("site"), "url-site");
  if (fromUrl) return fromUrl;
  const fromSetting = tryCode(settings.site, "setting-site");
  if (fromSetting) return fromSetting;
  if (settings.lat != null) return { lat: settings.lat, lng: settings.lng, label: settings.label || "Lounge", source: "setting-coords", notes };
  notes.push("Location not set. Showing " + FALLBACK_LOCATION.label + ".");
  return { ...FALLBACK_LOCATION, source: "fallback", notes };
}

export async function tvFeed(params) {
  const [sitesEntry, settings] = await Promise.all([loadSites(), readTvSettings().catch(() => cleanTvSettings(null))]);
  const sites = sitesEntry.data || [];
  const location = resolveLocation({ params, settings, sites });
  const [news, weather, warnings] = await Promise.all([loadNews(), loadWeather(location), loadWarnings(location).catch(() => ({ status: "unavailable", items: [], note: "Warnings are unavailable right now." }))]);
  const withCoords = sites.filter((s) => s.lat != null).length;
  return {
    generatedAt: new Date(clock()).toISOString(),
    melbourneOffsetMinutes: melbourneOffsetMinutes(),
    location: { label: location.label, lat: location.lat, lng: location.lng, source: location.source, notes: location.notes },
    news: { status: news.data ? (news.stale ? "stale" : "ok") : "unavailable", fetchedAt: news.fetchedAt, items: news.data?.items || [], feeds: news.data?.feeds || [] },
    weather: { status: weather.data ? (weather.stale ? "stale" : "ok") : "unavailable", fetchedAt: weather.fetchedAt, ...(weather.data || {}) },
    warnings,
    sites: {
      status: withCoords ? "ok" : "no-coordinates",
      total: sites.length,
      withCoordinates: withCoords,
      items: nearestSites(sites, location, 5),
      note: withCoords ? "" : "Site distances need map coordinates (" + withCoords + " of " + sites.length + " sites have them).",
    },
    attribution: "Weather: Open-Meteo.com (CC BY 4.0). Warnings: VicEmergency. Headlines: " + NEWS_FEEDS.map((f) => f.source).join(", ") + ".",
  };
}
