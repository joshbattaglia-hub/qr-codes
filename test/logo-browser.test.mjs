import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

/** Real-browser check of the logo (skipped when no Chrome is installed): the sidebar shows the right variant on each theme, images really load, sign-in shows the lockup. */
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.ADMIN_PASSWORD = "test-pass-synthetic";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] } });
delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;

test("logo in a real browser: sidebar variant per theme, sign-in and set-password lockups, favicon links resolve", { skip: !CHROME, timeout: 90000 }, async () => {
  const lib = await import("../netlify/lib/lib.mjs");
  lib.setStoreFactory(lib.memoryBackend());
  const otp = await import("../netlify/lib/otp.mjs");
  const wh = await import("../netlify/lib/warehouse.mjs");
  const OWNER = await otp.actorForEmail(JOSHUA);
  const puppeteer = createRequire(new URL("../package.json", import.meta.url))("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const MIME = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", css: "text/css", js: "text/javascript", mjs: "text/javascript", woff2: "font/woff2", html: "text/html" };
  try {
    async function open(path, { signedIn = true, theme, clear = false, w = 1280, h = 800 } = {}) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h });
      if (clear) await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
      if (theme) await page.evaluateOnNewDocument((t, key) => { try { localStorage.setItem("eh-theme:last", key); localStorage.setItem("eh-theme:u:" + key, t); } catch {} }, theme, JOSHUA);
      await page.setRequestInterception(true);
      page.on("request", async (r) => {
        const u = new URL(r.url());
        const send = (status, body) => r.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (u.pathname === "/api/auth") return send(200, { authenticated: false });
        if (u.pathname === "/api/identity/session") return signedIn ? send(200, { authenticated: true, role: OWNER.role, identity: OWNER, otp: true }) : send(200, { authenticated: false });
        if (u.pathname === "/api/identity/otp/status") return send(200, { configured: true, operational: true, mock: false, setup: "" });
        if (u.pathname === "/api/identity/entra/status") return send(200, { configured: false });
        if (u.pathname === "/api/warehouse") { const x = await wh.warehouseOverview(OWNER); return send(x.status, x.body || { error: x.error }); }
        if (u.pathname === "/api/tickets/access") return send(200, { role: "admin", queues: [] });
        if (u.pathname === "/api/sites" || u.pathname === "/api/pos-drafts" || u.pathname === "/api/pages" || u.pathname === "/api/codes" || u.pathname === "/api/competitions" || u.pathname === "/api/templates") return send(200, []);
        if (u.pathname === "/api/settings") return send(200, { workspaceName: "Liberty", defaultFg: "#111827", defaultBg: "#ffffff", publicUrl: "https://expresshelp.site" });
        if (u.pathname.startsWith("/api/")) return send(403, { error: "Forbidden" });
        const file = u.pathname === "/admin/" ? "public/admin/index.html" : u.pathname === "/set-password" ? "public/set-password.html" : "public" + u.pathname;
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.respond({ contentType: MIME[file.split(".").pop()] || "application/octet-stream", body: fs.readFileSync(file) });
        r.respond({ status: 404, body: "" });
      });
      await page.goto("https://expresshelp.site" + path);
      await wait(700);
      return page;
    }
    const logos = (p) => p.$$eval(".brand-logo", (els) => els.map((e) => ({ kind: e.classList.contains("on-dark") ? "dark" : "light", shown: e.checkVisibility(), loaded: e.complete && e.naturalWidth > 0, src: e.getAttribute("src"), h: e.getBoundingClientRect().height })));
    const expect = { light: "light", dark: "dark", crazy: "light" };
    for (const theme of ["light", "dark", "crazy"]) {
      const p = await open("/admin/#/warehouse", { theme });
      await p.waitForSelector("#shell:not(.hidden)");
      assert.equal(await p.evaluate(() => document.documentElement.getAttribute("data-theme")), theme);
      const rows = await logos(p);
      const shown = rows.filter((r) => r.shown);
      assert.equal(shown.length, 1, theme + ": exactly one sidebar logo is drawn");
      assert.equal(shown[0].kind, expect[theme], theme + ": variant");
      assert.equal(shown[0].loaded, true, theme + ": the image really loaded");
      assert.ok(shown[0].h >= 30, theme + ": drawn at a readable size");
      // the surface behind it: dark theme sidebar is dark, light and crazy are light
      const bg = await p.$eval("#sidebar", (e) => { let el = e; while (el) { const c = getComputedStyle(el).backgroundColor; if (c !== "rgba(0, 0, 0, 0)") return c; el = el.parentElement; } return "rgb(255,255,255)"; });
      const lum = bg.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
      if (theme === "dark") assert.ok(lum < 60, "dark sidebar surface"); else assert.ok(lum > 200, theme + " sidebar surface is light, so the navy lockup is readable");
      assert.equal(await p.$eval("#brand-name", (e) => e.textContent), "Express Help", "accessible name kept");
      await p.close();
    }
    // sign-in (signed out): follows the last account's theme (Crazy when nothing saved); the lockup above the form is readable on each surface
    for (const [theme, kind] of [["dark", "dark"], ["light", "light"], [undefined, "light"]]) {
      const s = await open("/admin/", { signedIn: false, theme, clear: !theme });
      await s.waitForSelector("#login:not(.hidden)");
      const sl = await s.$$eval(".signin-logo", (els) => els.filter((e) => e.checkVisibility()).map((e) => ({ kind: e.classList.contains("on-dark") ? "dark" : "light", loaded: e.complete && e.naturalWidth > 0, above: e.getBoundingClientRect().bottom <= document.querySelector("#otp-card").getBoundingClientRect().top })));
      assert.deepEqual(sl, [{ kind, loaded: true, above: true }], (theme || "default") + ": one sign-in lockup, loaded, above the form");
      assert.equal(await s.evaluate(() => document.documentElement.getAttribute("data-theme")), theme || "crazy");
      // the drawn surface behind the lockup: light card in Crazy, dark page in Dark, light page in Light
      const lum = await s.$eval(".signin-logo:not([hidden])", (e) => { const box = e.closest(".signin-brand"); let el = box; while (el) { const c = getComputedStyle(el).backgroundColor; if (c !== "rgba(0, 0, 0, 0)") return c; el = el.parentElement; } return "rgb(255,255,255)"; });
      const v = lum.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
      if (theme === "dark") assert.ok(v < 60, "dark sign-in surface"); else assert.ok(v > 200, (theme || "crazy") + " sign-in lockup sits on a light surface");
      await s.close();
    }
    const sp = await open("/set-password", { signedIn: false });
    const spl = await sp.$eval('[data-testid="signin-logo"]', (e) => ({ shown: e.checkVisibility(), loaded: e.complete && e.naturalWidth > 0 }));
    assert.deepEqual(spl, { shown: true, loaded: true });
    // every favicon link in the admin head resolves to a real file
    const hrefs = await sp.$$eval('link[rel~="icon"],link[rel="apple-touch-icon"]', (els) => els.map((e) => e.getAttribute("href")));
    assert.ok(hrefs.length >= 5);
    for (const h of hrefs) assert.ok(fs.existsSync("public" + h), h + " exists");
    await sp.close();
  } finally { await browser.close(); }
});
