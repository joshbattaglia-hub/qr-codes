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
    { id: "s00000b04", name: "Synthetic Unattended Ballarat", loc: "LOC0204", address: "10 Example Rd, Ballarat VIC 3350", lat: -37.55, lng: 143.85, siteType: "unattended", tradingName: "Synthetic Unattended Pty Ltd", abn: "20 000 000 190" },
    { id: "s00000b05", name: "Synthetic Unattended Mernda", loc: "LOC0205", address: "1444 Plenty Rd, Mernda VIC 3754", lat: -37.60, lng: 145.10, siteType: "unattended", tradingName: "Synthetic Unattended Pty Ltd", abn: "20 000 000 190" },
    { id: "s00000b06", name: "Synthetic Unattended Geelong West", loc: "LOC0206", address: "21-25 Church St, Geelong West VIC 3218", lat: -38.14, lng: 144.35, siteType: "unattended", tradingName: "Synthetic Unattended Pty Ltd", abn: "20 000 000 190" },
  ];
  for (const s of sites) await lib.sitesStore().setJSON(s.id, s);
  await H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51824753556", tradingName: "Synthetic Liberty Trading" } });
  browser = await H.launch();
}
after(async () => { if (browser) await browser.close(); });

async function openPublic(p, opts = {}) { return openPublicRaw(p, { ready: "#in-form:not([hidden])", pick: "in", ...opts }); }
async function openPublicRaw(p, { w = 390, h = 900, init = "", ready, pick, sites, sitesError, readyAttr = "1" } = {}) {
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
      if (u.pathname.replace(/\/+$/, "") === "/api/visit/sites" && r.method() === "GET" && (sites !== undefined || sitesError)) {
        if (sitesError === "network") return r.abort("failed");
        if (sitesError === "http") return r.respond({ status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unavailable" }) });
        if (sitesError === "json") return r.respond({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unavailable" }) });
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
  await page.waitForSelector('[data-site-pick="' + pick + '"][data-ready="' + readyAttr + '"]', { timeout: 8000 });
  return page;
}
async function openPublicOut(p) {
  const page = await openPublicRaw(p, { w: 390, h: 900, ready: "#out-form", pick: "out-" });
  return page;
}
const GEO_SPY = `window.__geoCalls = 0; (function(){ var g = navigator.geolocation; if (!g) return; var real = g.getCurrentPosition.bind(g); g.getCurrentPosition = function(){ window.__geoCalls++; return real.apply(null, arguments); }; })();`;

test("type-ahead: suggestions as you type, keyboard pick, Unattended card shows its own details and hides retail sites", { skip: SKIP, timeout: 60000 }, async () => {
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
  assert.deepEqual(card.terms, ["Trading name", "ABN", "Address", "Phone", "Email"]);
  assert.match(card.text, /Synthetic Unattended Pty Ltd/); assert.match(card.text, /20 000 000 190/); assert.match(card.text, /Unattended/); assert.ok(!/Liberty site/.test(card.text) && !/VEA Retail/.test(card.text) && !/Synthetic Liberty Trading/.test(card.text));
  assert.equal(card.tel, "tel:0391137191");
  const mail = await p.$eval("#site-card a[href^='mailto:']", (a) => ({ href: a.getAttribute("href"), text: a.textContent }));
  assert.equal(mail.href, "mailto:pumprepairs@libertyretail.com.au");
  assert.equal(mail.text, "pumprepairs@libertyretail.com.au");
  await p.type("#site-q", "x");
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "", "editing the text drops the pick");
  assert.equal(await p.$eval("#site-card", (c) => c.hidden), true);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 390px");
  await p.close();
});

test("use my location: asked only on tap, nearest Unattended sites listed, card shows per-site details, coordinates never sent", { skip: SKIP, timeout: 60000 }, async () => {
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
  assert.match(card, /Synthetic Unattended Pty Ltd/);
  assert.match(card, /20 000 000 190/);
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
  assert.equal(visit.site.siteType, "unattended"); assert.equal(visit.site.abn, "20 000 000 190");
  assert.equal(visit.site.contactEmail, "pumprepairs@libertyretail.com.au");
  await p.waitForSelector('[data-testid="visit-contact-email"]', { timeout: 8000 });
  assert.equal(await p.$eval('[data-testid="visit-contact-email"]', (a) => a.getAttribute("href")), "mailto:pumprepairs@libertyretail.com.au");
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
  const s = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 900, log: false });
  await s.waitForSelector('[data-testid="site-detail-counts"]', { timeout: 8000 });
  assert.ok(await s.$('[data-testid="visitor-tab-sites"]'));
  assert.ok(await s.$('[data-testid="sites-table"]'));
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

test("when no Unattended sites are listed, Use my location is hidden, there is only one Site heading, and the typed site field still works", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const errors = [];
  const p = await openPublic("/visit/sign-in", { sites: [] });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.waitForSelector('[data-site-pick="in"][data-ready="1"][data-empty="1"]');
  assert.equal(await p.$eval("#site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), true);
  assert.equal(await p.$eval(".near-privacy", (e) => e.hidden || getComputedStyle(e).display === "none"), true);
  assert.equal(await p.$eval("#site-q", (e) => e.required), true);
  assert.equal(await p.$eval("#site-q", (e) => e.getAttribute("role")), null);
  assert.deepEqual(await p.$$eval(".site-pick-title", (els) => els.map((e) => e.textContent.trim())), ["Site"]);
  const lab = await p.$eval('label[for="site-q"]', (e) => e.textContent.trim());
  assert.match(lab, /Type the site name or number/);
  assert.ok(!/^Site/.test(lab), "the field label does not repeat the Site heading: " + lab);
  assert.equal(await p.$eval('[data-testid="site-pick-empty-note"]', (e) => e.hidden || getComputedStyle(e).display === "none"), false);
  assert.match(await p.$eval('[data-testid="site-pick-empty-note"]', (e) => e.textContent), /No sites are listed to pick/);
  await p.type("#site-q", "typed site");
  assert.equal(await p.$eval("#site-options", (e) => e.hidden), true);
  assert.equal(await p.$eval("input[name=siteId]", (e) => e.value), "");
  assert.deepEqual(errors, []);
  await p.close();
  const out = await openPublicRaw("/visit/sign-out", { ready: "#out-form", pick: "out-", sites: [] });
  await out.waitForSelector('[data-site-pick="out-"][data-ready="1"][data-empty="1"]');
  assert.equal(await out.$eval("#out-site-q", (e) => e.required), false);
  assert.equal(await out.$eval("#out-site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), true);
  assert.deepEqual(await out.$$eval(".site-pick-title", (els) => els.map((e) => e.textContent.trim())), ["Site you are leaving"]);
  const outLab = await out.$eval('label[for="out-site-q"]', (e) => e.textContent.trim());
  assert.ok(!/^Site/.test(outLab), outLab);
  assert.match(await out.$eval('[data-testid="out-site-pick-empty-note"]', (e) => e.textContent), /No sites are listed to pick/);
  await out.type("#out-site-q", "typed out");
  assert.equal(await out.$eval("#out-site-q", (e) => e.value), "typed out");
  await out.close();
});


test("when the site list fails to load, Use my location stays visible and the form does not fall back to a doubled Site heading", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  for (const kind of ["http", "json", "network"]) {
    const errors = [];
    const p = await openPublic("/visit/sign-in", { sitesError: kind, readyAttr: "error", init: GEO_SPY });
    p.on("pageerror", (e) => errors.push(e.message));
    await p.waitForSelector('[data-site-pick="in"][data-ready="error"]');
    assert.equal(await p.$eval('[data-site-pick="in"]', (e) => e.getAttribute("data-empty") || "0"), "0", kind);
    assert.equal(await p.$eval("#site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), false, "button stays for " + kind);
    assert.deepEqual(await p.$$eval(".site-pick-title", (els) => els.map((e) => e.textContent.trim())), ["Site"]);
    const lab = await p.$eval('label[for="site-q"]', (e) => e.textContent.trim());
    assert.ok(!/^Site/.test(lab) || /Or search/.test(lab), lab);
    assert.match(await p.$eval("#site-near-note", (e) => e.textContent), /could not be loaded/);
    assert.equal(await p.evaluate(() => window.__geoCalls), 0);
    await p.click("#site-near");
    assert.equal(await p.evaluate(() => window.__geoCalls), 0, "a failed list does not ask for location (" + kind + ")");
    assert.match(await p.$eval("#site-near-note", (e) => e.textContent), /could not be loaded/);
    assert.deepEqual(errors, []);
    await p.close();
  }
  const out = await openPublicRaw("/visit/sign-out", { ready: "#out-form", pick: "out-", sitesError: "http", readyAttr: "error" });
  await out.waitForSelector('[data-site-pick="out-"][data-ready="error"]');
  assert.equal(await out.$eval("#out-site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), false);
  assert.match(await out.$eval("#out-site-near-note", (e) => e.textContent), /could not be loaded/);
  await out.close();
});

test("when listed sites have no coordinates, Use my location stays visible and explains on tap without asking for location", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const sites = [{ id: "s00000c01", name: "Synthetic No Coords", loc: "LOC0301", type: "unattended", address: "1 Example Rd" }];
  const p = await openPublic("/visit/sign-in", { sites, init: GEO_SPY });
  assert.equal(await p.$eval("#site-near", (e) => e.hidden || getComputedStyle(e).display === "none"), false);
  assert.equal(await p.$eval('[data-site-pick="in"]', (e) => e.getAttribute("data-empty") || "0"), "0");
  await p.click("#site-near");
  await p.waitForFunction(() => document.querySelector("#site-near-note")?.textContent.includes("not set up yet"));
  assert.equal(await p.evaluate(() => window.__geoCalls), 0);
  await p.close();
});

test("QR sign-in and sign-out URLs at 390px show Use my location and a single heading, with no page errors", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  for (const [path, pick, ready, near, title] of [
    ["/visit/sign-in", "in", "#in-form:not([hidden])", "#site-near", "Site"],
    ["/visit/sign-out", "out-", "#out-form", "#out-site-near", "Site you are leaving"],
  ]) {
    const errors = [];
    const p = await openPublicRaw(path, { w: 390, h: 844, ready, pick, init: GEO_SPY });
    p.on("pageerror", (e) => errors.push(e.message));
    await p.waitForSelector('[data-site-pick="' + pick + '"][data-ready="1"]');
    assert.equal(await p.$eval(near, (e) => e.hidden || getComputedStyle(e).display === "none"), false, path);
    assert.deepEqual(await p.$$eval(".site-pick-title", (els) => els.map((e) => e.textContent.trim())), [title]);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 390px on " + path);
    assert.equal(await p.evaluate(() => window.__geoCalls), 0, "location is not asked for on load of " + path);
    assert.deepEqual(errors, []);
    await p.close();
  }
});

test("admin sites manager: table, add form, Unattended edit form, hide and remove confirms; screenshots at 390 and 1440", { skip: SKIP, timeout: 90000 }, async () => {
  await boot();
  const dir = path.join("screenshots");
  fs.mkdirSync(dir, { recursive: true });
  async function shot(page, name, sel) {
    const file = path.join(dir, name);
    if (sel) {
      const el = await page.$(sel);
      assert.ok(el, "screenshot target " + sel);
      await el.screenshot({ path: file });
    } else {
      await page.screenshot({ path: file, fullPage: false });
    }
    return file;
  }
  for (const w of [1440, 390]) {
    const p = await H.openPage(browser, owner, "visitors/sites", { w, h: w < 500 ? 844 : 900, theme: "crazy", log: false });
    await p.waitForSelector('[data-testid="sites-table"]', { timeout: 8000 });
    const names = await p.$$eval('[data-testid="site-row"] td:first-child', (els) => els.map((e) => e.textContent));
    assert.ok(names.includes("Synthetic Unattended Ballarat"), "table lists Unattended sites at " + w);
    assert.ok(names.includes("Synthetic Ballarat North"), "retail sites stay in the manager at " + w);
    assert.ok(await p.$('[data-testid="picker-types"]'));
    assert.equal(await p.$eval('[data-testid="picker-type-unattended"]', (e) => e.checked), true);
    await p.$eval("#site-details", (e) => e.scrollIntoView({ block: "start" })); await H.wait(200); await shot(p, "sites-page-" + w + ".png");
    await p.$eval("#sites-manager", (e) => e.scrollIntoView({ block: "start" })); await H.wait(200); await shot(p, "sites-table-" + w + ".png");
    await p.select("#site-mgr-type", "unattended");
    const only = await p.$$eval('[data-testid="site-row"] td:first-child', (els) => els.map((e) => e.textContent));
    assert.ok(only.every((n) => /Unattended/.test(n)), only.join(" | "));

    await p.click('[data-testid="site-add-open"]');
    await p.waitForSelector('[data-testid="site-add-form"]');
    assert.ok(await p.$eval('[data-testid="site-add-form"]', (f) => f.getBoundingClientRect().width > 0));
    assert.equal(await p.$eval('[data-testid="site-form-type"]', (s) => s.value), "unattended");
    assert.equal(await p.$eval("#site-own-details", (e) => e.hidden), false, "Unattended add form shows per-site ABN and trading name");
    await p.$eval("#site-own-details", (e) => e.scrollIntoView({ block: "center" })); await H.wait(150); await shot(p, "sites-add-" + w + ".png", ".modal-card");
    await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
    await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });

    await p.evaluate(() => {
      const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
      row?.querySelector('[data-testid="site-edit"]')?.click();
    });
    await p.waitForSelector('[data-testid="site-edit-form"]');
    assert.equal(await p.$eval('[data-testid="site-form-name"]', (e) => e.value), "Synthetic Unattended Ballarat");
    assert.equal(await p.$eval('[data-testid="site-form-type"]', (s) => s.value), "unattended");
    assert.equal(await p.$eval('[data-testid="site-form-trading-name"]', (e) => e.value), "Synthetic Unattended Pty Ltd");
    assert.equal(await p.$eval('[data-testid="site-form-abn"]', (e) => e.value), "20 000 000 190");
    assert.equal(await p.$eval("#site-own-details", (e) => e.hidden), false);
    await p.$eval("#site-own-details", (e) => e.scrollIntoView({ block: "center" })); await H.wait(150); await shot(p, "sites-edit-unattended-" + w + ".png", ".modal-card");
    await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
    await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });

    await p.evaluate(() => {
      const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
      row?.querySelector('[data-testid="site-remove"]')?.click();
    });
    await p.waitForSelector('[data-testid="site-remove-confirm"]');
    assert.match(await p.$eval(".modal-card", (e) => e.innerText), /Remove this site\?/);
    assert.match(await p.$eval(".modal-card", (e) => e.innerText), /Past sign-ins keep their saved site details/);
    await shot(p, "sites-remove-confirm-" + w + ".png", ".modal-card");
    await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
    await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });

    await p.evaluate(() => {
      const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
      row?.querySelector('[data-testid="site-hide"]')?.click();
    });
    await p.waitForSelector('[data-testid="site-hide-confirm"]');
    assert.match(await p.$eval(".modal-card", (e) => e.innerText), /Hide this site\?/);
    await shot(p, "sites-hide-confirm-" + w + ".png", ".modal-card");
    await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
    await p.close();
  }
});

test("Sites CSV download has type ticks, defaults to Unattended (the picker types), and disables when none are ticked", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const p = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 900, log: false });
  await p.waitForSelector('[data-testid="csv-types"]', { timeout: 8000 });
  assert.equal(await p.$eval("#picker-types", (e) => e.textContent.trim()), "Show on visitor sign-in");
  const pickerLabels = await p.$$eval('[data-testid="picker-types"] label', (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  assert.deepEqual(pickerLabels, ["Shell Express / 24Xpress (Unattended)", "VEA Retail (retail sites)", "LOC CA (retail sites)"]);
  assert.match(await p.$eval("#picker-types + p", (e) => e.textContent), /90 retail sites/);
  assert.equal(await p.$eval("#csv-download", (e) => e.textContent.trim()), "Include in CSV download");
  assert.ok(await p.$('[data-testid="csv-download"]'), "the CSV ticks sit in a separate section");
  assert.equal(await p.$eval('[data-testid="csv-type-unattended"]', (e) => e.checked), true, "Unattended starts ticked, matching the picker");
  assert.equal(await p.$eval('[data-testid="csv-type-company"]', (e) => e.checked), false);
  assert.equal(await p.$eval('[data-testid="csv-type-commission_agent"]', (e) => e.checked), false);
  assert.equal(await p.$eval('[data-testid="site-details-download"]', (b) => b.disabled), false);
  assert.equal(await p.$eval('[data-testid="csv-types-hint"]', (e) => e.hidden), true);
  await p.click('[data-testid="csv-type-unattended"]');
  assert.equal(await p.$eval('[data-testid="site-details-download"]', (b) => b.disabled), true);
  assert.equal(await p.$eval('[data-testid="csv-types-hint"]', (e) => e.hidden), false);
  assert.match(await p.$eval('[data-testid="csv-types-hint"]', (e) => e.textContent), /Tick at least one site type/);
  await p.click('[data-testid="csv-types-all"]');
  assert.equal(await p.$eval('[data-testid="csv-type-company"]', (e) => e.checked), true);
  assert.equal(await p.$eval('[data-testid="csv-type-commission_agent"]', (e) => e.checked), true);
  assert.equal(await p.$eval('[data-testid="csv-type-unattended"]', (e) => e.checked), true);
  assert.equal(await p.$eval('[data-testid="site-details-download"]', (b) => b.disabled), false);
  await p.click('[data-testid="csv-types-unattended"]');
  assert.equal(await p.$eval('[data-testid="csv-type-unattended"]', (e) => e.checked), true);
  assert.equal(await p.$eval('[data-testid="csv-type-company"]', (e) => e.checked), false);
  assert.equal(await p.$eval('[data-testid="csv-type-commission_agent"]', (e) => e.checked), false);
  assert.equal(await p.$eval('[data-testid="site-details-download"]', (b) => b.disabled), false);
  await p.close();
});

test("clicking a field in the site Edit or Add dialog does not close it; typing sticks; Cancel and Save still work", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  const p = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 1100, log: false });
  await p.waitForSelector('[data-testid="sites-table"]', { timeout: 8000 });

  async function openEdit() {
    await p.evaluate(() => {
      const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
      row?.querySelector('[data-testid="site-edit"]')?.click();
    });
    await p.waitForSelector('[data-testid="site-edit-form"]', { timeout: 8000 });
  }
  async function modalOpen(sel = "[data-testid=site-edit-form]") {
    return p.$eval("#modal", (m, s) => !m.classList.contains("hidden") && !!m.querySelector(s), sel);
  }

  await p.click('[data-testid="company-abn"]');
  assert.ok(await p.$('[data-testid="company-trading-name"]') && await p.$('[data-testid="company-abn"]'), "VEA Retail details disappeared after clicking ABN");
  const companyAbn = await p.$eval('[data-testid="company-abn"]', (el) => el.value);
  await p.$eval('[data-testid="company-trading-name"]', (el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await p.type('[data-testid="company-trading-name"]', "x");
  assert.match(await p.$eval('[data-testid="company-trading-name"]', (el) => el.value), /x$/);
  assert.equal(await p.$eval('[data-testid="company-abn"]', (el) => el.value), companyAbn);

  await openEdit();
  for (const id of ["site-form-name", "site-form-loc", "site-form-address", "site-form-phone", "site-form-contact-email", "site-form-trading-name", "site-form-abn"]) {
    const sel = '[data-testid="' + id + '"]';
    await p.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
    await p.click(sel);
    assert.equal(await modalOpen(), true, "edit dialog closed when clicking " + id);
    const room = await p.$eval(sel, (el) => !el.maxLength || el.maxLength < 0 || el.value.length < el.maxLength);
    if (room) {
      await p.$eval(sel, (el) => { el.focus(); if (el.type !== "email" && typeof el.setSelectionRange === "function") { const end = el.value.length; el.setSelectionRange(end, end); } });
      await p.type(sel, "x");
      assert.equal(await modalOpen(), true, "edit dialog closed when typing in " + id);
      assert.match(await p.$eval(sel, (el) => el.value), /x$/, "typed value was lost in " + id);
    }
  }
  await p.click('[data-testid="site-form-type"]');
  assert.equal(await modalOpen(), true, "edit dialog closed when clicking the type menu");

  await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
  await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });
  const afterCancel = await lib.sitesStore().get("s00000b04", { type: "json" });
  assert.equal(afterCancel.name, "Synthetic Unattended Ballarat", "Cancel must not save");

  await p.click('[data-testid="site-add-open"]');
  await p.waitForSelector('[data-testid="site-add-form"]');
  await p.click('[data-testid="site-form-name"]');
  await p.type('[data-testid="site-form-name"]', "Synthetic Add Click Check");
  assert.equal(await modalOpen("[data-testid=site-add-form]"), true, "Add dialog closed when clicking a field");
  assert.equal(await p.$eval('[data-testid="site-form-name"]', (el) => el.value), "Synthetic Add Click Check");
  await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
  await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });

  await openEdit();
  const abn = await p.$('[data-testid="site-form-abn"]');
  await abn.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await abn.click({ clickCount: 3 });
  await p.keyboard.press("Backspace");
  await p.type('[data-testid="site-form-abn"]', "1111");
  assert.equal(await modalOpen(), true);
  assert.equal(await p.$eval('[data-testid="site-form-abn"]', (el) => el.value), "1111");
  await p.click('[data-testid="site-form-save"]');
  await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });
  const saved = await lib.sitesStore().get("s00000b04", { type: "json" });
  assert.equal(saved.abn, "1111");
  assert.equal(saved.name, "Synthetic Unattended Ballarat", "Save from the button must not have been a stale click-save");
  await p.close();
});

