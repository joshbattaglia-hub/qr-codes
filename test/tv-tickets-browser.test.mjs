import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Real-browser checks for the support tickets TV screens at 1920x1080. Synthetic data only, real handlers, in-memory store, mail blocked.
 *  Set TV_SHOTS=/some/dir to save screenshots of what is drawn. */
const SKIP = !["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].some((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
const SHOTS = process.env.TV_SHOTS || "";
const DAY = 86400000;
let ctx = null;
let browser = null;
async function boot() {
  if (ctx) return ctx;
  const H = await import("./support/browser-harness.mjs");
  const lib = await import("../netlify/lib/lib.mjs");
  const tv = await import("../netlify/lib/tv.mjs");
  const RSS = (title) => '<?xml version="1.0"?><rss><channel><title>Feed</title>' + [0, 1, 2, 3].map((i) => `<item><title><![CDATA[${title} headline number ${i}]]></title><pubDate>Thu, 12 Nov 2026 0${i}:00:00 +0000</pubDate></item>`).join("") + "</channel></rss>";
  const WEATHER = { timezone: "Australia/Melbourne", current: { temperature_2m: 21.4, apparent_temperature: 20, relative_humidity_2m: 50, weather_code: 2, wind_speed_10m: 14, wind_direction_10m: 200, wind_gusts_10m: 30, precipitation: 0, is_day: 1, time: "2026-11-13T14:00" }, daily: { time: ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"], weather_code: [2, 61, 3, 0], temperature_2m_max: [24, 19, 22, 27], temperature_2m_min: [12, 11, 10, 14], precipitation_probability_max: [10, 80, 20, 0], wind_speed_10m_max: [20, 30, 15, 10] } };
  tv.setTvTestHooks({ cache: lib.memoryBackend(), fetch: (url) => Promise.resolve(new Response(new URL(url).host.includes("open-meteo") ? JSON.stringify(WEATHER) : new URL(url).host.includes("emergency.vic") ? JSON.stringify({ type: "FeatureCollection", features: [] }) : RSS(new URL(url).host))) });
  const owner = await H.otpCookie(JOSHUA);
  const made = await (await H.call("POST", "/api/tickets/tv-link", { cookie: owner, body: {} })).json();
  ctx = { H, lib, owner, key: made.key };
  return ctx;
}
const iso = (ms) => new Date(Date.now() - ms).toISOString();
function row(n, over = {}) {
  return { id: "t" + String(n).padStart(16, "0"), number: n, queue: n % 2 ? "signage" : "screens", status: "new", subject: "Synthetic job " + n, siteId: "s00000001", siteLabel: "Synthetic Depot " + (n % 5), requestType: "Fault or repair", priority: "normal", neededBy: "",
    description: "PRIVATE-DESC", requesterEmail: "private.person@example.com", requesterName: "Sam Synthetic", requesterPhone: "0400 000 000", source: "portal", assignee: "private.staff@example.com", createdAt: iso(2 * DAY), updatedAt: iso(DAY),
    messages: [{ id: "m", kind: "internal", text: "PRIVATE-NOTE", at: iso(DAY) }], files: [], statusHistory: [], ...over };
}
async function reset(rows) {
  const { lib } = await boot();
  const store = lib.ticketStore();
  const { blobs } = await store.list({ prefix: "ticket/" });
  for (const b of blobs) await store.delete(b.key);
  for (const r of rows) await store.setJSON("ticket/" + r.id, r);
}
const busy = () => {
  const names = ["Alex", "Priya", "Tom", "Mei", "Jordan"];
  const subjects = ["Forecourt screen is blank since the storm", "Pylon sign bulb out on the highway side", "Menu board shows the wrong price for the large coffee", "Register 3 screen flickers", "Canopy sign letter missing", "Kiosk touch not responding", "Replace the faded price sign at pump 4", "Window poster frame is broken"];
  const out = [];
  let n = 5000;
  const add = (status, count, extra = () => ({})) => { for (let i = 0; i < count; i++, n++) out.push(row(n, { status, subject: subjects[n % subjects.length], requesterName: names[n % 5] + " Synthetic", priority: ["normal", "high", "urgent", "low"][n % 4], createdAt: iso((1 + (n % 9)) * DAY), neededBy: n % 3 === 0 ? "2020-01-02" : "", ...extra(i) })); };
  add("new", 5); add("awaiting", 4); add("in-progress", 5);
  add("done", 3, (i) => ({ statusHistory: [{ from: "in-progress", to: "done", at: iso((i + 1) * 3 * 3600000) }] }));
  return out;
};

async function openTv(path, { tickets, speed = 1, w = 1920, h = 1080 } = {}) {
  const { H } = await boot();
  const { default: puppeteer } = await import("puppeteer-core").catch(() => ({ default: null }));
  if (!browser) browser = await H.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  if (speed !== 1) await page.evaluateOnNewDocument((s) => { const st = window.setTimeout, si = window.setInterval; window.setTimeout = function (f, d) { return st(f, (d || 0) / s); }; window.setInterval = function (f, d) { return si(f, (d || 0) / s); }; }, speed);
  await page.setRequestInterception(true);
  const log = [];
  page.log = log;
  page.on("request", async (r) => {
    const u = new URL(r.url());
    if (u.origin !== "https://expresshelp.site") return r.abort();
    if (u.pathname.startsWith("/api/")) {
      log.push(u.pathname + u.search);
      if (u.pathname === "/api/tv/tickets" && tickets && tickets.mode) {
        if (tickets.mode === "status") return r.respond({ status: tickets.status, contentType: "application/json", body: "{}" });
        if (tickets.mode === "body") return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(tickets.body) });
      }
      const res = await H.call(r.method(), u.pathname + u.search, {});
      const buf = Buffer.from(await res.arrayBuffer());
      const hh = {}; res.headers.forEach((v, k) => { if (k !== "set-cookie") hh[k] = v; });
      return r.respond({ status: res.status, headers: hh, body: buf });
    }
    let p = u.pathname;
    if (p === "/tv/support-tickets" || p === "/tv/support-tickets/") p = "/tv/support-tickets.html";
    if (p === "/tv/truckies-lounge" || p === "/tv/truckies-lounge/") p = "/tv/truckies-lounge.html";
    const file = "public" + p;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return r.respond({ status: 404, body: "" });
    const type = file.endsWith(".css") ? "text/css" : /\.js$/.test(file) ? "text/javascript" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".html") ? "text/html" : "application/octet-stream";
    r.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
  });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto("https://expresshelp.site" + path);
  return page;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: SHOTS + "/" + name + ".png" }); } }
