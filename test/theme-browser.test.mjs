import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

/** Real-browser theme checks (skipped when no Chrome is installed): toggle, keyboard, persistence, drawn contrast, reduced motion and print. Synthetic data only. */
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.ADMIN_PASSWORD = "test-pass-synthetic";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] } });
delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;

/** Runs inside the page: every visible piece of text, its colour against the colour actually drawn behind it. Returns the failures. */
function drawnContrast() {
  const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (t, u) => { const a = t[3]; return [t[0] * a + u[0] * (1 - a), t[1] * a + u[1] * (1 - a), t[2] * a + u[2] * (1 - a), 1]; };
  const out = [], seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    if (el.closest("svg") || el.closest(":disabled") || el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    let text = ""; for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
    text = text.trim(); if (!text) continue;
    const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
    let base = [255, 255, 255, 1], opacity = 1;
    for (let i = chain.length - 1; i >= 0; i--) { const cs = getComputedStyle(chain[i]); const bg = parse(cs.backgroundColor); if (bg && bg[3] > 0) base = over(bg, base); }
    for (const e of chain) opacity *= Number(getComputedStyle(e).opacity);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); let color = over(fg, base); if (opacity < 1) color = over([color[0], color[1], color[2], opacity], base);
    const size = parseFloat(cs.fontSize), large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
    const r = ratio(color, base);
    if (r < (large ? 3 : 4.5)) { const key = el.tagName + text.slice(0, 20); if (!seen.has(key)) { seen.add(key); out.push(el.tagName.toLowerCase() + "." + String(el.className) + " “" + text.slice(0, 30) + "” " + r.toFixed(2)); } }
  }
  return out;
}