test("CSV import: an Excel-style file with formula-guarded latitudes and spaced ABNs previews and applies, and row errors stay visible", { skip: SKIP, timeout: 60000 }, async () => {
  await boot();
  await lib.sitesStore().setJSON("s00000b20", { id: "s00000b20", name: "Synthetic Unattended Import Apply", loc: "LOC0290", address: "1 Import Rd, Moe VIC 3825", lat: -38.1736, lng: 146.2588, siteType: "unattended" });
  const excel = "\ufeff" + [
    "loc,site_name,site_type,trading_name,abn,phone,address,lat,lng",
    "LOC0290,Synthetic Unattended Import Apply,unattended,Synthetic VIVA,51 824 753 556,,\"1 Import Rd, Moe VIC 3825\",\"'-38.1736\",146.2588",
    "LOC0999,Missing Site,unattended,Nope,1234,,,\"'-37.5\",144.9",
  ].join("\r\n") + "\r\n";
  const s = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 900, log: false });
  await s.waitForSelector('[data-testid="site-details-csv"]', { timeout: 8000 });
  await s.evaluate((csv) => { document.querySelector('[data-testid="site-details-csv"]').value = csv; }, excel);
  await s.click('[data-act="site-details-preview"]');
  await s.waitForSelector('[data-testid="site-details-summary"]');
  const preview = await s.$eval('[data-testid="site-details-summary"]', (e) => e.textContent);
  assert.match(preview, /Preview only, nothing saved/);
  assert.match(preview, /1 to change/);
  assert.match(preview, /1 with problems/);
  assert.ok(!/lat\/lng must both be set/.test(await s.$eval('[data-testid="site-details-preview"]', (e) => e.textContent)), "formula-guarded latitudes are accepted");
  const rowErr = await s.$eval('[data-testid="site-preview-row-error"]', (e) => e.textContent);
  assert.match(rowErr, /Not saved:/);
  assert.match(rowErr, /ABN 1234 is not valid/);
  assert.equal(await s.$eval('[data-testid="site-details-apply"]', (b) => b.disabled), false);
  assert.equal((await lib.sitesStore().get("s00000b20", { type: "json" })).abn, undefined, "preview did not write");
  s.once("dialog", (d) => d.accept());
  await s.click('[data-testid="site-details-apply"]');
  await s.waitForFunction(() => /Saved 1 site/.test(document.querySelector('[data-testid="site-details-summary"]')?.textContent || ""), { timeout: 8000 });
  const saved = await lib.sitesStore().get("s00000b20", { type: "json" });
  assert.equal(saved.abn, "51 824 753 556");
  assert.equal(saved.tradingName, "Synthetic VIVA");
  assert.equal(saved.lat, -38.1736);
  assert.equal(saved.lng, 146.2588);
  await s.close();
});

