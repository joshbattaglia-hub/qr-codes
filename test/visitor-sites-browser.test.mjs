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
    { id: "s00000b04", name: "Synthetic Unattended Ballarat", loc: "LOC0204", address: "10 Example Rd, Ballarat VIC 3350", lat: -37.55, lng: 143.85, siteType: "unattended" },
    { id: "s00000b05", name: "Synthetic Unattended Mernda", loc: "LOC0205", address: "1444 Plenty Rd, Mernda VIC 3754", lat: -37.60, lng: 145.10, siteType: "unattended" },
    { id: "s00000b06", name: "Synthetic Unattended Geelong West", loc: "LOC0206", address: "21-25 Church St, Geelong West VIC 3218", lat: -38.14, lng: 144.35, siteType: "unattended" },
  ];
  for (const s of sites) await lib.sitesStore().setJSON(s.id, s);
  await H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51824753556", tradingName: "Synthetic Liberty Trading" } });
  browser = await H.launch();
}
after(async () => { if (browser) await browser.close(); });

async function openPublic(p, opts = {}) { return openPublicRaw(p, { ready: "#in-form:not([hidden])", pick: "in", ...opts }); }
async function openPublicRaw(p, { w = 390, h = 900, init = "", ready, pick, sites } = {}) {
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
      if (sites !== undefined && u.pathname.replace(/\/+$/, "") === "/api/visit/sites" && r.method() === "GET") {
        const body = { sites, total: sites.length, withCoordinates: sites.filter((s) => s.lat != null).length, picker: "unattended" };
        return r.respond({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }
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

test("type-ahead: suggestions as you type, keyboard pick, Unattended card shows the company details and hides retail sites", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const p = await openPublic("/visit/sign-in", { init: GEO_SPY });
  assert.equal(await p.evaluate(() => window.__geoCalls), 0, "location is not asked for on page load");
  await p.type("#site-q", "ball");
  await p.waitForSelector("#site-options:not([hidden]) .site-option");
  const opts = await p.$$eval(".site-option strong", (e) => e.map((x) => x.textContent));
  assert.deepEqual(opts, ["Synthetic Unattended Ballarat"]);
  assert.ok(!opts.includes("Synthetic Ballarat North") && !opts.includes("Synthetic Ballan Agent"), "retail sites are not suggested");
  assert.equal(await p.$eval("#site-q", (e) => e.getAttribute("aria-expanded")), "true");
  const hBox = await p.$eval(".site-option", (e) => e.getBoundingClientRect().height);
  assert.ok(hBox >= 44, "suggestions are 44px tap targets");
  await p.keyboard.press("Enter");
  assert.equal(await p.$eval("#site-q", (e) => e.value), "Synthetic Unattended Ballarat (LOC0204)");
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "s00000b04");
  const card = await p.$eval("#site-card", (c) => ({ hidden: c.hidden, text: c.innerText, terms: [...c.querySelectorAll("dt")].map((d) => d.textContent), tel: c.querySelector("a[href^='tel:']")?.getAttribute("href") }));
  assert.equal(card.hidden, false);
  assert.deepEqual(card.terms, ["Trading name", "ABN", "Address", "Phone"]);
  assert.match(card.text, /Synthetic Liberty Trading/); assert.match(card.text, /51 824 753 556/); assert.match(card.text, /Unattended/); assert.ok(!/Liberty site/.test(card.text) && !/VEA Retail/.test(card.text));
  assert.equal(card.tel, "tel:0391137191");
  await p.type("#site-q", "x");
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "", "editing the text drops the pick");
  assert.equal(await p.$eval("#site-card", (c) => c.hidden), true);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 390px");
  await p.close();
});

