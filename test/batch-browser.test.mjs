import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

/** Real-browser checks for the Crazy-default / emoji sidebar / collapsible menu / wide layout / support board / email batch. Synthetic data only, real handlers, in-memory store, mail blocked. */
const require = createRequire(new URL("../package.json", import.meta.url));
const jpeg = require("jpeg-js");
const SKIP = !["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].some((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
const PAGES = ["home", "links", "qrcodes", "pages", "analytics", "competitions", "pos", "assets", "warehouse", "visitors", "tickets", "users", "sites", "domains", "settings"];
const OWNER_ONLY = new Set(["assets", "warehouse", "visitors", "tickets", "users"]);

let booted = null;
function boot() { return (booted ||= bootOnce()); }
async function bootOnce() {
  const H = await import("./support/browser-harness.mjs");
  const users = await import("../netlify/lib/users.mjs");
  const owner = await H.otpCookie(JOSHUA);
  const site = (await (await H.call("POST", "/api/sites", { cookie: H.head, body: { name: "North yard" } })).json()).id;
  await H.call("POST", "/api/codes", { cookie: H.head, body: { url: "https://example.com/spring", slug: "spring-sale", siteId: site, type: "qr", name: "Spring sale poster" } });
  const subjects = ["Register 3 screen flickers", "Pylon sign bulb out", "Menu board shows wrong price", "Forecourt screen blank", "Canopy sign letter missing", "Kiosk touch not responding", "Replace damaged poster frame", "Screen mount loose"];
  for (let i = 0; i < subjects.length; i++) {
    const q = i % 2 ? "signage" : "screens";
    const r = await (await H.call("POST", "/api/tickets", { cookie: owner, body: { queue: q, requestType: q === "screens" ? "Fault or repair" : "Damage or repair", priority: ["low", "normal", "high", "urgent"][i % 4], subject: subjects[i], description: "Synthetic description.", requesterEmail: "sam.synthetic@libertyretail.com.au", siteId: site } })).json();
    assert.ok(r.id || r.ticket || !r.error, r.error);
  }
  const rows = (await (await H.call("GET", "/api/tickets?queue=all", { cookie: owner })).json()).tickets;
  const cols = ["in-progress", "needs-info", "done", "in-progress", "needs-info", "done"];
  for (let i = 0; i < cols.length; i++) await H.call("POST", "/api/tickets/" + rows[i].id + "/move", { cookie: owner, body: { column: cols[i], reply: cols[i] === "needs-info" ? "Which register, please?" : "" } });
  await users.saveUser(H.OWNER, { mode: "add", email: "limited.synthetic@libertyretail.com.au", warehouse: true, visitor: "none", tickets: [], assets: "none" });
  const limited = await H.otpCookie("limited.synthetic@libertyretail.com.au");
  const owner2 = owner;
  return { H, owner: owner2, limited, rows };
}
const seedTheme = (theme) => `try{if(!localStorage.getItem("__seeded")){localStorage.setItem("__seeded","1");${theme ? `localStorage.setItem("eh-theme:last","${JOSHUA}");localStorage.setItem("eh-theme:u:${JOSHUA}","${theme}");localStorage.setItem("eh-theme:u:limited.synthetic@libertyretail.com.au","${theme}");` : ""}}}catch(e){}`;

test("sidebar emoji: one per tool in a fixed icon slot, aria-hidden, Other tools included, request page shows it; Crazy is the default", { skip: SKIP, timeout: 120000 }, async () => {
  const { TOOL_ICONS, OTHER_TOOLS_ICON } = await import("../public/admin/tool-icons.mjs");
  const html = fs.readFileSync("public/admin/index.html", "utf8");
  const nav = [...html.matchAll(/<button type="button" data-go="(\w+)"[^>]*><span class="nav-ico" aria-hidden="true">([^<]+)<\/span><span class="nav-label">([^<]+)<\/span><\/button>/g)];
  assert.deepEqual(nav.map((m) => m[1]), Object.keys(TOOL_ICONS), "every sidebar tool has an emoji, in menu order");
  for (const [, key, emoji] of nav) assert.equal(emoji, TOOL_ICONS[key], key);
  const wanted = { home: "🏠", links: "🔗", qrcodes: "📱", pages: "📄", analytics: "📊", competitions: "🏆", pos: "🧾", assets: "🏷️", warehouse: "📦", visitors: "🚪", tickets: "🎫", users: "👥", sites: "📍", domains: "🌐", settings: "⚙️" };
  assert.deepEqual(TOOL_ICONS, wanted);
  assert.equal(new Set(Object.values(TOOL_ICONS)).size, Object.keys(TOOL_ICONS).length, "no two tools share an emoji (Visitor log differs from POS setup)");
  assert.equal(/<nav class="nav" id="nav"[^]*?<\/nav>/.exec(html)[0].includes("<svg"), false, "the old line icons are gone from the menu");
  assert.match(html, /<summary[^>]*><span class="nav-ico" aria-hidden="true">🧰<\/span><span class="nav-label">Other tools<\/span><\/summary>/);
  assert.equal(OTHER_TOOLS_ICON, "🧰");

  const { H, owner, limited } = await boot();
  const browser = await H.launch();
  try {
    // nothing saved: Crazy; emoji drawn in a fixed-width slot for every tool, accessible names are the text labels
    const p = await H.openPage(browser, owner, "home", { w: 1280, h: 800, init: seedTheme(null) });
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "crazy", "Crazy is the default");
    const slots = await p.$$eval("#nav button", (bs) => bs.filter((b) => !b.hidden).map((b) => ({ key: b.dataset.go, w: Math.round(b.querySelector(".nav-ico").getBoundingClientRect().width), shown: b.querySelector(".nav-ico").checkVisibility(), hidden: b.querySelector(".nav-ico").getAttribute("aria-hidden"), label: b.querySelector(".nav-label").textContent.trim(), glyph: b.querySelector(".nav-ico").textContent })));
    assert.ok(slots.length >= 14);
    assert.equal(new Set(slots.map((s) => s.w)).size, 1, "every icon slot has the same width");
    for (const s of slots) { assert.equal(s.shown, true, s.key); assert.equal(s.hidden, "true"); assert.equal(s.glyph, TOOL_ICONS[s.key]); }
    const acc = await p.accessibility.snapshot({ interestingOnly: false });
    const names = []; (function walk(n) { if (n.role === "button" && n.name) names.push(n.name); (n.children || []).forEach(walk); })(acc);
    for (const label of ["Home", "Links", "QR Codes", "Warehouse Stickers", "Visitor log", "Support"]) assert.ok(names.includes(label), "accessible name is just the text: " + label);
    // the emoji really draws (not an empty box): the slot has ink in it
    const shot = await (await p.$("#nav button[data-go=home] .nav-ico")).screenshot({ type: "jpeg", quality: 90 });
    const img = jpeg.decode(shot, { useTArray: true });
    let colourful = 0; for (let i = 0; i < img.data.length; i += 4) { const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]]; if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colourful++; }
    assert.ok(colourful > 20, "the home emoji is drawn in colour");
    await p.close();
    // limited user: Other tools list carries emoji too, and the request-access page shows the tool's emoji
    for (const theme of ["light", "dark", "crazy"]) {
      const q = await H.openPage(browser, limited, "warehouse", { w: 1280, h: 800, init: seedTheme(theme) });
      await q.click("#other-tools summary"); await H.wait(200);
      const other = await q.$$eval("#other-tools-list button", (bs) => bs.map((b) => [b.dataset.go, b.querySelector(".nav-ico").textContent, b.querySelector(".nav-ico").checkVisibility()]));
      assert.ok(other.length >= 10, theme + ": other tools listed");
      for (const [key, glyph, shown] of other) { assert.equal(glyph, TOOL_ICONS[key], theme + " " + key); assert.equal(shown, true); }
      assert.equal(await q.evaluate(() => document.querySelector("#other-tools summary .nav-ico").textContent), "🧰");
      await q.evaluate(() => { location.hash = "#/pos"; }); await H.wait(500);
      assert.equal(await q.$eval('[data-testid="request-emoji"]', (e) => e.textContent + "|" + e.getAttribute("aria-hidden")), "🧾|true");
      assert.equal(await q.$eval('[data-testid="request-title"]', (e) => e.textContent), "You don't have access to POS setup");
      await q.close();
    }
    // mobile drawer draws them too
    const m = await H.openPage(browser, owner, "home", { w: 390, h: 800, init: seedTheme("crazy") });
    await m.click("#menu-btn"); await H.wait(300);
    assert.equal(await m.$$eval("#sidebar .nav-ico", (els) => els.filter((e) => e.checkVisibility()).length >= 14), true);
    await m.close();
  } finally { await browser.close(); }
});