test("admin: default contact email, edit-form email field, and Settings footer; screenshots", { skip: SKIP, timeout: 90000 }, async () => {
  await boot();
  const dir = "/workspace/qr-codes-data/contact-email-screenshots";
  fs.mkdirSync(dir, { recursive: true });
  async function shot(page, file, sel) {
    const el = sel ? await page.$(sel) : null;
    if (sel) assert.ok(el, "screenshot target " + sel);
    await (el || page).screenshot({ path: path.join(dir, file) });
  }

  const signIn = await openPublic("/visit/sign-in");
  await signIn.type("#site-q", "ballarat");
  await signIn.waitForSelector("#site-options:not([hidden]) .site-option");
  await signIn.keyboard.press("Enter");
  await signIn.waitForSelector("#site-card:not([hidden])");
  await signIn.waitForFunction(() => {
    const card = document.getElementById("site-card");
    return card && /pumprepairs@libertyretail\.com\.au/.test(card.innerText) && /03 9113 7191/.test(card.innerText);
  }, { timeout: 8000 });
  await shot(signIn, "signin-card-390.png", "#site-card");
  await signIn.close();

  const sites = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 1100, log: false });
  await sites.waitForSelector('[data-testid="default-contact-email"]', { timeout: 8000 });
  assert.equal(await sites.$eval('[data-testid="default-contact-email"]', (el) => el.value), "pumprepairs@libertyretail.com.au");
  await sites.click('[data-testid="default-contact-email"]');
  assert.ok(await sites.$('[data-testid="default-contact-email"]'), "default email field disappeared when clicked");
  await sites.$eval('[data-testid="contact-email-save"]', (el) => el.scrollIntoView({ block: "center" }));
  await sites.screenshot({ path: path.join(dir, "admin-sites-default-email-1440.png") });
  await sites.evaluate(() => {
    const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
    row?.querySelector('[data-testid="site-edit"]')?.click();
  });
  await sites.waitForSelector('[data-testid="site-form-contact-email"]', { timeout: 8000 });
  await sites.click('[data-testid="site-form-contact-email"]');
  assert.equal(await sites.$eval("#modal", (m) => !m.classList.contains("hidden")), true, "edit dialog closed when clicking the contact email field");
  await sites.$eval('[data-testid="site-form-contact-email"]', (el) => el.scrollIntoView({ block: "center" }));
  await shot(sites, "admin-sites-edit-email-1440.png", ".modal-card");
  await sites.click('[data-testid="site-form-hide-email"]');
  assert.equal(await sites.$eval("#modal", (m) => !m.classList.contains("hidden")), true, "edit dialog closed when clicking hide email");
  assert.equal(await sites.$eval('[data-testid="site-form-contact-email"]', (el) => el.disabled), true);
  await sites.close();

  const settings = await H.openPage(browser, owner, "settings", { w: 1440, h: 1100, log: false });
  await settings.waitForSelector('[data-testid="footer-settings"]', { timeout: 8000 });
  await settings.waitForFunction(() => document.getElementById("footer-lead") && document.getElementById("footer-lead").value, { timeout: 8000 });
  assert.equal(await settings.$eval('[data-testid="footer-lead"]', (el) => el.value), "Cowabunga - please hesitate to reach out");
  assert.equal(await settings.$eval('[data-testid="footer-link-text"]', (el) => el.value), "email me here");
  assert.equal(await settings.$eval('[data-testid="footer-email"]', (el) => el.value), "jbattaglia@libertyretail.com.au");
  await settings.click('[data-testid="footer-lead"]');
  assert.ok(await settings.$('[data-testid="footer-settings"]'), "footer settings disappeared when clicking a field");
  await settings.$eval('[data-testid="footer-settings"]', (el) => el.scrollIntoView({ block: "center" }));
  await shot(settings, "admin-settings-footer-1440.png", '[data-testid="footer-settings"]');
  await settings.close();
});

