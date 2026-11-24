import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";

/** Real-browser checks of the visitor site picker and the admin log filters. Synthetic sites only, in-memory store, mail mocked, no network. */
const SKIP = !["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].some((p) => fs.existsSync(p));
let H, lib, owner, browser;
const SYN_AGENT_ABN = "10 000 110 866";
async function boot() {
  if (H) return;
  H = await import("./support/browser-harness.mjs");
  lib = await import("../netlify/lib/lib.mjs");
  owner = await H.otpCookie(H.JOSHUA);
  const sites = [
    { id: "s00000b01", name: "Synthetic Ballarat North", loc: "LOC0201", address: "1 Example Rd, Ballarat North VIC 3350", lat: -37.53, lng: 143.86 },
    { id: "s00000b02", name: "Synthetic Ballan Agent", loc: "LOC0202", address: "2 Sample St, Ballan VIC 3342", lat: -37.6, lng: 144.22, siteType: "commission_agent", tradingName: "Synthetic Ballan Fuels Pty Ltd", abn: SYN_AGENT_ABN, phone: "0412 345 678" },
    { id: "s00000b03", name: "Synthetic Geelong West", loc: "LOC0203", address: "3 Test Ave, Geelong West VIC 3218", lat: -38.14, lng: 144.34 },
  ];
  for (const s of sites) await lib.sitesStore().setJSON(s.id, s);
  await H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51824753556", tradingName: "Synthetic Liberty Trading" } });
  browser = await H.launch();
}
after(async () => { if (browser) await browser.close(); });

async function openPublic(p, opts = {}) { return openPublicRaw(p, { ready: "#in-form:not([hidden])", pick: "in", ...opts }); }
async function openPublicRaw(p, { w = 390, h = 900, init = "", ready, pick } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1 });
  if (init) await page.evaluateOnNewDocument(init);
  await page.setRequestInterception(true);
  page.sent = [];
  page.on("request", async (r) => {
    const u = new URL(r.url());
    if (u.origin !== "https://expresshelp.site") return r.abort();
    page.sent.push(r.url() + " " + (r.postData() || "").slice(0, 2000));
    if (u.pathname.startsWith("/api/")) {
      const res = await H.call(r.method(), u.pathname + u.search, { body: r.postData() || undefined });
      const hh = {}; res.headers.forEach((v, k) => { if (k !== "set-cookie") hh[k] = v; });
      return r.respond({ status: res.status, headers: hh, body: Buffer.from(await res.arrayBuffer()) });
    }
    const file = "public" + (u.pathname.endsWith("/") ? u.pathname + "index.html" : fs.existsSync("public" + u.pathname + ".html") ? u.pathname + ".html" : u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.respond({ contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : /\.m?js$/.test(file) ? "text/javascript" : "application/octet-stream", body: fs.readFileSync(file) });
    r.respond({ status: 404, body: "" });
  });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("https://expresshelp.site" + p);
  await page.waitForSelector(ready, { timeout: 8000 });
  await page.waitForSelector('[data-site-pick="' + pick + '"][data-ready="1"]', { timeout: 8000 });
  return page;
}
async function openPublicOut(p) {
  const page = await openPublicRaw(p, { w: 390, h: 900, ready: "#out-form", pick: "out-" });
  return page;
}
const GEO_SPY = `window.__geoCalls = 0; (function(){ var g = navigator.geolocation; if (!g) return; var real = g.getCurrentPosition.bind(g); g.getCurrentPosition = function(){ window.__geoCalls++; return real.apply(null, arguments); }; })();`;