test("hamburger: collapses to an emoji rail on desktop (remembered per account), opens and closes the drawer on mobile", { skip: SKIP, timeout: 120000 }, async () => {
  const { H, owner, limited } = await boot();
  const browser = await H.launch();
  const state = (p) => p.evaluate(() => ({ nav: document.documentElement.dataset.nav, exp: document.querySelector("#menu-btn").getAttribute("aria-expanded"), label: document.querySelector("#menu-btn").getAttribute("aria-label"), ctl: document.querySelector("#menu-btn").getAttribute("aria-controls"), w: Math.round(document.querySelector("#sidebar").getBoundingClientRect().width), view: Math.round(document.querySelector("#view").getBoundingClientRect().width) }));
  try {
    const p = await H.openPage(browser, owner, "home", { w: 1280, h: 800, init: seedTheme("light") });
    assert.equal(await p.$eval("#menu-btn", (b) => b.checkVisibility()), true, "the hamburger is visible on desktop");
    const open = await state(p);
    assert.deepEqual([open.nav, open.exp, open.label, open.ctl], ["expanded", "true", "Collapse menu", "sidebar"]);
    assert.equal(open.w, 232);
    await p.click("#menu-btn"); await H.wait(250);
    const rail = await state(p);
    assert.deepEqual([rail.nav, rail.exp, rail.label], ["collapsed", "false", "Expand menu"]);
    assert.equal(rail.w, 68, "icon-only rail");
    assert.ok(rail.view > open.view + 150, "the content area takes the freed width");
    // icon-only: labels are visually gone but remain the accessible names, tooltips carry the label
    const items = await p.$$eval("#nav button", (bs) => bs.filter((b) => !b.hidden).map((b) => ({ title: b.getAttribute("title"), label: b.querySelector(".nav-label").textContent.trim(), labelW: b.querySelector(".nav-label").getBoundingClientRect().width, ico: b.querySelector(".nav-ico").checkVisibility() })));
    for (const i of items) { assert.equal(i.title, i.label); assert.ok(i.labelW <= 2, "label not drawn in the rail"); assert.equal(i.ico, true); }
    assert.equal(await p.$eval(".create-btn", (b) => b.getAttribute("title")), "Create new");
    assert.equal(await p.$eval(".create-btn .cn-plus", (e) => e.checkVisibility()), true);
    assert.equal(await p.$eval(".brand-mark.on-light", (e) => e.checkVisibility() && e.complete && e.naturalWidth > 0), true, "the logo mark stands in for the lockup");
    assert.equal(await p.$eval(".brand-logo.on-light", (e) => e.checkVisibility()), false);
    // navigation still works from the rail
    await p.click('#nav button[data-go="links"]'); await H.wait(300);
    assert.equal(await p.evaluate(() => location.hash), "#/links");
    assert.equal((await state(p)).nav, "collapsed");
    // remembered per account, in localStorage, like the theme
    assert.equal(await p.evaluate((k) => localStorage.getItem(k), "eh-nav:u:" + JOSHUA), "collapsed");
    await p.reload(); await p.waitForSelector("#shell:not(.hidden)"); await H.wait(400);
    assert.equal((await state(p)).nav, "collapsed", "still collapsed after a reload");
    await p.close();
    // another account on the same device is not collapsed
    const other = await H.openPage(browser, limited, "warehouse", { w: 1280, h: 800 });
    assert.equal((await state(other)).nav, "expanded", "a different account keeps its own state");
    await other.close();
    // expand again and the choice is saved
    const back = await H.openPage(browser, owner, "home", { w: 1280, h: 800 });
    assert.equal((await state(back)).nav, "collapsed");
    await back.click("#menu-btn"); await H.wait(250);
    assert.equal((await state(back)).nav, "expanded");
    assert.equal(await back.evaluate((k) => localStorage.getItem(k), "eh-nav:u:" + JOSHUA), "expanded");
    // keyboard: Enter on the focused button toggles it
    await back.focus("#menu-btn"); await back.keyboard.press("Enter"); await H.wait(200);
    assert.equal((await state(back)).nav, "collapsed");
    await back.keyboard.press("Enter"); await H.wait(200);
    assert.equal((await state(back)).nav, "expanded");
    await back.close();

    // ---- mobile: a drawer, with overlay, Escape, focus and aria
    const m = await H.openPage(browser, owner, "home", { w: 390, h: 800, init: seedTheme("light") });
    const closed = await m.evaluate(() => ({ inert: document.querySelector("#sidebar").inert, exp: document.querySelector("#menu-btn").getAttribute("aria-expanded"), label: document.querySelector("#menu-btn").getAttribute("aria-label"), x: document.querySelector("#sidebar").getBoundingClientRect().right }));
    assert.deepEqual([closed.inert, closed.exp, closed.label], [true, "false", "Open menu"]);
    assert.ok(closed.x <= 1, "drawer is off screen");
    await m.click("#menu-btn"); await H.wait(350);
    const opened = await m.evaluate(() => ({ inert: document.querySelector("#sidebar").inert, exp: document.querySelector("#menu-btn").getAttribute("aria-expanded"), label: document.querySelector("#menu-btn").getAttribute("aria-label"), x: Math.round(document.querySelector("#sidebar").getBoundingClientRect().right), overlay: document.querySelector("#overlay").checkVisibility(), focus: document.activeElement.closest("#sidebar") !== null }));
    assert.deepEqual([opened.inert, opened.exp, opened.label, opened.overlay, opened.focus], [false, "true", "Close menu", true, true]);
    assert.ok(opened.x > 200, "drawer is on screen");
    // Tab stays inside the drawer
    for (let i = 0; i < 25; i++) await m.keyboard.press("Tab");
    assert.equal(await m.evaluate(() => document.activeElement.closest("#sidebar") !== null), true, "focus is held in the open drawer");
    await m.keyboard.press("Escape"); await H.wait(350);
    const afterEsc = await m.evaluate(() => ({ inert: document.querySelector("#sidebar").inert, exp: document.querySelector("#menu-btn").getAttribute("aria-expanded"), focus: document.activeElement.id }));
    assert.deepEqual(afterEsc, { inert: true, exp: "false", focus: "menu-btn" }, "Escape closes it and focus returns to the hamburger");
    await m.click("#menu-btn"); await H.wait(300);
    await m.mouse.click(380, 400); await H.wait(350);   // outside tap on the overlay
    assert.equal(await m.evaluate(() => document.querySelector("#sidebar").inert), true, "outside tap closes the drawer");
    await m.click("#menu-btn"); await H.wait(300);
    await m.click('#sidebar [data-go="links"]'); await H.wait(400);
    assert.deepEqual(await m.evaluate(() => [location.hash, document.querySelector("#sidebar").inert]), ["#/links", true], "choosing a tool closes the drawer");
    // mobile ignores a saved collapsed state: full labels in the drawer
    await m.evaluate((k) => localStorage.setItem(k, "collapsed"), "eh-nav:u:" + JOSHUA);
    await m.reload(); await m.waitForSelector("#shell:not(.hidden)"); await H.wait(300);
    await m.click("#menu-btn"); await H.wait(300);
    assert.ok(await m.$eval('#sidebar [data-go="links"] .nav-label', (e) => e.getBoundingClientRect().width > 20), "labels drawn in the mobile drawer");
    await m.close();
  } finally { await browser.close(); }
});

