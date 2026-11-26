import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Synthetic admin screenshots of visitor scan analytics. Mail mocked, in-memory store, no live visits. */
const SKIP = !["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].some((p) => fs.existsSync(p));
let H, lib, scans, owner, head, browser;
const SHOT = "/workspace/qr-codes-data/visitor-scans-screenshots";
const FIXED = new Date("2026-11-26T02:00:00.000Z");

async function boot() {
  if (H) return;
  H = await import("./support/browser-harness.mjs");
  lib = await import("../netlify/lib/lib.mjs");
  scans = await import("../netlify/lib/visit-scans.mjs");
  scans.setVisitScanNow(() => FIXED);
  owner = await H.otpCookie(H.JOSHUA);
  head = H.head;
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  const geo = { country: { code: "AU", name: "Australia" }, city: "Melbourne", subdivision: { code: "VIC" } };
  for (let i = 0; i < 10; i++) {
    const res = await H.call("POST", "/api/visit/scan-hit", { body: JSON.stringify({ kind: "sign-in", geo, referrer: "" }) });
    assert.equal(res.status, 204, "sign-in scan seed");
  }
  for (let i = 0; i < 8; i++) {
    const res = await H.call("POST", "/api/visit/scan-hit", { body: JSON.stringify({ kind: "sign-out", geo, referrer: "" }) });
    assert.equal(res.status, 204, "sign-out scan seed");
  }
  // H.call does not pass UA; counts still exist. Patch device labels by replaying through record is unnecessary for the screenshot.
  async function visit(suffix, signedInAt, signedOutAt) {
    const id = "v" + suffix.repeat(32).slice(0, 32);
    await lib.visitorStore().setJSON("visit/" + id, {
      id,
      location: "Synthetic Mernda",
      name: "Alex Example",
      phone: "0411000001",
      company: "Example Co",
      signedInAt,
      signedOutAt: signedOutAt || null,
      photoStatus: "none",
    });
  }
  await visit("a", "2026-11-26T00:30:00.000Z", "2026-11-26T03:00:00.000Z");
  await visit("b", "2026-11-26T01:00:00.000Z", "2026-11-26T04:00:00.000Z");
  await visit("c", "2026-11-26T01:15:00.000Z", null);
  fs.mkdirSync(SHOT, { recursive: true });
  browser = await H.launch();
}
after(async () => { if (browser) await browser.close(); });

test("QR dashboard lists Visitor sign-in and Visitor sign-out with scan totals; screenshot", { skip: SKIP, timeout: 90000 }, async () => {
  await boot();
  const page = await H.openPage(browser, head, "qrcodes", { w: 1440, h: 900, theme: "crazy", log: false });
  await page.waitForSelector("table", { timeout: 8000 });
  const text = await page.$eval("table", (el) => el.innerText);
  assert.ok(text.includes("Visitor sign-in"), text);
  assert.ok(text.includes("Visitor sign-out"), text);
  assert.ok(text.includes("/visit/sign-in"), text);
  assert.ok(text.includes("/visit/sign-out"), text);
  assert.ok(!text.includes("/r/visitor-sign-in"), text);
  const pageText = await page.evaluate(() => document.body.innerText);
  assert.match(pageText, /10/);
  assert.match(pageText, /8/);
  await page.screenshot({ path: path.join(SHOT, "dashboard-entries-1440.png"), fullPage: false });
  await page.click("tr.clickable");
  await page.waitForSelector('[data-testid="visit-scan-locked"]', { timeout: 8000 });
  const note = await page.$eval('[data-testid="visit-scan-locked"]', (el) => el.textContent);
  assert.match(note, /cannot be deleted/i);
  assert.ok(!await page.$('[data-act="del"]'));
  await page.screenshot({ path: path.join(SHOT, "dashboard-sign-in-detail-1440.png"), fullPage: false });
  await page.close();
});

test("visitor log shows scans next to completed sign-ins and the page-open note; screenshot", { skip: SKIP, timeout: 90000 }, async () => {
  await boot();
  const page = await H.openPage(browser, owner, "visitors", { w: 1440, h: 900, theme: "crazy", log: false });
  await page.waitForSelector('[data-testid="visitor-scan-stats"]', { timeout: 8000 });
  const signIn = await page.$eval('[data-testid="visitor-scan-sign-in"]', (el) => el.innerText);
  const signOut = await page.$eval('[data-testid="visitor-scan-sign-out"]', (el) => el.innerText);
  assert.match(signIn, /Visitor sign-in/);
  assert.match(signIn, /10/);
  assert.match(signIn, /3/);
  assert.match(signIn, /30% completed/);
  assert.match(signOut, /Visitor sign-out/);
  assert.match(signOut, /8/);
  assert.match(signOut, /2/);
  assert.match(signOut, /25% completed/);
  const note = await page.$eval('[data-testid="visitor-scan-note"]', (el) => el.textContent);
  assert.match(note, /page opens, which can include refreshes/);
  await page.screenshot({ path: path.join(SHOT, "visitor-log-scans-1440.png"), fullPage: false });
  await page.click('[data-period="7"]');
  await page.waitForFunction(() => document.querySelector('[data-period="7"]')?.getAttribute("aria-pressed") === "true", { timeout: 8000 });
  await page.screenshot({ path: path.join(SHOT, "visitor-log-scans-7days-1440.png"), fullPage: false });
  await page.close();
});