test("type-ahead: suggestions as you type, keyboard pick, VEA Retail card shows the company details and hides blanks", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const p = await openPublic("/visit/sign-in", { init: GEO_SPY });
  assert.equal(await p.evaluate(() => window.__geoCalls), 0, "location is not asked for on page load");
  await p.type("#site-q", "ball");
  await p.waitForSelector("#site-options:not([hidden]) .site-option");
  const opts = await p.$$eval(".site-option strong", (e) => e.map((x) => x.textContent));
  assert.deepEqual(opts, ["Synthetic Ballan Agent", "Synthetic Ballarat North"]);
  assert.equal(await p.$eval("#site-q", (e) => e.getAttribute("aria-expanded")), "true");
  const hBox = await p.$eval(".site-option", (e) => e.getBoundingClientRect().height);
  assert.ok(hBox >= 44, "suggestions are 44px tap targets");
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter");
  assert.equal(await p.$eval("#site-q", (e) => e.value), "Synthetic Ballarat North (LOC0201)");
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "s00000b01");
  const card = await p.$eval("#site-card", (c) => ({ hidden: c.hidden, text: c.innerText, terms: [...c.querySelectorAll("dt")].map((d) => d.textContent), tel: c.querySelector("a[href^='tel:']")?.getAttribute("href") }));
  assert.equal(card.hidden, false);
  assert.deepEqual(card.terms, ["Trading name", "ABN", "Address", "Phone"]);
  assert.match(card.text, /Synthetic Liberty Trading/); assert.match(card.text, /51 824 753 556/); assert.match(card.text, /VEA Retail/); assert.ok(!/Liberty site/.test(card.text));
  assert.equal(card.tel, "tel:0391137191");
  await p.type("#site-q", "x");
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "", "editing the text drops the pick");
  assert.equal(await p.$eval("#site-card", (c) => c.hidden), true);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 390px");
  await p.close();
});

test("use my location: asked only on tap, nearest sites listed, LOC CA card shows its own ABN and trading name, coordinates never sent", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  await browser.defaultBrowserContext().overridePermissions("https://expresshelp.site", ["geolocation"]);
  const p = await openPublic("/visit/sign-in", { init: GEO_SPY });
  await p.setGeolocation({ latitude: -37.61, longitude: 144.2 });
  assert.equal(await p.evaluate(() => window.__geoCalls), 0);
  await p.click("#site-near");
  await p.waitForSelector(".site-near-item");
  assert.equal(await p.evaluate(() => window.__geoCalls), 1);
  const near = await p.$$eval(".site-near-item strong", (e) => e.map((x) => x.textContent));
  assert.deepEqual(near, ["Synthetic Ballan Agent", "Synthetic Ballarat North", "Synthetic Geelong West"]);
  await p.click(".site-near-item");
  const card = await p.$eval("#site-card", (c) => c.innerText);
  assert.match(card, /Synthetic Ballan Fuels Pty Ltd/); assert.match(card, /10 000 110 866/); assert.match(card, /0412 345 678/); assert.match(card, /LOC CA/); assert.ok(!/Commission agent\b(?! )/.test(card.split("\n")[0] || ""));
  assert.ok(!card.includes("Synthetic Liberty Trading"));
  // Fill and submit with a synthetic photo, then check the payload and the stored snapshot.
  const img = path.join(os.tmpdir(), "synthetic-id.jpg");
  fs.writeFileSync(img, jpeg.encode({ data: Buffer.alloc(64 * 64 * 4, 180), width: 64, height: 64 }, 80).data);
  await p.type('input[name="name"]', "Synthetic Browser Visitor");
  await p.type('input[name="phone"]', "0400 000 002");
  await p.type('input[name="company"]', "Synthetic Co");
  await (await p.$("#photo-library")).uploadFile(img);
  await p.waitForFunction(() => window.visitorIdPhoto && window.visitorIdPhoto(), { timeout: 8000 });
  await p.evaluate(() => document.getElementById("in-form").requestSubmit());
  await p.waitForSelector("#in-done:not([hidden])", { timeout: 10000 });
  const sentText = p.sent.join("\n");
  assert.ok(!sentText.includes("-37.61") && !sentText.includes("144.2,") && !/"lat"|"lng"|latitude/.test(sentText.replace(/\/api\/visit\/sites[^\n]*/g, "")), "no visitor coordinates in any request");
  const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
  const visit = (await Promise.all(blobs.map((b) => lib.visitorStore().get(b.key, { type: "json" })))).find((v) => v.name === "Synthetic Browser Visitor");
  assert.equal(visit.site.siteType, "commission_agent"); assert.equal(visit.site.abn, SYN_AGENT_ABN);
  assert.equal(H.mailbox.filter((m) => !/code is \d{8}/.test(m.text || "")).length, 0, "no notification email");
  await p.close();
});

