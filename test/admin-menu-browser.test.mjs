import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

/** Real-browser check of the sidebar (skipped when no Chrome is installed). This is the regression for "limited users still saw every tool". */
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.ADMIN_PASSWORD = "test-pass-synthetic";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] } });
delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;

test("sidebar in a real browser: limited user sees only granted tools; the rest sit in a collapsed Other tools; owner sees everything", { skip: !CHROME }, async () => {
  const lib = await import("../netlify/lib/lib.mjs");
  lib.setStoreFactory(lib.memoryBackend());
  const mail = await import("../netlify/lib/mail.mjs");
  const sent = [];
  mail.setMailTransport(async (m) => { sent.push(m); return { status: "sent", id: "mock" }; });
  const users = await import("../netlify/lib/users.mjs");
  const otp = await import("../netlify/lib/otp.mjs");
  const ar = await import("../netlify/lib/access-request.mjs");
  const OWNER = await otp.actorForEmail(JOSHUA);
  await users.saveUser(OWNER, { mode: "add", email: "josh.synthetic@libertyretail.com.au", warehouse: true, visitor: "none", tickets: [], assets: "none" });
  sent.length = 0;
  const LIMITED = await otp.actorForEmail("josh.synthetic@libertyretail.com.au");
  const puppeteer = createRequire(new URL("../package.json", import.meta.url))("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    async function open(actor, hash, w = 1280, h = 800) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h });
      await page.setRequestInterception(true);
      page.on("request", async (r) => {
        const u = new URL(r.url());
        const send = (status, body) => r.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (u.pathname === "/api/auth") return send(200, { authenticated: false });
        if (u.pathname === "/api/identity/session") return send(200, { authenticated: true, role: actor.role, identity: actor, otp: true });
        if (u.pathname === "/api/users" && actor.owner) { const x = await users.listUsers(actor); return send(x.status, x.body || { error: x.error }); }
        if (u.pathname === "/api/access-request" && r.method() === "POST") { const x = await ar.submitRequest(actor, JSON.parse(r.postData() || "{}")); return send(x.status, x.body || { error: x.error }); }
        if (u.pathname === "/api/access-request") { const x = await ar.requestStatus(actor, u.searchParams.get("tool")); return send(x.status, x.body || { error: x.error }); }
        if (u.pathname === "/api/tickets/access") return send(actor.owner ? 200 : 403, { role: "admin", queues: ["screens", "signage"] });
        if (u.pathname === "/api/sites" || u.pathname === "/api/pos-drafts" || u.pathname === "/api/pages") return send(200, []);
        if (u.pathname === "/api/warehouse") return send(403, { error: "no" });
        if (u.pathname.startsWith("/api/")) return send(403, { error: "Forbidden" });
        const file = u.pathname === "/admin/" ? "public/admin/index.html" : "public" + u.pathname;
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.respond({ contentType: file.endsWith(".css") ? "text/css" : /\.m?js$/.test(file) ? "text/javascript" : "text/html", body: fs.readFileSync(file) });
        r.respond({ status: 404, body: "" });
      });
      await page.goto("https://expresshelp.site/admin/" + hash);
      await page.waitForSelector("#shell:not(.hidden)", { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 400));
      return page;
    }
    const visibleNav = (page) => page.$$eval("#nav [data-go]", (els) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.dataset.go));
    const shown = (page, sel) => page.$eval(sel, (e) => e.checkVisibility());

    const p = await open(LIMITED, "#/warehouse");
    assert.deepEqual(await visibleNav(p), ["warehouse"], "only the granted tool is visible in the menu");
    assert.equal(await shown(p, ".create-wrap"), false, "Create new is hidden");
    assert.equal(await shown(p, "#other-tools"), true);
    assert.equal(await p.$eval("#other-tools", (d) => d.open), false, "collapsed by default");
    assert.equal((await p.$$eval("#other-tools-list [data-go]", (els) => els.map((e) => e.dataset.go))).length, 14);
    assert.equal(await shown(p, "#other-tools-list"), false, "list hidden while collapsed");
    await p.click("#other-tools summary");
    assert.equal(await shown(p, "#other-tools-list"), true);
    await p.click('#other-tools-list [data-go="visitors"]');
    await p.waitForSelector('[data-testid="request-page"]');
    assert.match(await p.$eval('[data-testid="request-title"]', (e) => e.textContent), /You don't have access to Visitor Log/);
    await p.type("#request-reason", "<b>cover</b> shift");
    const btn = await p.$('[data-act="request-access"]');
    await btn.click();
    await p.waitForSelector("#request-sent:not(.hidden)", { timeout: 5000 });
    assert.match(await p.$eval("#request-sent", (e) => e.textContent), /Request sent/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, JOSHUA);
    // refresh: the sent state persists for the cooldown
    await p.reload(); await p.waitForSelector("#request-sent:not(.hidden)", { timeout: 5000 });
    // a typed-in head-office route shows the request page, not the tool
    await p.evaluate(() => { location.hash = "#/settings"; });
    await p.waitForSelector('[data-testid="request-page"][data-tool="settings"]');
    await p.close();

    const o = await open(OWNER, "#/home");
    const nav = await visibleNav(o);
    for (const tool of ["home", "links", "qrcodes", "pages", "analytics", "competitions", "pos", "assets", "warehouse", "visitors", "tickets", "users", "sites", "domains", "settings"]) assert.ok(nav.includes(tool), "owner sees " + tool);
    assert.equal(await shown(o, ".create-wrap"), true);
    assert.equal(await shown(o, "#other-tools"), false);
    await o.close();

    // deep link from the request email opens that person's edit form
    const d = await open(OWNER, "#/users?edit=" + encodeURIComponent("josh.synthetic@libertyretail.com.au"));
    await d.waitForSelector("#perm-warehouse", { timeout: 8000 });
    assert.equal(await d.$eval("#perm-warehouse", (e) => e.checked), true);
    await new Promise((r) => setTimeout(r, 300)); assert.equal(await d.evaluate(() => location.hash), "#/users", "the query is consumed so Cancel does not reopen it");
    await d.close();
  } finally { await browser.close(); }
});