after(async () => { if (browser) await browser.close(); });
const tvUrl = async (base, extra = "") => base + "?key=" + (await boot()).key + extra;

test("tickets-only page: four status columns in the Support board colours, fits 1920x1080 with no scrolling, footer, no private data", { skip: SKIP }, async () => {
  await reset(busy());
  const page = await openTv(await tvUrl("/tv/support-tickets"));
  await page.waitForSelector(".tt-col .tt-card", { timeout: 8000 });
  const info = await page.evaluate(() => {
    const cols = [].slice.call(document.querySelectorAll(".tt-col")).map((c) => ({
      cls: c.className, bg: getComputedStyle(c.querySelector(".tt-head")).backgroundColor, cardBg: getComputedStyle(c.querySelector(".tt-card") || c.querySelector(".tt-head")).backgroundColor,
      head: c.querySelector(".tt-head").textContent, cards: c.querySelectorAll(".tt-card").length, bolt: getComputedStyle(c.querySelector(".tt-head")).backgroundImage.indexOf("svg") >= 0,
      top: c.getBoundingClientRect().top, right: c.getBoundingClientRect().right, metaCut: [].slice.call(c.querySelectorAll(".tt-meta")).some((m) => m.scrollWidth > m.clientWidth + 1),
      clipped: [].slice.call(c.querySelectorAll(".tt-card")).some((k) => k.scrollHeight > k.clientHeight + 1 || k.getBoundingClientRect().bottom > c.getBoundingClientRect().bottom),
    }));
    const foot = document.querySelector("footer.eh-footer");
    return { cols, text: document.body.innerText, scrollH: document.documentElement.scrollHeight, scrollW: document.documentElement.scrollWidth, bodyScroll: document.body.scrollHeight,
      footer: foot ? { text: foot.textContent, href: foot.querySelector("a").getAttribute("href"), bottom: foot.getBoundingClientRect().bottom } : null, status: document.querySelector(".tt-status").textContent, cursor: getComputedStyle(document.body).cursor };
  });
  assert.deepEqual(info.cols.map((c) => c.bg), ["rgb(253, 228, 228)", "rgb(255, 244, 194)", "rgb(255, 229, 204)", "rgb(220, 244, 227)"]);
  assert.deepEqual(info.cols.map((c) => c.cardBg), ["rgb(253, 228, 228)", "rgb(255, 244, 194)", "rgb(255, 229, 204)", "rgb(220, 244, 227)"]);
  assert.deepEqual(info.cols.map((c) => c.bolt), [false, false, true, false], "bolt pattern on In progress only");
  assert.deepEqual(info.cols.map((c) => c.cards), [5, 4, 5, 3]);
  assert.ok(info.cols.every((c) => !c.clipped), "no card is clipped");
  assert.equal(new Set(info.cols.map((c) => c.top)).size, 1, "all four columns sit on one row");
  assert.ok(info.cols[3].right <= 1920, "the Done column is on screen");
  assert.ok(info.cols.every((c) => !c.metaCut), "detail lines are not cut off");
  assert.ok(info.scrollH <= 1080 && info.scrollW <= 1920 && info.bodyScroll <= 1080, "nothing to scroll");
  assert.match(info.footer.text, /^Cowabunga - please hesitate to reach out email me here$/);
  assert.equal(info.footer.href, "mailto:jbattaglia@libertyretail.com.au");
  assert.ok(info.footer.bottom <= 1080);
  assert.match(info.status, /^Updated \d{1,2}:\d{2} (am|pm)$/);
  assert.match(info.text, /OVERDUE/);
  assert.match(info.text, /days open/);
  assert.match(info.text, /Done \(last 24h\)/);
  assert.ok(/Alex|Priya|Tom|Mei|Jordan/.test(info.text) && !/Synthetic\b.*Alex Synthetic/.test(info.text), "first names only");
  assert.ok(!/PRIVATE|@|0400|private\./.test(info.text), "no private data drawn");
  assert.deepEqual(page.errors, []);
  await shot(page, "tv-tickets-only-busy");
  await page.close();
});