test("use my location: asked only on tap, nearest Unattended sites listed, card shows company details, coordinates never sent", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  await browser.defaultBrowserContext().overridePermissions("https://expresshelp.site", ["geolocation"]);
  const p = await openPublic("/visit/sign-in", { init: GEO_SPY });
  await p.setGeolocation({ latitude: -37.61, longitude: 145.10 });
  assert.equal(await p.evaluate(() => window.__geoCalls), 0);
  await p.click("#site-near");
  await p.waitForSelector(".site-near-item");
  assert.equal(await p.evaluate(() => window.__geoCalls), 1);
  const near = await p.$$eval(".site-near-item strong", (e) => e.map((x) => x.textContent));
  assert.deepEqual(near.slice().sort(), ["Synthetic Unattended Ballarat", "Synthetic Unattended Geelong West", "Synthetic Unattended Mernda"].sort());
  assert.ok(!near.includes("Synthetic Ballan Agent") && !near.includes("Synthetic Ballarat North"));
  await p.click(".site-near-item");
  const card = await p.$eval("#site-card", (c) => c.innerText);
  assert.match(card, /Unattended/);
  assert.match(card, /Synthetic Liberty Trading/);
  assert.match(card, /51 824 753 556/);
  assert.ok(!card.includes("LOC CA") && !card.includes("Synthetic Ballan Fuels"));
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
  assert.equal(visit.site.siteType, "unattended"); assert.equal(visit.site.abn, "51 824 753 556");
  assert.equal(H.mailbox.filter((m) => !/code is \d{8}/.test(m.text || "")).length, 0, "no notification email");
  await p.close();
});

test("admin logs: site-type filter offers All, VEA Retail, LOC CA, Unattended and each site, and filters the table", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const photo = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 190), width: 8, height: 8 }, 80).data.toString("base64");
  const signed = await H.call("POST", "/api/visit/sign-in", { body: { name: "Synthetic Agent Visitor", phone: "0400 000 008", company: "Agent Co", location: "typed", siteId: "s00000b02", photo, idempotencyKey: "adm-ca-1-aaaaaaaaaaaaaaaaa" } });
  if (signed.status !== 200) throw new Error("fixture sign-in failed " + signed.status);
  const p = await H.openPage(browser, owner, "visitors", { w: 1440, h: 900, log: false });
  await p.waitForSelector("#visitor-site-type");
  const options = await p.$$eval("#visitor-site-type option", (o) => o.map((x) => x.textContent));
  assert.ok(options.includes("All sites") && options.includes("VEA Retail sites") && options.includes("All LOC CA sites") && options.includes("Unattended sites") && options.some((o) => o.startsWith("Synthetic Ballan Fuels Pty Ltd")) && options.some((o) => o.startsWith("Synthetic Unattended Ballarat")), options.join(" | "));
  await p.select("#visitor-site-type", "agent:abn:10000110866");
  await p.click('[data-act="visitor-filter"]');
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="visitor-row"]')].length >= 1 && [...document.querySelectorAll('[data-testid="visitor-row"]')].every((r) => r.textContent.includes("LOC CA")), { timeout: 5000 });
  assert.equal(await p.$eval("#visitor-site-type", (s) => s.value), "agent:abn:10000110866", "the chosen filter stays selected");
  await p.select("#visitor-site-type", "unattended");
  await p.click('[data-act="visitor-filter"]');
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="visitor-row"]')].length >= 1 && [...document.querySelectorAll('[data-testid="visitor-row"]')].every((r) => r.textContent.includes("Unattended")), { timeout: 5000 });
  await p.close();
  const s = await H.openPage(browser, owner, "visitors/settings", { w: 1440, h: 900, log: false });
  await s.waitForSelector('[data-testid="site-detail-counts"]', { timeout: 8000 });
  assert.match(await s.$eval('[data-testid="site-detail-counts"]', (e) => e.textContent), /6 sites: 0 VEA Retail, 1 LOC CA, 3 Unattended, 2 not set \(shown as VEA Retail\)/);
  await s.type('[data-testid="site-details-csv"]', "loc,site_type\nLOC0203,company");
  await s.click('[data-act="site-details-preview"]');
  await s.waitForSelector('[data-testid="site-details-summary"]');
  assert.match(await s.$eval('[data-testid="site-details-summary"]', (e) => e.textContent), /Preview only, nothing saved\. 1 rows · 0 to add · 1 to change/);
  assert.equal(await s.$eval('[data-testid="site-details-apply"]', (b) => b.disabled), false);
  assert.equal((await lib.sitesStore().get("s00000b03", { type: "json" })).siteType, undefined, "preview did not write");
  await s.evaluate(() => { document.querySelector('[data-testid="site-details-csv"]').value = ""; });
  await s.type('[data-testid="site-details-csv"]', "site_name,site_type,address\nSynthetic Unattended Preview Add,unattended,1 Test St Moe VIC 3825");
  await s.click('[data-act="site-details-preview"]');
  await s.waitForFunction(() => /to add/.test(document.querySelector('[data-testid="site-details-summary"]')?.textContent || "") && /1 to add/.test(document.querySelector('[data-testid="site-details-summary"]')?.textContent || ""));
  assert.match(await s.$eval('[data-testid="site-details-summary"]', (e) => e.textContent), /1 to add/);
  assert.ok(await s.$('[data-testid="site-preview-add"]'));
  assert.equal(await s.$eval('[data-testid="site-details-apply"]', (b) => b.disabled), false);
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
  await p.type("#out-site-q", "mernda");
  await p.waitForSelector("#out-site-options:not([hidden]) .site-option");
  await p.keyboard.press("Enter");
  const card = await p.$eval("#out-site-card", (c) => c.innerText);
  assert.match(card, /Unattended/); assert.match(card, /Synthetic Unattended Mernda/);
  assert.equal(await p.$eval("#out-site-q", (e) => e.required), false, "the site is optional on sign-out");
  await p.click('[data-testid="visit-card"]');
  await p.evaluate(() => document.getElementById("out-form").requestSubmit());
  await p.waitForSelector("#out-done:not([hidden])", { timeout: 8000 });
  const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
  const v = (await Promise.all(blobs.map((b) => lib.visitorStore().get(b.key, { type: "json" })))).find((x) => x.name === "Synthetic Leaver");
  assert.ok(v.signedOutAt); assert.equal(v.signOutSite.siteId, "s00000b05");
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
  assert.equal(await p.$eval('#out-form input[name=siteId]', (e) => e.value), "s00000b06");
  assert.equal(await p.$eval('#in-form input[name=siteId]', (e) => e.value), "", "the sign-in picker is untouched");
  assert.match(await p.$eval("#out-site-card", (c) => c.innerText), /Unattended/);
  await p.close();
});