test("admin logs: site-type filter offers All, VEA Retail sites, All LOC CA sites and each LOC CA, and filters the table", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const p = await H.openPage(browser, owner, "visitors", { w: 1440, h: 900, log: false });
  await p.waitForSelector("#visitor-site-type");
  const options = await p.$$eval("#visitor-site-type option", (o) => o.map((x) => x.textContent));
  assert.ok(options.includes("All sites") && options.includes("VEA Retail sites") && options.includes("All LOC CA sites") && options.some((o) => o.startsWith("Synthetic Ballan Fuels Pty Ltd")), options.join(" | "));
  await p.select("#visitor-site-type", "agent:abn:10000110866");
  await p.click('[data-act="visitor-filter"]');
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="visitor-row"]')].length >= 1 && [...document.querySelectorAll('[data-testid="visitor-row"]')].every((r) => r.textContent.includes("LOC CA")), { timeout: 5000 });
  assert.equal(await p.$eval("#visitor-site-type", (s) => s.value), "agent:abn:10000110866", "the chosen filter stays selected");
  await p.close();
  const s = await H.openPage(browser, owner, "visitors/settings", { w: 1440, h: 900, log: false });
  await s.waitForSelector('[data-testid="site-detail-counts"]', { timeout: 8000 });
  assert.match(await s.$eval('[data-testid="site-detail-counts"]', (e) => e.textContent), /3 sites: 0 VEA Retail, 1 LOC CA, 2 not set \(shown as VEA Retail\)/);
  await s.type('[data-testid="site-details-csv"]', "loc,site_type\nLOC0203,company");
  await s.click('[data-act="site-details-preview"]');
  await s.waitForSelector('[data-testid="site-details-summary"]');
  assert.match(await s.$eval('[data-testid="site-details-summary"]', (e) => e.textContent), /Preview only, nothing saved\. 1 rows · 1 to change/);
  assert.equal(await s.$eval('[data-testid="site-details-apply"]', (b) => b.disabled), false);
  assert.equal((await lib.sitesStore().get("s00000b03", { type: "json" })).siteType, undefined, "preview did not write");
  await s.close();
});

test("sign-out page has the same picker; a picked site goes with the sign-out and tags the record; name + company matching still decides", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const photo = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 190), width: 8, height: 8 }, 80).data.toString("base64");
  const r = await H.call("POST", "/api/visit/sign-in", { body: { name: "Synthetic Leaver", phone: "0400 000 003", company: "Leave Co", location: "typed at sign-in", photo, idempotencyKey: "out-b-1-aaaaaaaaaaaaaaaaaa" } });
  assert.equal(r.status, 200);
  const p = await openPublicOut("/visit/sign-out");
  await p.type('[data-testid="visit-out-name"]', "Synthetic Leaver");
  await p.type('[data-testid="visit-out-company"]', "Leave Co");
  await p.type("#out-site-q", "ballan");
  await p.waitForSelector("#out-site-options:not([hidden]) .site-option");
  await p.keyboard.press("Enter");
  const card = await p.$eval("#out-site-card", (c) => c.innerText);
  assert.match(card, /LOC CA/); assert.match(card, /Synthetic Ballan Fuels Pty Ltd/);
  assert.equal(await p.$eval("#out-site-q", (e) => e.required), false, "the site is optional on sign-out");
  await p.click('[data-testid="visit-card"]');
  await p.evaluate(() => document.getElementById("out-form").requestSubmit());
  await p.waitForSelector("#out-done:not([hidden])", { timeout: 8000 });
  const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
  const v = (await Promise.all(blobs.map((b) => lib.visitorStore().get(b.key, { type: "json" })))).find((x) => x.name === "Synthetic Leaver");
  assert.ok(v.signedOutAt); assert.equal(v.signOutSite.siteId, "s00000b02");
  assert.equal(v.site.from, "sign-out", "a visit typed at sign-in takes its type tag from the sign-out pick");
  assert.equal(v.location, "typed at sign-in", "the sign-in location text is never rewritten");
  assert.equal(H.mailbox.filter((m) => !/code is \d{8}/.test(m.text || "")).length, 0);
  await p.close();
});

test("combined /visit page: two pickers (sign-in and sign-out) work independently", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const p = await openPublic("/visit", { w: 1440 });
  await p.waitForSelector('[data-site-pick="out-"][data-ready="1"]');
  assert.equal(await p.$$eval("[id]", (els) => { const seen = new Set(); let dup = 0; for (const e of els) { if (seen.has(e.id)) dup++; seen.add(e.id); } return dup; }), 0, "no duplicate ids");
  await p.type("#out-site-q", "geelong"); await p.waitForSelector("#out-site-options .site-option"); await p.keyboard.press("Enter");
  assert.equal(await p.$eval('#out-form input[name=siteId]', (e) => e.value), "s00000b03");
  assert.equal(await p.$eval('#in-form input[name=siteId]', (e) => e.value), "", "the sign-in picker is untouched");
  assert.match(await p.$eval("#out-site-card", (c) => c.innerText), /VEA Retail/);
  await p.close();
});