test("wide content: every admin page fits 1280, 1920, 2560 and a phone with no horizontal overflow, and uses the width", { skip: SKIP, timeout: 300000 }, async () => {
  const css = fs.readFileSync("public/admin/styles.css", "utf8");
  assert.equal(/\.view\{[^}]*max-width:1120px/.test(css), false, "the narrow max-width is gone");
  assert.match(css, /\.view\{[^}]*max-width:2400px/, "only an ultrawide cap remains");
  const { H, owner, limited } = await boot();
  const browser = await H.launch();
  const outside = () => { const out = []; const drawer = document.querySelector("#sidebar"); const skip = drawer.inert; for (const el of document.querySelectorAll("#view *, .topbar *, .sidebar *")) { if (skip && drawer.contains(el)) continue; if (!el.checkVisibility()) continue; const r = el.getBoundingClientRect(); if (r.width === 0) continue; if (r.right > innerWidth + 1 || r.left < -1) { let scrolls = false; for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (["auto", "scroll", "hidden", "clip"].includes(o)) { scrolls = true; break; } } if (!scrolls && !el.closest("svg")) out.push(el.tagName + "." + String(el.className).slice(0, 24)); } } return out.slice(0, 5); };
  try {
    const widths = {};
    for (const w of [1280, 1920, 2560, 390]) {
      for (const hash of PAGES) {
        const p = await H.openPage(browser, OWNER_ONLY.has(hash) ? owner : H.head, hash, { w, h: w < 500 ? 800 : 1000, init: seedTheme("crazy") });
        await H.wait(300);
        assert.deepEqual(await p.evaluate(outside), [], w + " " + hash + ": nothing sticks out sideways");
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), w + " " + hash + ": no horizontal scroll");
        if (hash === "links") widths[w] = await p.$eval("#view", (e) => Math.round(e.getBoundingClientRect().width));
        await p.close();
      }
    }
    assert.ok(widths[1920] > 1500 && widths[2560] > 2100, "the content area follows the browser width: " + JSON.stringify(widths));
    assert.ok(widths[2560] > widths[1920] && widths[1920] > widths[1280]);
    // the request-access page at width
    const q = await H.openPage(browser, limited, "warehouse", { w: 1920, h: 900, init: seedTheme("crazy") });
    await q.evaluate(() => { location.hash = "#/pos"; }); await H.wait(500);
    assert.deepEqual(await q.evaluate(outside), []);
    assert.ok(await q.$eval('[data-testid="request-page"]', (e) => e.getBoundingClientRect().width <= 640), "a short form does not stretch across the screen");
    await q.close();
    // forms keep a readable line on an ultrawide screen
    const s = await H.openPage(browser, H.head, "settings", { w: 2560, h: 1000, init: seedTheme("crazy") });
    assert.ok(await s.$eval("#view .field", (e) => e.getBoundingClientRect().width <= 905), "a form field does not stretch to 2000px+");
    await s.close();
  } finally { await browser.close(); }
});

