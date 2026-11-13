import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.ADMIN_PASSWORD = "synthetic-admin-password-1234";
const lib = await import("../netlify/lib/lib.mjs");
const backend = lib.memoryBackend();
lib.setStoreFactory(backend);
const tv = await import("../netlify/lib/tv.mjs");
const fn = (await import("../netlify/functions/tv.mjs")).default;
const root = new URL("../public/", import.meta.url).pathname;

const RSS = (title, n = 3) => '<?xml version="1.0"?><rss><channel><title>Feed</title>' + Array.from({ length: n }, (_, i) => `<item><title><![CDATA[${title} ${i} &amp; more]]></title><pubDate>Thu, 12 Nov 2026 0${i}:00:00 +0000</pubDate><description>Body text that must not appear</description><content:encoded>Full article</content:encoded></item>`).join("") + "</channel></rss>";
const WEATHER = { timezone: "Australia/Melbourne", current: { temperature_2m: 21.4, apparent_temperature: 20, relative_humidity_2m: 50, weather_code: 2, wind_speed_10m: 14, wind_direction_10m: 200, wind_gusts_10m: 30, precipitation: 0, is_day: 1, time: "2026-11-13T14:00" }, daily: { time: ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"], weather_code: [2, 61, 3, 0], temperature_2m_max: [24, 19, 22, 27], temperature_2m_min: [12, 11, 10, 14], precipitation_probability_max: [10, 80, 20, 0], wind_speed_10m_max: [20, 30, 15, 10] } };
const VIC = { type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "Point", coordinates: [145.0, -37.8] }, properties: { feedType: "warning", sourceTitle: "Severe Thunderstorm Warning", action: "Advice", location: "Synthetic Town" } },
  { type: "Feature", geometry: { type: "Point", coordinates: [147.5, -37.0] }, properties: { feedType: "warning", sourceTitle: "Far away", action: "Advice" } },
  { type: "Feature", geometry: { type: "Point", coordinates: [145.0, -37.81] }, properties: { feedType: "incident", sourceTitle: "Tree down" } },
] };

let calls = [];
let failing = new Set();
function fakeFetch(url) {
  calls.push(url);
  const host = new URL(url).host;
  if (failing.has(host) || failing.has("*")) return Promise.resolve(new Response("down", { status: 503 }));
  if (host.includes("open-meteo")) return Promise.resolve(new Response(JSON.stringify(WEATHER)));
  if (host.includes("emergency.vic")) return Promise.resolve(new Response(JSON.stringify(VIC)));
  return Promise.resolve(new Response(RSS(host)));
}
let now = Date.parse("2026-11-13T03:00:00Z");
tv.setTvTestHooks({ cache: backend, fetch: fakeFetch, now: () => now });

async function seedSites() {
  const sites = lib.sitesStore();
  await sites.setJSON("s00000001", { id: "s00000001", name: "Synthetic North", loc: "90001", address: "1 Test Rd, Coburg VIC 3058", lat: -37.74, lng: 144.96 });
  await sites.setJSON("s00000002", { id: "s00000002", name: "Synthetic South", loc: "90002", address: "2 Sample Highway Frankston Victoria 3199", lat: -38.14, lng: 145.12, diesel: true });
  await sites.setJSON("s00000003", { id: "s00000003", name: "No Coords", loc: "90003", address: "3 Nowhere St, Perth WA 6000" });
  await sites.setJSON("loc/abc", { pointer: true });
}
const get = (q = "") => fn(new Request("https://expresshelp.site/api/tv/truckies-lounge" + q));

test("helpers: haversine, suburb parsing, coordinates, Melbourne offset", () => {
  assert.equal(Math.round(tv.haversineKm({ lat: -37.8136, lng: 144.9631 }, { lat: -33.8688, lng: 151.2093 })), 713);
  assert.equal(tv.suburbFromAddress("4 Bayonet Head Rd Bayonet Head 6330"), "Bayonet Head");
  assert.equal(tv.suburbFromAddress("1 Millennium Circuit, Helensvale, QLD, 4212"), "Helensvale");
  assert.equal(tv.suburbFromAddress("1-19 NYAH ROAD,SWAN HILL"), "Swan Hill");
  assert.equal(tv.suburbFromAddress("8 Zimin Drive, NT 0850"), "");
  assert.equal(tv.validCoords("-37.8", "144.9").lat, -37.8);
  assert.equal(tv.validCoords("51.5", "-0.1"), null);
  assert.equal(tv.validCoords("", ""), null);
  assert.equal(tv.melbourneOffsetMinutes(Date.parse("2026-11-13T03:00:00Z")), 660);
  assert.equal(tv.melbourneOffsetMinutes(Date.parse("2026-07-01T03:00:00Z")), 600);
});

test("RSS parsing keeps headlines, source and time only", () => {
  const items = tv.parseRss(RSS("Big"), "Big Rigs");
  assert.equal(items.length, 3);
  assert.deepEqual(Object.keys(items[0]).sort(), ["publishedAt", "source", "title"]);
  assert.equal(items[0].title, "Big 0 & more");
  assert.equal(JSON.stringify(items).includes("Body text"), false);
  assert.equal(JSON.stringify(items).includes("Full article"), false);
});