test("site Edit and Add dialogs and the VEA Retail form show ABN errors under the field, inside the dialog", { skip: SKIP, timeout: 90000 }, async () => {
  await boot();
  const shotDir = "/workspace/qr-codes-data/inline-errors-screenshots";
  fs.mkdirSync(shotDir, { recursive: true });
  const ABN_MSG = /That ABN is not valid/;
  async function openEdit(page) {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
      row?.querySelector('[data-testid="site-edit"]')?.click();
    });
    await page.waitForSelector('[data-testid="site-edit-form"]', { timeout: 8000 });
  }
  async function fillAbn(page, value) {
    await page.$eval('[data-testid="site-form-abn"]', (el) => { el.focus(); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.type('[data-testid="site-form-abn"]', value);
  }
  async function errorLayout(page) {
    return page.evaluate(() => {
      const err = document.querySelector('[data-testid="site-field-error-abn"]');
      const input = document.querySelector('[data-testid="site-form-abn"]');
      const card = document.querySelector(".modal-card");
      if (!err || !input || !card) return { missing: true };
      const er = err.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      return {
        text: err.textContent,
        hidden: err.hidden,
        underField: er.top >= ir.bottom - 2,
        insideCard: er.top >= cr.top - 1 && er.bottom <= cr.bottom + 1 && er.left >= cr.left - 1 && er.right <= cr.right + 1,
        aria: input.getAttribute("aria-invalid"),
        described: (input.getAttribute("aria-describedby") || "").includes("site-field-error-abn"),
        focused: document.activeElement === input,
      };
    });
  }

  const wide = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 900, theme: "crazy", log: false });
  await wide.waitForSelector('[data-testid="sites-table"]', { timeout: 8000 });
  await openEdit(wide);
  await fillAbn(wide, "99702180390");
  await wide.click('[data-testid="site-form-save"]');
  await wide.waitForSelector('[data-testid="site-field-error-abn"]:not([hidden])', { timeout: 8000 });
  await H.wait(400);
  const client = await errorLayout(wide);
  assert.match(client.text, ABN_MSG);
  assert.equal(client.hidden, false);
  assert.equal(client.underField, true, "client ABN error should sit under the field");
  assert.equal(client.insideCard, true, "client ABN error should stay inside the dialog");
  assert.equal(client.aria, "true");
  assert.equal(client.described, true);
  assert.equal(client.focused, true);
  await wide.screenshot({ path: path.join(shotDir, "edit-abn-error-1440.png"), fullPage: false });
  await wide.$eval(".modal-card", (el) => el.scrollIntoView({ block: "center" }));
  const card = await wide.$(".modal-card");
  await card.screenshot({ path: path.join(shotDir, "edit-abn-error-1440-dialog.png") });
  const postsBefore = await wide.evaluate(() => window.__sitePosts || 0);
  await wide.evaluate(() => { window.__sitePosts = 0; const orig = window.fetch; window.fetch = function(url, opts) { if (opts && String(opts.method || "GET").toUpperCase() === "POST" && String(url).includes("/api/visitor-log/sites")) window.__sitePosts++; return orig.apply(this, arguments); }; });
  await wide.click('[data-testid="site-form-save"]');
  await H.wait(200);
  assert.equal(await wide.evaluate(() => window.__sitePosts), 0, "invalid ABN must not be posted");
  await wide.type('[data-testid="site-form-abn"]', "x");
  assert.equal(await wide.$eval('[data-testid="site-field-error-abn"]', (el) => el.hidden || !el.textContent), true, "editing the ABN clears the error");
  assert.equal(await wide.$eval('[data-testid="site-form-abn"]', (el) => el.getAttribute("aria-invalid")), null);
  await wide.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
  await wide.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });

  await wide.click('[data-testid="site-add-open"]');
  await wide.waitForSelector('[data-testid="site-add-form"]');
  await wide.type('[data-testid="site-form-name"]', "Synthetic Preview Add");
  await fillAbn(wide, "99702180390");
  await wide.click('[data-testid="site-form-save"]');
  await wide.waitForSelector('[data-testid="site-field-error-abn"]:not([hidden])', { timeout: 8000 });
  assert.match(await wide.$eval('[data-testid="site-field-error-abn"]', (el) => el.textContent), ABN_MSG);
  await wide.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
  await wide.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });

  const companyVal = await wide.$eval('[data-testid="company-abn"]', (el) => el.value);
  await wide.$eval('[data-testid="company-abn"]', (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await wide.type('[data-testid="company-abn"]', "99702180390");
  await wide.click('[data-act="company-save"]');
  await wide.waitForSelector('[data-testid="company-field-error-abn"]:not([hidden])', { timeout: 8000 });
  assert.match(await wide.$eval('[data-testid="company-field-error-abn"]', (el) => el.textContent), ABN_MSG);
  assert.equal(await wide.$eval('[data-testid="company-abn"]', (el) => el.getAttribute("aria-invalid")), "true");
  await wide.$eval('[data-testid="company-abn"]', (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, companyVal);
  await wide.close();

  const short = await H.openPage(browser, owner, "visitors/sites", { w: 1280, h: 700, theme: "crazy", log: false });
  await short.waitForSelector('[data-testid="sites-table"]', { timeout: 8000 });
  await openEdit(short);
  await fillAbn(short, "99702180390");
  await short.click('[data-testid="site-form-save"]');
  await short.waitForSelector('[data-testid="site-field-error-abn"]:not([hidden])', { timeout: 8000 });
  await H.wait(400);
  const shortLayout = await errorLayout(short);
  assert.match(shortLayout.text, ABN_MSG);
  assert.equal(shortLayout.insideCard, true, "on a short viewport the ABN error stays inside the dialog");
  assert.equal(shortLayout.underField, true);
  await short.screenshot({ path: path.join(shotDir, "edit-abn-error-1280x700.png"), fullPage: false });
  const shortCard = await short.$(".modal-card");
  await shortCard.screenshot({ path: path.join(shotDir, "edit-abn-error-1280x700-dialog.png") });
  await short.close();

  const server = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 900, theme: "crazy", log: false });
  await server.waitForSelector('[data-testid="sites-table"]', { timeout: 8000 });
  await openEdit(server);
  await server.evaluate(() => {
    const orig = window.fetch.bind(window);
    window.fetch = async (url, opts = {}) => {
      if (String(opts.method || "GET").toUpperCase() === "POST" && String(url).includes("/api/visitor-log/sites/")) {
        return new Response(JSON.stringify({
          error: "That ABN is not valid. It needs 11 digits that pass the ABN check.",
          fields: { abn: "That ABN is not valid. It needs 11 digits that pass the ABN check." },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return orig(url, opts);
    };
  });
  await fillAbn(server, "1111");
  await server.click('[data-testid="site-form-save"]');
  await server.waitForSelector('[data-testid="site-field-error-abn"]:not([hidden])', { timeout: 8000 });
  const fromServer = await errorLayout(server);
  assert.match(fromServer.text, ABN_MSG);
  assert.equal(fromServer.insideCard, true, "a 400 from the server still shows under the ABN field");
  assert.equal(fromServer.aria, "true");
  assert.equal(fromServer.focused, true);
  assert.equal(await server.$eval('[data-testid="site-form-abn"]', (el) => el.value), "1111", "the 1111 placeholder is still accepted by the client check");
  await server.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
  await server.close();
});

test("operating model tags, filter and edit selector; screenshots at 1440", { skip: SKIP, timeout: 90000 }, async () => {
  await boot();
  const ballarat = await lib.sitesStore().get("s00000b04", { type: "json" });
  const mernda = await lib.sitesStore().get("s00000b05", { type: "json" });
  assert.ok(ballarat && mernda, "boot sites are present");
  await lib.sitesStore().setJSON("s00000b04", { ...ballarat, operatingModel: "viva" });
  await lib.sitesStore().setJSON("s00000b05", { ...mernda, operatingModel: "loc_ca" });
  const shotDir = "/workspace/qr-codes-data/operating-model-screenshots";
  fs.mkdirSync(shotDir, { recursive: true });
  const p = await H.openPage(browser, owner, "visitors/sites", { w: 1440, h: 900, theme: "crazy", log: false });
  await p.waitForSelector('[data-testid="sites-table"]', { timeout: 8000 });
  assert.ok(await p.$('[data-testid="site-mgr-model"]'), "the table can be filtered by operating model");
  assert.ok(await p.$('[data-testid="op-tag-viva"]'), "VIVA tag is in the table");
  assert.ok(await p.$('[data-testid="op-tag-loc-ca"]'), "LOC CA tag is in the table");
  const vivaText = await p.$eval('[data-testid="op-tag-viva"]', (el) => el.textContent.trim());
  const caText = await p.$eval('[data-testid="op-tag-loc-ca"]', (el) => el.textContent.trim());
  assert.equal(vivaText, "VIVA");
  assert.equal(caText, "LOC CA");
  await p.select("#site-mgr-model", "viva");
  let names = await p.$$eval('[data-testid="site-row"] td:first-child', (els) => els.map((e) => e.textContent));
  assert.ok(names.includes("Synthetic Unattended Ballarat"));
  assert.ok(!names.includes("Synthetic Unattended Mernda"), "LOC CA sites are hidden by the VIVA filter");
  await p.select("#site-mgr-model", "loc_ca");
  names = await p.$$eval('[data-testid="site-row"] td:first-child', (els) => els.map((e) => e.textContent));
  assert.ok(names.includes("Synthetic Unattended Mernda"));
  assert.ok(!names.includes("Synthetic Unattended Ballarat"));
  await p.select("#site-mgr-model", "none");
  names = await p.$$eval('[data-testid="site-row"] td:first-child', (els) => els.map((e) => e.textContent));
  assert.ok(!names.includes("Synthetic Unattended Ballarat"));
  assert.ok(!names.includes("Synthetic Unattended Mernda"));
  await p.select("#site-mgr-model", "all");
  await p.select("#site-mgr-type", "unattended");
  await p.$eval("#sites-manager", (e) => e.scrollIntoView({ block: "start" }));
  await H.wait(250);
  const tagged = await p.$eval('[data-testid="sites-table"]', (el) => !!el.querySelector("[data-testid=op-tag-viva]") && !!el.querySelector("[data-testid=op-tag-loc-ca]"));
  assert.equal(tagged, true, "both tags should be visible in the Unattended table view");
  await p.screenshot({ path: path.join(shotDir, "sites-table-tags-1440.png"), fullPage: false });
  await p.select("#site-mgr-type", "all");
  await p.evaluate(() => {
    const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Ballarat"));
    row?.querySelector('[data-testid="site-edit"]')?.click();
  });
  await p.waitForSelector('[data-testid="site-edit-form"]', { timeout: 8000 });
  assert.equal(await p.$eval('[data-testid="site-form-operating-model"]', (el) => el.value), "viva");
  assert.ok(await p.$('[data-testid="site-form-op-preview"] [data-testid="op-tag-viva"]'));
  await p.select('[data-testid="site-form-operating-model"]', "loc_ca");
  await H.wait(100);
  assert.ok(await p.$('[data-testid="site-form-op-preview"] [data-testid="op-tag-loc-ca"]'), "the edit preview follows the selector");
  const card = await p.$(".modal-card");
  await card.screenshot({ path: path.join(shotDir, "edit-operating-model-1440.png") });
  await p.$eval('.modal-card [data-act="close-modal"]', (el) => el.click());
  await p.waitForFunction(() => document.getElementById("modal").classList.contains("hidden"), { timeout: 8000 });
  const geelongId = await p.evaluate(() => {
    const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Geelong West"));
    return row?.getAttribute("data-id") || "";
  });
  assert.ok(geelongId);
  await p.select('#op-model-' + geelongId, "viva");
  await p.waitForFunction(() => {
    const row = [...document.querySelectorAll("[data-testid=site-row]")].find((r) => r.textContent.includes("Synthetic Unattended Geelong West"));
    return !!row?.querySelector('[data-testid="op-tag-viva"]');
  }, { timeout: 8000 });
  assert.equal((await lib.sitesStore().get(geelongId, { type: "json" })).operatingModel, "viva");
  await p.close();
});