test("support board: All is the default tab, compact cards, coloured status tabs readable in Light, Dark and Crazy (drawn, bolts included)", { skip: SKIP, timeout: 200000 }, async () => {
  const { H, owner } = await boot();
  const browser = await H.launch();
  const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  try {
    const seen = {};
    for (const theme of ["light", "dark", "crazy"]) {
      const p = await H.openPage(browser, owner, "tickets", { w: 1920, h: 1000, init: seedTheme(theme) });
      await p.waitForSelector('[data-testid="ticket-board"]'); await H.wait(300);
      assert.deepEqual(await p.$$eval(".tabs:not(.ticket-view-toggle) button", (bs) => bs.map((b) => b.textContent + ":" + b.classList.contains("on"))), ["All:true", "Screens:false", "Signage:false"], theme + ": All is the default tab");
      assert.equal(await p.$$eval('[data-testid="ticket-card"]', (c) => c.length), 8, "All shows both queues");
      const cols = await p.$$eval('[data-testid="ticket-column"]', (cs) => cs.map((c) => [c.dataset.status, c.querySelector(".ticket-col-tab span").textContent, c.querySelectorAll(".ticket-card").length, c.querySelector(".ticket-col-count").textContent]));
      assert.deepEqual(cols.map((c) => c[0] + "/" + c[1]), ["submitted/Submitted", "needs-info/Needs more info", "in-progress/In progress", "done/Done"]);
      assert.ok(cols.every((c) => String(c[2]) === c[3]), "counts match the cards");
      // the tabs really are the right hue (drawn colour, not the class name)
      const hue = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1; const d = mx - mn; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round(((h * 60) + 360) % 360); };
      const tabs = await p.$$eval(".ticket-col-tab", (ts) => ts.map((t) => [getComputedStyle(t).backgroundColor, getComputedStyle(t).color, getComputedStyle(t).backgroundImage !== "none", t.closest(".ticket-col").dataset.status]));
      const hues = Object.fromEntries(tabs.map((t) => [t[3], hue(t[0])]));
      assert.ok(hues.submitted <= 10 || hues.submitted >= 350, theme + ": Submitted is red " + hues.submitted);
      assert.ok(hues["needs-info"] >= 42 && hues["needs-info"] <= 58, theme + ": Needs more info is yellow " + hues["needs-info"]);
      assert.ok(hues["in-progress"] >= 22 && hues["in-progress"] <= 38, theme + ": In progress is orange " + hues["in-progress"]);
      assert.ok(hues.done >= 120 && hues.done <= 150, theme + ": Done is green " + hues.done);
      assert.deepEqual(tabs.map((t) => t[2]), [false, false, true, false], "only In progress carries the bolt pattern");
      if (theme !== "dark") for (const t of tabs) assert.ok(lum(...t[0].match(/\d+/g).map(Number)) > 0.7, theme + ": light status colours in " + t[3]);
      // contrast against the WORST drawn pixel behind the label (text hidden, tab screenshot, bolts included)
      for (const status of ["submitted", "needs-info", "in-progress", "done"]) {
        const handle = await p.$(`.ticket-col.st-${status} .ticket-col-tab`);
        const ink = await handle.evaluate((e) => getComputedStyle(e).color);
        const spans = await handle.evaluate((e) => { const t = e.getBoundingClientRect(); const label = e.querySelector("span").getBoundingClientRect(); return { x: label.left - t.left, y: label.top - t.top, lw: label.width, lh: label.height }; });
        await handle.evaluate((e) => e.querySelectorAll("span").forEach((s) => { s.style.visibility = "hidden"; }));
        const shot = await handle.screenshot({ type: "jpeg", quality: 100 });
        await handle.evaluate((e) => e.querySelectorAll("span").forEach((s) => { s.style.visibility = ""; }));
        const img = jpeg.decode(shot, { useTArray: true });
        const [ir, ig, ib] = ink.match(/\d+/g).map(Number); const il = lum(ir, ig, ib);
        let worst = 99;
        // only the pixels the label text sits on (the tab's own edge line is not behind any text)
        for (let y = Math.floor(spans.y); y < Math.ceil(spans.y + spans.lh); y++) for (let x = Math.floor(spans.x); x < Math.ceil(spans.x + spans.lw); x++) { const i = (y * img.width + x) * 4; worst = Math.min(worst, ratio(il, lum(img.data[i], img.data[i + 1], img.data[i + 2]))); }
        assert.ok(worst >= 4.5, theme + " " + status + ": label contrast on the worst drawn pixel is " + worst.toFixed(2));
        seen[theme + status] = worst.toFixed(1);
      }
      // compact: cards are short
      const h = await p.$$eval(".ticket-card", (cs) => Math.max(...cs.map((c) => c.getBoundingClientRect().height)));
      assert.ok(h <= 112, theme + ": compact cards (max " + h + "px)");
      assert.equal(await p.evaluate(() => [...document.querySelectorAll(".ticket-card")].every((c) => c.querySelector(".ticket-card-open") && c.querySelector(".ticket-site") && c.querySelector(".badge") && c.querySelector(".ticket-move select"))), true, "key fields stay visible");
      // coloured left edge on the cards
      assert.ok(await p.$eval(".ticket-col.st-done .ticket-card", (c) => parseFloat(getComputedStyle(c).borderLeftWidth) >= 3));
      // board uses the width: four columns across 1920
      assert.ok(await p.$eval('[data-testid="ticket-board"]', (b) => b.getBoundingClientRect().width > 1400));
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await p.close();
    }
    // a person who picked a queue keeps it; All stays a tab
    const q = await H.openPage(browser, owner, "tickets", { w: 1280, h: 900, init: seedTheme("light") });
    await q.click('.tabs button[data-queue="signage"]'); await H.wait(500);
    assert.equal(await q.$$eval('[data-testid="ticket-card"]', (c) => c.length), 4);
    assert.equal(await q.$eval('.tabs button[data-queue="signage"]', (b) => b.classList.contains("on")), true);
    await q.close();
    assert.ok(Object.keys(seen).length === 12);
  } finally { await browser.close(); }
});