test("public feed: default location, news, weather, warnings, sites", async () => {
  await seedSites();
  const res = await get();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  assert.match(res.headers.get("netlify-cdn-cache-control"), /s-maxage=300/);
  const body = await res.json();
  assert.equal(body.location.source, "fallback");
  assert.equal(body.location.label, "Melbourne CBD");
  assert.match(body.location.notes.join(" "), /Location not set/);
  assert.equal(body.melbourneOffsetMinutes, 660);
  assert.equal(body.news.status, "ok");
  assert.equal(body.news.feeds.length, 4);
  assert.ok(body.news.items.length >= 4);
  assert.equal(body.weather.current.temp, 21.4);
  assert.equal(body.weather.daily.length, 4);
  assert.equal(body.warnings.items.length, 1, "only warnings within 100 km, incidents excluded");
  assert.equal(body.warnings.items[0].title, "Severe Thunderstorm Warning");
  assert.equal(body.sites.total, 3);
  assert.equal(body.sites.withCoordinates, 2);
  assert.deepEqual(body.sites.items.map((s) => s.name), ["Synthetic North", "Synthetic South"]);
  assert.equal(body.sites.items[1].diesel, true);
  assert.equal(body.sites.items[0].suburb, "Coburg");
  assert.equal("address" in body.sites.items[0], false);
});

test("location precedence: URL lat/lng, URL site, admin setting; sites without coordinates fall back with a note", async () => {
  let body = await (await get("?lat=-38.14&lng=145.12&label=Test%20Lounge")).json();
  assert.equal(body.location.source, "url-coords");
  assert.equal(body.location.label, "Test Lounge");
  assert.equal(body.sites.items[0].name, "Synthetic South");
  assert.equal(body.sites.items[0].km, 0);
  body = await (await get("?site=90001")).json();
  assert.equal(body.location.source, "url-site");
  assert.equal(body.location.label, "Synthetic North");
  body = await (await get("?site=90003")).json();
  assert.equal(body.location.source, "fallback");
  assert.match(body.location.notes.join(" "), /No Coords has no map coordinates yet/);
  body = await (await get("?site=nope")).json();
  assert.match(body.location.notes.join(" "), /Site nope was not found/);
  const saved = await tv.saveTvSettings({ site: "", lat: "-31.95", lng: "115.86", label: "Perth Lounge" });
  assert.equal(saved.status, 200);
  body = await (await get()).json();
  assert.equal(body.location.source, "setting-coords");
  assert.equal(body.location.label, "Perth Lounge");
  assert.equal(body.warnings.status, "not-covered");
  assert.match(body.warnings.note, /Victoria only/);
  assert.equal((await tv.saveTvSettings({ lat: "200", lng: "1" })).status, 400);
  assert.equal((await tv.saveTvSettings({ site: "zzz" })).status, 400);
  assert.equal((await tv.saveTvSettings({ site: "90002" })).status, 200);
  body = await (await get()).json();
  assert.equal(body.location.source, "setting-site");
  await tv.saveTvSettings({});
});

test("caching: sections are reused within their TTL and stale data is served when sources fail", async () => {
  calls = [];
  await get("?lat=-37.9&lng=145.0");
  const first = calls.length;
  await get("?lat=-37.9&lng=145.0");
  assert.equal(calls.length, first, "no upstream calls inside the cache window");
  now += 60 * 60 * 1000;
  failing = new Set(["*"]);
  const res = await get("?lat=-37.9&lng=145.0");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.news.status, "stale");
  assert.ok(body.news.items.length > 0);
  assert.equal(body.weather.status, "stale");
  assert.equal(body.weather.current.temp, 21.4);
  failing = new Set();
});

test("TV settings endpoint is head-office only", async () => {
  assert.equal((await fn(new Request("https://expresshelp.site/api/tv/settings"))).status, 401);
  const cookie = lib.makeCookie(new Request("https://expresshelp.site/")).split(";")[0];
  const ok = await fn(new Request("https://expresshelp.site/api/tv/settings", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ lat: "-37.8", lng: "144.9", label: "HQ" }) }));
  assert.equal(ok.status, 200);
  const read = await (await fn(new Request("https://expresshelp.site/api/tv/settings", { headers: { cookie } }))).json();
  assert.equal(read.label, "HQ");
  assert.equal((await fn(new Request("https://expresshelp.site/api/tv/truckies-lounge", { method: "POST" }))).status, 405);
  await tv.saveTvSettings({});
});

test("TV page: public, noindex, ES5 script, footer, refresh and offline cache", () => {
  const html = fs.readFileSync(path.join(root, "tv/truckies-lounge.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "tv/truckies-lounge.js"), "utf8");
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<script src="\/footer.js" defer><\/script>/);
  assert.match(toml, /from = "\/tv\/truckies-lounge"\n  to = "\/tv\/truckies-lounge.html"/);
  assert.match(toml, /for = "\/tv\/\*"[\s\S]{0,120}X-Robots-Tag = "noindex, nofollow"/);
  assert.doesNotMatch(js, /=>|`|\blet\b|\bconst\b|\bfetch\(|\.\.\.|\\u\{/, "plain ES5 only");
  assert.match(js, /localStorage\.setItem/);
  assert.match(js, /Offline — showing the last update/);
  assert.match(js, /XMLHttpRequest/);
  const footer = fs.readFileSync(path.join(root, "footer.js"), "utf8");
  assert.doesNotMatch(footer, /=>|`|\blet\b|\bconst\b|\\u\{/, "shared footer stays ES5 for signage browsers");
});