test("many tickets paginate instead of scrolling", { skip: SKIP }, async () => {
  const rows = []; for (let i = 0; i < 13; i++) rows.push(row(6000 + i, { status: "new", subject: "Overflow job " + i }));
  await reset(rows);
  const page = await openTv(await tvUrl("/tv/support-tickets"), { speed: 10 });
  await page.waitForSelector(".tt-card");
  assert.match(await page.$eval(".tt-pager", (e) => e.textContent), /^Page 1 of 3$/);
  const first = await page.$$eval(".tt-num", (e) => e.map((n) => n.textContent));
  assert.equal(first.length, 5);
  await wait(1700);
  const later = await page.$$eval(".tt-num", (e) => e.map((n) => n.textContent));
  assert.notDeepEqual(later, first, "the next page is shown");
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= 1080));
  await page.close();
});

test("empty state is a friendly all-clear", { skip: SKIP }, async () => {
  await reset([]);
  const page = await openTv(await tvUrl("/tv/support-tickets"));
  await page.waitForSelector(".tt-allclear .tt-big", { timeout: 8000 });
  assert.match(await page.$eval(".tt-allclear", (e) => e.textContent), /All clear.*No open support tickets/);
  assert.equal(await page.$(".tt-col"), null);
  await shot(page, "tv-tickets-only-empty");
  await page.close();
});

test("a failed fetch keeps the last good data with an Offline note, also after a restart; a switched-off link clears it", { skip: SKIP }, async () => {
  await reset(busy());
  const tickets = { mode: "" };
  const page = await openTv(await tvUrl("/tv/support-tickets"), { tickets, speed: 10 });
  await page.waitForSelector(".tt-card");
  const before = await page.$$eval(".tt-num", (e) => e.length);
  tickets.mode = "status"; tickets.status = 503;
  await page.waitForFunction(() => /Offline: showing the last update from \d/.test(document.querySelector(".tt-status").textContent), { timeout: 15000 });
  assert.equal(await page.$$eval(".tt-num", (e) => e.length) > 0, true);
  assert.ok(before > 0);
  await shot(page, "tv-tickets-only-offline");
  await page.reload();
  await page.waitForSelector(".tt-card", { timeout: 8000 });
  assert.match(await page.$eval(".tt-status", (e) => e.textContent), /Offline: showing the last update from/);
  tickets.mode = "status"; tickets.status = 401;
  await page.waitForFunction(() => /no longer valid/.test(document.querySelector(".tt-status").textContent), { timeout: 15000 });
  assert.equal(await page.$(".tt-card"), null, "revoked: nothing from the old data stays on screen");
  assert.equal(await page.evaluate(() => window.localStorage.getItem("tv-tickets-cache")), null);
  await page.close();
});