test("when no Unattended sites are listed, search and Use my location are hidden and the typed site field still works", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const errors = [];
  const p = await openPublic("/visit/sign-in", { sites: [] });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.waitForSelector('[data-site-pick="in"][data-ready="1"][data-empty="1"]');
  assert.equal(await p.$eval("#site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), true);
  assert.equal(await p.$eval(".near-privacy", (e) => e.hidden || getComputedStyle(e).display === "none"), true);
  assert.equal(await p.$eval("#site-q", (e) => e.required), true);
  assert.equal(await p.$eval("#site-q", (e) => e.getAttribute("role")), null);
  assert.match(await p.$eval('label[for="site-q"]', (e) => e.textContent), /Type the site name or number/);
  await p.type("#site-q", "typed site");
  assert.equal(await p.$eval("#site-options", (e) => e.hidden), true);
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "");
  assert.deepEqual(errors, []);
  await p.close();
  const out = await openPublicRaw("/visit/sign-out", { ready: "#out-form", pick: "out-", sites: [] });
  await out.waitForSelector('[data-site-pick="out-"][data-ready="1"][data-empty="1"]');
  assert.equal(await out.$eval("#out-site-q", (e) => e.required), false);
  assert.equal(await out.$eval("#out-site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), true);
  await out.type("#out-site-q", "typed out");
  assert.equal(await out.$eval("#out-site-q", (e) => e.value), "typed out");
  await out.close();
});