test("email: the request-access button and card fit a 390px phone and wrap long addresses", { skip: SKIP, timeout: 90000 }, async () => {
  const { H } = await boot();
  const ar = await import("../netlify/lib/access-request.mjs");
  const cred = await import("../netlify/lib/credentials.mjs");
  const long = "a.very.long.synthetic.person.name.for.testing@subdomain.libertyretail.com.au";
  const mails = [ar.requestMessage(long, "visitors", "Covering the Visitor Log this week, and also the long reason text goes here to test wrapping behaviour on phones.", Date.now()), cred.inviteMessage(long, "synthetic-token-not-real-0123456789abcdef", "invite", Date.now() + 3 * 864e5)];
  assert.match(mails[0].html, />Open in Users<\/a>/, "short label; the address is shown in the details above");
  assert.equal(mails[0].html.includes("Open " + long), false);
  assert.match(mails[0].text, /Requester: a\.very\.long/, "plain text unchanged");
  const browser = await H.launch();
  try {
    for (const msg of mails) for (const w of [390, 320]) {
      const p = await browser.newPage();
      await p.setViewport({ width: w, height: 800 });
      await p.setRequestInterception(true);
      p.on("request", (r) => { const u = new URL(r.url()); if (u.origin === "https://expresshelp.site" && u.pathname.startsWith("/brand/")) return r.respond({ contentType: "image/png", body: fs.readFileSync("public" + u.pathname) }); if (r.url().startsWith("data:") || r.url() === "about:blank") return r.continue(); r.abort(); });
      await p.setContent(msg.html); await H.wait(300);
      const fit = await p.evaluate(() => { const vw = document.documentElement.clientWidth; const card = document.querySelector("table table"); const out = []; for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.width && (r.right > vw + 0.5 || r.left < -0.5)) out.push(el.tagName + ":" + Math.round(r.right)); } const a = document.querySelector("a[data-testid=request-link], a[data-testid=invite-link]").getBoundingClientRect(); const c = card.getBoundingClientRect(); return { vw, sw: document.documentElement.scrollWidth, out: out.slice(0, 4), btnInside: a.left >= c.left && a.right <= c.right, cardInside: c.left >= 0 && c.right <= vw }; });
      assert.deepEqual([fit.out, fit.btnInside, fit.cardInside], [[], true, true], w + "px: " + JSON.stringify(fit));
      assert.ok(fit.sw <= fit.vw, "no sideways scroll at " + w);
      await p.close();
    }
  } finally { await browser.close(); }
});