test("rotating TV: lounge screen, then tickets, then back; the key never goes to the lounge feed; bad key or no key never rotates", { skip: SKIP }, async () => {
  await reset(busy());
  const page = await openTv(await tvUrl("/tv/truckies-lounge", "&rotate=30"), { speed: 10 });
  await page.waitForSelector("#tickets-screen .tt-card", { timeout: 8000 });
  const shown = () => page.$eval("#tickets-screen", (e) => getComputedStyle(e).display);
  assert.equal(await shown(), "none", "starts on the lounge screen");
  await page.waitForFunction(() => document.getElementById("tickets-screen").style.display === "block", { timeout: 6000 });
  assert.equal(await page.evaluate(() => document.elementFromPoint(300, 400).closest("#tickets-screen") !== null), true, "tickets screen is on top");
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= 1080 && document.querySelector("footer.eh-footer").getBoundingClientRect().bottom <= 1080));
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("footer.eh-footer")).zIndex), "10");
  await shot(page, "tv-rotating-tickets-screen");
  await page.waitForFunction(() => document.getElementById("tickets-screen").style.display === "none", { timeout: 6000 });
  assert.ok(page.log.filter((l) => l.startsWith("/api/tv/truckies-lounge")).length >= 1);
  assert.ok(page.log.filter((l) => l.startsWith("/api/tv/truckies-lounge")).every((l) => !/key=/.test(l)), "TV key is not sent to the lounge feed");
  assert.deepEqual(page.errors, []);
  await page.close();

  const bad = await openTv("/tv/truckies-lounge?key=not-the-key&rotate=30", { speed: 10 });
  await wait(4500);
  assert.equal(await bad.$eval("#tickets-screen", (e) => getComputedStyle(e).display), "none", "a wrong key never shows tickets");
  await bad.close();

  const plain = await openTv("/tv/truckies-lounge", { speed: 10 });
  await plain.waitForSelector("#news li");
  assert.equal(await plain.$("#tickets-screen"), null, "the plain TV address has no ticket screen at all");
  assert.equal(await plain.evaluate(() => /trucking news/i.test(document.body.innerText)), true);
  await shot(plain, "tv-lounge-unchanged");
  await plain.close();

  const off = await openTv(await tvUrl("/tv/truckies-lounge", "&rotate=0"), { speed: 10 });
  await off.waitForSelector("#news li");
  assert.equal(await off.$("#tickets-screen"), null, "rotate=0 keeps the lounge screen only");
  await off.close();
});

test("admin: the ticket admin makes a TV link in Support settings; it shows both addresses once and they work", { skip: SKIP }, async () => {
  const { H, owner } = await boot();
  const browser2 = browser || (browser = await H.launch());
  const page = await H.openPage(browser2, owner, "tickets/settings", { w: 1366, h: 900 });
  await page.waitForSelector('[data-testid="ticket-tv-link"]', { timeout: 10000 });
  assert.match(await page.$eval('[data-testid="tv-link-state"]', (e) => e.textContent), /A TV link is on/);
  page.on("dialog", (d) => d.accept());
  await page.click('[data-act="ticket-tv-link-make"]');
  await page.waitForSelector('[data-testid="tv-link-rotating"]', { timeout: 8000 });
  const rotating = await page.$eval('[data-testid="tv-link-rotating"]', (e) => e.value);
  const only = await page.$eval('[data-testid="tv-link-only"]', (e) => e.value);
  assert.match(rotating, /^https:\/\/expresshelp\.site\/tv\/truckies-lounge\?key=[A-Za-z0-9_-]{40,}&rotate=30$/);
  assert.match(only, /^https:\/\/expresshelp\.site\/tv\/support-tickets\?key=[A-Za-z0-9_-]{40,}$/);
  const key = only.split("key=")[1];
  assert.equal((await H.call("GET", "/api/tv/tickets?key=" + key, {})).status, 200);
  assert.equal((await H.call("GET", "/api/tv/tickets?key=" + ctx.key, {})).status, 401, "the old key stopped working");
  ctx.key = key;
  await page.close();
});