test("themes in a real browser: toggle, keyboard, per-account memory, early apply, drawn contrast, reduced motion, print", { skip: !CHROME, timeout: 120000 }, async () => {
  const lib = await import("../netlify/lib/lib.mjs");
  lib.setStoreFactory(lib.memoryBackend());
  const mail = await import("../netlify/lib/mail.mjs");
  mail.setMailTransport(async () => { throw new Error("mail must not be used in the theme test"); });
  const users = await import("../netlify/lib/users.mjs");
  const otp = await import("../netlify/lib/otp.mjs");
  const wh = await import("../netlify/lib/warehouse.mjs");
  const { sheetHtml } = await import("../public/admin/warehouse-ui.mjs");
  const OWNER = await otp.actorForEmail(JOSHUA);
  await users.saveUser(OWNER, { mode: "add", email: "pat.synthetic@libertyretail.com.au", warehouse: true, visitor: "none", tickets: [], assets: "none" });
  const PAT = await otp.actorForEmail("pat.synthetic@libertyretail.com.au");
  const puppeteer = createRequire(new URL("../package.json", import.meta.url))("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    async function open(actor, hash = "#/warehouse", { w = 1280, h = 800, early } = {}) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h });
      if (early) await page.evaluateOnNewDocument(early);
      await page.setRequestInterception(true);
      page.on("request", async (r) => {
        const u = new URL(r.url());
        const send = (status, body) => r.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
        const via = (x) => send(x.status, x.body || { error: x.error });
        if (u.pathname === "/api/auth") return send(200, { authenticated: false });
        if (u.pathname === "/api/identity/session") return send(200, { authenticated: true, role: actor.role, identity: actor, otp: true });
        if (u.pathname === "/api/warehouse") return via(await wh.warehouseOverview(actor));
        if (u.pathname === "/api/warehouse/sheets" && r.method() === "POST") return via(await wh.issueSheet(actor, JSON.parse(r.postData() || "{}")));
        if (u.pathname === "/api/tickets/access") return send(403, { role: "none" });
        if (u.pathname === "/api/sites" || u.pathname === "/api/pos-drafts" || u.pathname === "/api/pages" || u.pathname === "/api/codes" || u.pathname === "/api/competitions" || u.pathname === "/api/templates") return send(200, []);
        if (u.pathname === "/api/settings") return send(200, { workspaceName: "Liberty", defaultFg: "#111827", defaultBg: "#ffffff", publicUrl: "https://expresshelp.site" });
        if (u.pathname.startsWith("/api/")) return send(403, { error: "Forbidden" });
        const file = u.pathname === "/admin/" ? "public/admin/index.html" : "public" + u.pathname;
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.respond({ contentType: file.endsWith(".css") ? "text/css" : /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".woff2") ? "font/woff2" : "text/html", body: fs.readFileSync(file) });
        r.respond({ status: 404, body: "" });
      });
      await page.goto("https://expresshelp.site/admin/" + hash);
      await page.waitForSelector("#shell:not(.hidden)", { timeout: 8000 });
      await wait(400);
      return page;
    }
    const themeOf = (p) => p.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const bgOf = (p, sel) => p.$eval(sel, (e) => getComputedStyle(e).backgroundColor);
    const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);

    // ---- Crazy is the default when nothing is saved (and nothing is written by merely loading)
    const q = await open(OWNER);
    assert.equal(await themeOf(q), "crazy", "nothing saved: Crazy");
    assert.equal(await q.$eval("#theme-btn", (b) => b.getAttribute("aria-label")), "Theme: Crazy");
    assert.equal(await q.evaluate((k) => localStorage.getItem(k), "eh-theme:u:" + JOSHUA), null, "the default is not saved");
    await q.click("#theme-btn");
    assert.deepEqual(await q.$$eval("#pop-theme [role=menuitemradio]", (els) => els.map((e) => e.dataset.themeChoice + ":" + e.getAttribute("aria-checked"))), ["light:false", "dark:false", "crazy:true"], "Crazy shows the current tick");
    assert.equal(await q.evaluate(() => getComputedStyle(document.querySelector('[data-theme-choice="crazy"] .theme-tick')).visibility), "visible");
    // explicitly choosing Light is saved and survives a reload (the new default never overrides it)
    await q.click('[data-theme-choice="light"]');
    assert.equal(await themeOf(q), "light");
    assert.equal(await q.evaluate((k) => localStorage.getItem(k), "eh-theme:u:" + JOSHUA), "light");
    await q.reload(); await q.waitForSelector("#shell:not(.hidden)", { timeout: 8000 }); await wait(300);
    assert.equal(await themeOf(q), "light", "saved Light stays Light after reload");
    await q.close();

    // ---- a saved Light looks like Light always did
    const p = await open(OWNER);
    assert.equal(await themeOf(p), "light");
    assert.deepEqual(rgb(await bgOf(p, "body")), [243, 244, 248]);
    assert.equal(await p.$eval("#theme-btn", (b) => b.getAttribute("aria-label")), "Theme: Light");
    // the toggle is in the top bar, directly before the profile image
    assert.equal(await p.$eval("#theme-btn", (b) => b.nextElementSibling.classList.contains("avatar") && b.closest(".top-actions") !== null), true);
    assert.equal(await p.$eval("#theme-btn", (b) => b.checkVisibility()), true);

    // ---- keyboard: Enter opens, arrows move, Enter chooses, Escape closes and gives focus back
    await p.focus("#theme-btn");
    await p.keyboard.press("Enter");
    assert.equal(await p.$eval("#theme-btn", (b) => b.getAttribute("aria-expanded")), "true");
    assert.equal(await p.$eval("#pop-theme", (e) => e.checkVisibility()), true);
    assert.equal(await p.evaluate(() => document.activeElement.dataset.themeChoice), "light", "focus lands on the current choice");
    await p.keyboard.press("Escape");
    assert.equal(await p.evaluate(() => document.activeElement.id), "theme-btn");
    assert.equal(await p.$eval("#pop-theme", (e) => e.checkVisibility()), false);
    await p.keyboard.press("Enter");
    await p.keyboard.press("ArrowDown");
    assert.equal(await p.evaluate(() => document.activeElement.dataset.themeChoice), "dark");
    await p.keyboard.press("Enter");
    assert.equal(await themeOf(p), "dark");
    assert.equal(await p.$eval("#theme-btn", (b) => b.getAttribute("aria-label")), "Theme: Dark");
    assert.equal(await p.$eval("#theme-btn", (b) => b.getAttribute("aria-expanded")), "false");
    assert.equal(await p.evaluate(() => document.activeElement.id), "theme-btn");
    await p.click("#theme-btn");
    assert.deepEqual(await p.$$eval("#pop-theme [role=menuitemradio]", (els) => els.map((e) => e.dataset.themeChoice + ":" + e.getAttribute("aria-checked"))), ["light:false", "dark:true", "crazy:false"]);
    await p.keyboard.press("Escape");
    assert.equal(await p.evaluate((k) => localStorage.getItem(k), "eh-theme:u:" + JOSHUA), "dark", "saved for this account");
    assert.equal(await p.evaluate(() => localStorage.getItem("eh-theme:device")), null, "not as the device choice");

    // ---- what is actually drawn in Dark
    assert.ok(rgb(await bgOf(p, "body")).every((v) => v < 40), "page is drawn dark");
    assert.ok(rgb(await bgOf(p, ".card")).every((v) => v < 60), "cards are drawn dark");
    assert.deepEqual(await p.evaluate(drawnContrast), [], "no unreadable text on the Warehouse Stickers page in Dark");
    // QR/barcodes stay on white in Dark: generate a sheet and look at the label previews
    await p.click(".wh-go");
    await p.waitForSelector(".wh-mini-label", { timeout: 6000 });
    assert.deepEqual(rgb(await bgOf(p, ".wh-mini-label")), [255, 255, 255], "barcode previews stay on white");
    assert.deepEqual(await p.evaluate(drawnContrast), [], "preview readable in Dark");
    // focus ring is visible on a button in Dark
    await p.focus("#theme-btn"); await p.keyboard.press("Tab");
    const ring = await p.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { id: document.activeElement.className, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor }; });
    assert.ok(ring.style !== "none" && ring.width >= 2, "visible focus ring in Dark");

    // ---- print: Dark always prints light
    await p.emulateMediaType("print");
    assert.deepEqual(rgb(await bgOf(p, "body")), [255, 255, 255]);
    assert.deepEqual(rgb(await bgOf(p, ".card")), [255, 255, 255]);
    assert.ok(rgb(await p.$eval("h1", (e) => getComputedStyle(e).color)).every((v) => v < 90), "text prints dark on white");
    await p.emulateMediaType("screen");

    // ---- early apply on reload: the attribute is on <html> while the document is still loading, never light-then-dark
    await p.close();
    const early = () => { window.__themeLog = []; const orig = Element.prototype.setAttribute; Element.prototype.setAttribute = function (k, v) { if (k === "data-theme" && this === document.documentElement) window.__themeLog.push([v, document.readyState]); return orig.apply(this, arguments); }; };
    const again = await open(OWNER, "#/warehouse", { early });
    assert.equal(await themeOf(again), "dark", "remembered after reload");
    const log = await again.evaluate(() => window.__themeLog);
    assert.deepEqual(log[0], ["dark", "loading"], "applied synchronously during load, before first paint");
    assert.equal(log.some(([t]) => t === "light" || t === "crazy"), false, "no flash of Light or of the Crazy default before the saved Dark");

    // ---- another account on the same device does not inherit it
    const other = await open(PAT);
    assert.equal(await themeOf(other), "crazy", "a different account with nothing saved starts in the Crazy default");
    assert.equal(await other.$eval("#theme-btn", (b) => b.getAttribute("aria-label")), "Theme: Crazy");
    await other.close();
    const back = await open(OWNER);
    assert.equal(await themeOf(back), "dark", "the owner's choice is still there");

    // ---- Crazy: new palette every time, readable, respects reduced motion
    const palette = async () => back.evaluate(() => ["--c1", "--c2", "--c3", "--c4", "--c5"].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()).join(","));
    const pick = async () => { await back.click("#theme-btn"); await back.click('[data-theme-choice="crazy"]'); await wait(100); };
    const seen = new Set();
    for (let i = 0; i < 4; i++) { await pick(); assert.equal(await themeOf(back), "crazy"); seen.add(await palette()); }
    assert.ok(seen.size >= 3, "a different vivid palette each time Crazy is selected");
    for (let i = 0; i < 3; i++) {
      await pick();
      assert.deepEqual(await back.evaluate(drawnContrast), [], "no unreadable text in Crazy (palette " + i + ")");
    }
    assert.equal(await back.$eval(".wh-go", (b) => b.checkVisibility() && !b.disabled), true, "buttons stay usable");
    await back.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    assert.equal(await back.evaluate(() => getComputedStyle(document.body).animationName), "eh-crazy-bg", "gentle animation when motion is allowed");
    await back.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    assert.equal(await back.evaluate(() => getComputedStyle(document.body).animationName), "none", "static vivid palette under reduced motion");
    assert.notEqual(await back.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c1").trim()), "", "the vivid palette is still there");
    // footer is drawn readable on a solid chip
    const foot = await back.$eval("footer.eh-footer", (f) => { const cs = getComputedStyle(f); return { text: f.textContent, bg: cs.backgroundColor, visible: f.checkVisibility() }; });
    assert.equal(foot.text, "Cowabunga - please hesitate to reach out email me here");
    assert.equal(foot.visible, true);
    assert.ok(rgb(foot.bg).every((v) => v > 200), "footer sits on a solid light chip in Crazy");

    // ---- print: Crazy always prints light too
    await back.emulateMediaType("print");
    assert.deepEqual(rgb(await bgOf(back, "body")), [255, 255, 255]);
    assert.deepEqual(rgb(await bgOf(back, ".card")), [255, 255, 255]);
    assert.ok(rgb(await back.$eval("h1", (e) => getComputedStyle(e).color)).every((v) => v < 90));
    await back.emulateMediaType("screen");

    // ---- the sticker sheet itself (its own document) is white with black codes in print, whatever theme the admin is in
    const sheet = await browser.newPage();
    await sheet.setViewport({ width: 900, height: 1200 });
    await sheet.emulateMediaType("print");
    await sheet.setContent(sheetHtml(["WH1000", "WH1001", "WH1002"]));
    assert.deepEqual(rgb(await sheet.$eval("body", (e) => getComputedStyle(e).backgroundColor)), [255, 255, 255]);
    assert.ok(rgb(await sheet.$eval(".label", (e) => getComputedStyle(e).color)).every((v) => v < 60), "label text prints black");
    assert.equal(await sheet.$$eval(".label svg", (s) => s.length >= 3), true, "barcodes are present");
    await sheet.close();

    // ---- Light again is exactly the original
    await back.click("#theme-btn"); await back.click('[data-theme-choice="light"]'); await wait(100);
    assert.equal(await themeOf(back), "light");
    assert.deepEqual(rgb(await bgOf(back, "body")), [243, 244, 248]);
    assert.equal(await back.$eval("#eh-crazy-vars", (e) => e.textContent), "");
    await back.close();

    // ---- mobile: the toggle is reachable and the menu fits
    const phone = await open(OWNER, "#/warehouse", { w: 390, h: 800 });
    await phone.click("#theme-btn");
    const box = await phone.$eval("#pop-theme", (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vw: innerWidth }; });
    assert.ok(box.l >= 0 && box.r <= box.vw, "theme menu fits a phone screen");
    await phone.click('[data-theme-choice="dark"]');
    assert.equal(await themeOf(phone), "dark");
    assert.deepEqual(await phone.evaluate(drawnContrast), [], "readable on a phone in Dark");
    await phone.close();
  } finally { await browser.close(); }
});
