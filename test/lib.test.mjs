import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const auth = (await import("../netlify/functions/auth.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const redirectFn = (await import("../netlify/functions/redirect.mjs")).default;
const settingsFn = (await import("../netlify/functions/settings.mjs")).default;

const {
  parseUA, resolveDestination, channelFor, recordHit, migrateStats, collect, allocateCounts,
  dayKey, lastNDays, previousKeys, visitorHash, buildCode, applyPatch, normalizeCode, stats,
} = lib;

function req(method, url, { cookie, body, ua } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (ua) headers.set("user-agent", ua);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function json(res) { return { status: res.status, body: await res.json(), res }; }
function cookieOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return (list[0] || "").split(";")[0];
}

test("parseUA distinguishes browser, OS, and device", () => {
  const iphone = parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  assert.deepEqual({ os: iphone.os, device: iphone.device, browser: iphone.browser }, { os: "iOS", device: "Mobile", browser: "Safari" });
  const android = parseUA("Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
  assert.equal(android.os, "Android");
  assert.equal(android.device, "Mobile");
  assert.equal(android.browser, "Chrome");
  const edge = parseUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0");
  assert.equal(edge.browser, "Edge");
  assert.equal(edge.os, "Windows");
  assert.equal(parseUA("curl/8.0").device, "Bot/Other");
});

test("routing matches device and location, first rule wins", () => {
  const code = {
    url: "https://example.com/default",
    rules: [
      { type: "device", value: "ios", url: "https://example.com/ios" },
      { type: "location", value: "AU", url: "https://example.com/au" },
    ],
  };
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1";
  assert.equal(resolveDestination(code, { ua: iphone, geo: { countryCode: "AU", countryName: "Australia", cityName: "Sydney" } }), "https://example.com/ios");
  assert.equal(resolveDestination(code, { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0", geo: { countryCode: "AU", countryName: "Australia", cityName: "Sydney" } }), "https://example.com/au");
  assert.equal(resolveDestination(code, { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0", geo: { countryCode: "US", countryName: "United States", cityName: "Austin" } }), "https://example.com/default");
  assert.equal(resolveDestination({ url: "https://example.com/default", rules: [{ type: "location", value: "Sydney", url: "https://example.com/syd" }] }, { ua: "", geo: { cityName: "Sydney", city: "Sydney, NSW" } }), "https://example.com/syd");
});

test("channel splits scans and clicks only when a short link exists", () => {
  const both = { hasQr: true, hasLink: true, qrMarker: true };
  const legacy = { url: "https://example.com", created: "2020-01-01" };
  const linkOnly = { hasQr: false, hasLink: true, qrMarker: true };
  assert.equal(channelFor(both, true), "scan");
  assert.equal(channelFor(both, false), "click");
  assert.equal(channelFor(legacy, false), "scan");
  assert.equal(channelFor(linkOnly, false), "click");
});

test("recordHit counts unique visitors without storing the IP", () => {
  const ip = "203.0.113.44";
  const day = "2026-11-05";
  let s = null;
  s = recordHit(s, { day, at: "2026-11-05T00:00:00.000Z", channel: "scan", browser: "Safari", os: "iOS", device: "Mobile", country: "AU", city: "Sydney, NSW", referrer: "Direct / QR scan", visitor: visitorHash(ip, "ua-a") });
  s = recordHit(s, { day, at: "2026-11-05T01:00:00.000Z", channel: "scan", browser: "Safari", os: "iOS", device: "Mobile", country: "AU", city: "Sydney, NSW", referrer: "Direct / QR scan", visitor: visitorHash(ip, "ua-a") });
  s = recordHit(s, { day, at: "2026-11-05T02:00:00.000Z", channel: "click", browser: "Chrome", os: "Windows", device: "Desktop", country: "US", city: "Austin, TX", referrer: "example.com", visitor: visitorHash(ip, "ua-b") });
  const dumped = JSON.stringify(s);
  assert.equal(dumped.includes(ip), false);
  const scans = collect(s, [day], "scan");
  const clicks = collect(s, [day], "click");
  assert.equal(scans.total, 2);
  assert.equal(scans.unique, 1);
  assert.equal(scans.browser.Safari, 2);
  assert.equal(scans.country.AU, 2);
  assert.equal(clicks.total, 1);
  assert.equal(clicks.browser.Chrome, 1);
  assert.equal(clicks.os.Windows, 1);
});

test("legacy aggregate stats migrate into daily scan buckets", () => {
  const migrated = migrateStats({
    total: 4,
    daily: { "2026-11-01": 1, "2026-11-02": 3 },
    country: { Australia: 4 },
    device: { Mobile: 4 },
    os: { iOS: 4 },
    referrer: { "Direct / QR scan": 4 },
    last: "2026-11-02T00:00:00.000Z",
  });
  const stored = JSON.stringify(migrated);
  const all = collect(migrated, ["2026-11-01", "2026-11-02"], "scan");
  assert.equal(all.total, 4);
  assert.equal(all.country.AU, 4);
  assert.equal(all.country.Australia, undefined);
  assert.equal(collect(migrated, ["2026-11-01"], "scan").country.AU, 1);
  assert.equal(collect(migrated, ["2026-11-02"], "scan").total, 3);
  assert.equal(JSON.stringify(migrated), stored);
  const weights = [1, 3];
  const parts = allocateCounts({ Australia: 4 }, weights);
  assert.equal(parts[0].Australia + parts[1].Australia, 4);
});

test("country codes and names group into one row without rewriting stored keys", () => {
  const day = "2026-11-05";
  let written = null;
  for (const country of ["AU", "au ", "Australia", " australia "]) {
    written = recordHit(written, { day, at: "2026-11-05T00:00:00.000Z", channel: "scan", browser: "Safari", os: "iOS", device: "Mobile", country, city: "Sydney", referrer: "Direct / QR scan" });
  }
  assert.equal(written.days[day].scan.country.AU, 4);
  assert.equal(written.days[day].scan.country.Australia, undefined);
  assert.equal(Object.keys(written.days[day].scan.country).length, 1);
  const stored = {
    v: 2,
    days: {
      [day]: {
        scan: { n: 7, u: [], browser: {}, os: {}, device: {}, country: { Australia: 6, AU: 1, "au ": 1 }, city: {}, referrer: {} },
        click: { n: 0, u: [], browser: {}, os: {}, device: {}, country: {}, city: {}, referrer: {} },
      },
    },
    last: null,
  };
  const before = JSON.stringify(stored);
  const next = recordHit(stored, { day, at: "2026-11-05T03:00:00.000Z", channel: "scan", country: "AUS", city: "Melbourne", referrer: "Direct / QR scan" });
  assert.equal(stored.days[day].scan.country.Australia, 6);
  assert.equal(stored.days[day].scan.country["au "], 1);
  assert.equal(JSON.stringify(stored), before);
  assert.equal(next.days[day].scan.country.Australia, 6);
  assert.equal(next.days[day].scan.country["au "], 1);
  assert.equal(next.days[day].scan.country.AU, 2);
  const grouped = collect(next, [day], "scan");
  assert.equal(grouped.country.AU, 9);
  assert.equal(grouped.country.Australia, undefined);
  assert.equal(lib.groupedCountryStats(next).days[day].scan.country.AU, 9);
  assert.equal(lib.statsForList(next).days[day].scan.country.AU, 9);
  assert.equal(next.days[day].scan.country.Australia, 6);
});

test("sydney calendar buckets late UTC evenings onto the next local day", () => {
  assert.equal(dayKey(new Date("2026-11-05T12:00:00Z")), "2026-11-05");
  assert.equal(dayKey(new Date("2026-11-05T14:00:00Z")), "2026-11-06");
  const keys = lastNDays(7, new Date("2026-11-05T01:00:00Z"));
  assert.equal(keys.length, 7);
  assert.equal(keys.at(-1), "2026-11-05");
  assert.equal(previousKeys(keys).at(-1), addDayBefore(keys[0]));
});

function addDayBefore(ymd) {
  return previousKeys([ymd])[0];
}

test("rejects bad destinations, colours, and unsafe rules", () => {
  assert.equal(buildCode({ url: "javascript:alert(1)", type: "qr" }).error.includes("http"), true);
  assert.equal(applyPatch(normalizeCode({ slug: "ab", url: "https://example.com", hasQr: true, hasLink: false, qrMarker: true, created: "2026-01-01" }), { rules: [{ type: "device", value: "mobile", url: "javascript:alert(1)" }] }).error.includes("http"), true);
  assert.equal(applyPatch(normalizeCode({ slug: "ab", url: "https://example.com", hasQr: true, hasLink: false, qrMarker: true, created: "2026-01-01" }), { logoData: "<svg onload=1>" }).error.includes("PNG"), true);
});

test("admin flow: auth, create, scan metrics, routing, pause, delete", async () => {
  const bad = await json(await auth(req("POST", "/api/auth", { body: { password: "nope" } })));
  assert.equal(bad.status, 401);
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  assert.equal(login.status, 200);
  const cookie = cookieOf(login);
  assert.match(cookie, /^qr_admin=/);

  const anon = await json(await codesFn(req("GET", "/api/codes"), { params: {} }));
  assert.equal(anon.status, 401);

  const created = await json(await codesFn(req("POST", "/api/codes", { cookie, body: { url: "https://example.com/welcome", name: "Welcome", type: "qr", alsoLink: true, tags: ["Launch", "launch"] } }), { params: {} }));
  assert.equal(created.status, 201);
  const slug = created.body.slug;
  assert.equal(created.body.hasQr, true);
  assert.equal(created.body.hasLink, true);
  assert.equal(created.body.qrMarker, true);
  assert.deepEqual(created.body.tags, ["Launch"]);
  assert.equal(created.body.logoData, "");

  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
  const geo = { city: "Sydney", country: { code: "AU", name: "Australia" }, subdivision: { code: "NSW" } };
  const ip = "203.0.113.10";
  for (const [ua, qr] of [[iphone, true], [iphone, true], [android, true], [desktop, false]]) {
    const hit = await redirectFn(req("GET", "/r/" + slug + (qr ? "?qr=1" : ""), { ua }), { params: { slug }, geo, ip });
    assert.equal(hit.status, 302);
    assert.equal(hit.headers.get("location"), "https://example.com/welcome");
  }

  const detail = await json(await codesFn(req("GET", "/api/codes/" + slug, { cookie }), { params: { slug } }));
  assert.equal(detail.status, 200);
  const day = dayKey();
  const scans = collect(detail.body.stats, [day], "scan");
  const clicks = collect(detail.body.stats, [day], "click");
  assert.equal(scans.total, 3);
  assert.equal(scans.unique, 2);
  assert.equal(scans.browser.Safari, 2);
  assert.equal(scans.browser.Chrome, 1);
  assert.equal(scans.country.AU, 3);
  assert.equal(scans.city["Sydney, NSW"], 3);
  assert.equal(clicks.total, 1);
  assert.equal(clicks.os.Windows, 1);
  const raw = JSON.stringify(await stats().get(slug, { type: "json" }));
  assert.equal(raw.includes(ip), false);

  const list = await json(await codesFn(req("GET", "/api/codes", { cookie }), { params: {} }));
  assert.equal(JSON.stringify(list.body).includes(detail.body.stats.days[day].scan.u[0]), false);
  assert.equal(list.body[0].scans, 3);
  assert.equal(list.body[0].clicks, 1);

  const routed = await json(await codesFn(req("PATCH", "/api/codes/" + slug, { cookie, body: { rules: [{ type: "device", value: "ios", url: "https://example.com/ios" }] } }), { params: { slug } }));
  assert.equal(routed.status, 200);
  const iosHit = await redirectFn(req("GET", "/r/" + slug + "?qr=1", { ua: iphone }), { params: { slug }, geo, ip });
  assert.equal(iosHit.headers.get("location"), "https://example.com/ios");
  const other = await redirectFn(req("GET", "/r/" + slug + "?qr=1", { ua: desktop }), { params: { slug }, geo, ip });
  assert.equal(other.headers.get("location"), "https://example.com/welcome");

  await codesFn(req("PATCH", "/api/codes/" + slug, { cookie, body: { paused: true } }), { params: { slug } });
  const paused = await redirectFn(req("GET", "/r/" + slug, { ua: desktop }), { params: { slug }, geo, ip });
  assert.equal(paused.status, 404);

  const removed = await json(await codesFn(req("DELETE", "/api/codes/" + slug, { cookie }), { params: { slug } }));
  assert.equal(removed.status, 200);

  const saved = await json(await settingsFn(req("PATCH", "/api/settings", { cookie, body: { workspaceName: "Liberty", defaultFg: "#112233", defaultBg: "#fff" } })));
  assert.equal(saved.status, 400);
  const ok = await json(await settingsFn(req("PATCH", "/api/settings", { cookie, body: { workspaceName: "Liberty desk", defaultFg: "#112233", defaultBg: "#ffffff" } })));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.publicUrl, "https://expresshelp.site");
  assert.equal(ok.body.defaultFg, "#112233");
});
