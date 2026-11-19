import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Real-browser checks for the UX principles: 44px hit areas, scrim / Esc / focus, press and wind-up, pose-to-pose, toasts, reduced motion.
 *  Synthetic data, real handlers, in-memory store, mail blocked. */
const SKIP = !["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].some((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
let ctx = null; let browser = null;
async function boot() {
  if (ctx) return ctx;
  const H = await import("./support/browser-harness.mjs");
  const owner = await H.otpCookie(JOSHUA);
  const j = async (p) => (await p).json();
  const site = (await j(H.call("POST", "/api/sites", { cookie: H.head, body: { name: "North yard" } }))).id;
  for (const slug of ["spring-sale", "del-a", "del-b"]) await H.call("POST", "/api/codes", { cookie: H.head, body: { url: "https://example.com/" + slug, slug, siteId: site, type: "qr", name: "Code " + slug } });
  const subs = ["Register 3 screen flickers", "Pylon sign bulb out", "Menu board shows wrong price", "Forecourt screen blank"];
  for (let i = 0; i < subs.length; i++) await H.call("POST", "/api/tickets", { cookie: owner, body: { queue: i % 2 ? "signage" : "screens", requestType: i % 2 ? "Damage or repair" : "Fault or repair", priority: "normal", subject: subs[i], description: "Synthetic.", requesterEmail: "sam.synthetic@libertyretail.com.au", siteId: site } });
  const users = await import("../netlify/lib/users.mjs");
  await users.saveUser(H.OWNER, { mode: "add", email: "limited.synthetic@libertyretail.com.au", warehouse: true, visitor: "none", tickets: ["screens"], assets: "none" });
  ctx = { H, owner };
  return ctx;
}
const seed = (theme) => `try{if(!sessionStorage.getItem("__s")){sessionStorage.setItem("__s","1");localStorage.clear();localStorage.setItem("eh-theme:last","${JOSHUA}");localStorage.setItem("eh-theme:u:${JOSHUA}","${theme}");}}catch(e){}
  window.__anims = 0; const a = Element.prototype.animate; Element.prototype.animate = function () { window.__anims++; return a.apply(this, arguments); };`;
async function open(hash, { w = 1440, h = 900, theme = "crazy", head = false } = {}) {
  const { H, owner } = await boot();
  if (!browser) browser = await H.launch();
  const page = await H.openPage(browser, head ? H.head : owner, hash, { w, h, init: seed(theme), log: false });
  await H.wait(300);
  return page;
}
const visible = async (page, selector) => (await page.evaluateHandle((sel) => [...document.querySelectorAll(sel)].find((e) => e.checkVisibility()), selector)).asElement();
after(async () => { if (browser) await browser.close(); });
const small = (page, selector) => page.$$eval(selector, (els) => els.filter((e) => e.checkVisibility()).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || e.getAttribute("aria-label") || e.id || e.className).trim().slice(0, 24), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }).filter((r) => r.w < 43.9 || r.h < 43.9));

test("hit areas: every listed control is at least 44px, on desktop and on a phone", { skip: SKIP, timeout: 120000 }, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const p = await open("tickets", { w, h });
    await p.waitForSelector('[data-testid="ticket-board"]');
    for (const sel of [".ticket-view-toggle button", ".tabs:not(.ticket-view-toggle) button", "#theme-btn", "#menu-btn", ".top-actions .icon-btn", ".top-actions .avatar", ".search input", ".asset-actions .btn"]) {
      const found = await p.$$(sel);
      assert.ok(found.length >= 1, w + ": " + sel + " exists");
      assert.deepEqual(await small(p, sel), [], w + ": " + sel + " is at least 44px");
    }
    if (w < 500) {
      await p.click("#menu-btn"); await new Promise((r) => setTimeout(r, 450));
      assert.deepEqual(await small(p, "#nav button"), [], "drawer menu rows are at least 44px on a phone");
      assert.deepEqual(await small(p, ".ticket-move select, .ticket-move .btn"), [], "phone: card move controls are at least 44px");
    }
    await p.close();
  }
  const u = await open("users");
  await u.waitForSelector('[data-act="user-edit"]');
  assert.deepEqual(await small(u, 'td [data-act="user-edit"], td [data-act="user-invite"], td [data-act="user-remove"]'), [], "users table row actions");
  await u.evaluate(() => document.querySelector('[data-act="user-add-open"]').click());
  await u.waitForSelector(".perm-head");
  assert.deepEqual(await small(u, ".perm-head:not(.perm-locked)"), [], "permission rows are full-width tap targets");
  assert.deepEqual(await u.$$eval(".perm-head input:not([disabled])", (els) => els.map((e) => e.getBoundingClientRect().width).filter((x) => x < 22)), [], "permission checkboxes are drawn at 22px");
  await u.close();
});

test("scrim, Esc, click-outside and focus: a modal dims the page, traps focus, closes on Esc or scrim and gives focus back", { skip: SKIP, timeout: 60000 }, async () => {
  const p = await open("qrcodes/spring-sale", { head: true });
  await p.waitForSelector('[data-act="edit"]');
  await (await visible(p, '[data-act="edit"]')).focus();
  await p.keyboard.press("Enter");
  await p.waitForSelector("#modal .modal-card");
  const info = await p.evaluate(() => {
    const back = document.querySelector("#modal .modal-back"); const r = back.getBoundingClientRect(); const bg = getComputedStyle(back).backgroundColor.match(/[\d.]+/g).map(Number);
    return { covers: r.width >= innerWidth && r.height >= innerHeight, alpha: bg[3] ?? 1, inert: document.getElementById("shell").inert, inside: !!document.activeElement.closest(".modal-card"), aria: document.querySelector(".modal-card").getAttribute("aria-modal"), labelled: !!document.getElementById(document.querySelector(".modal-card").getAttribute("aria-labelledby")) };
  });
  assert.equal(info.covers, true, "scrim covers the whole window");
  assert.ok(info.alpha >= 0.3, "scrim dims the page behind");
  assert.equal(info.inert, true, "page behind is inert");
  assert.equal(info.inside, true, "focus moved into the modal");
  assert.equal(info.aria, "true");
  assert.equal(info.labelled, true);
  for (let i = 0; i < 12; i++) { await p.keyboard.press("Tab"); assert.equal(await p.evaluate(() => !!document.activeElement.closest(".modal-card")), true, "Tab " + i + " stays in the modal"); }
  for (let i = 0; i < 12; i++) { await p.keyboard.down("Shift"); await p.keyboard.press("Tab"); await p.keyboard.up("Shift"); assert.equal(await p.evaluate(() => !!document.activeElement.closest(".modal-card")), true, "Shift+Tab stays in the modal"); }
  await p.keyboard.press("Escape");
  assert.equal(await p.$("#modal .modal-card"), null, "Esc closes");
  assert.equal(await p.evaluate(() => document.activeElement?.dataset?.act), "edit", "focus returns to the button that opened it");
  assert.equal(await p.evaluate(() => document.getElementById("shell").inert), false);
  await p.keyboard.press("Enter");
  await p.waitForSelector("#modal .modal-card");
  await p.mouse.click(8, 450);
  assert.equal(await p.$("#modal .modal-card"), null, "clicking the scrim closes");
  await p.close();
});

test("press feedback, wind-up before a big action, and reduced motion turns them off", { skip: SKIP, timeout: 90000 }, async () => {
  const p = await open("qrcodes/del-a", { head: true });
  await p.waitForSelector('[data-act="edit"]');
  const press = await visible(p, ".btn");
  const box = await press.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await new Promise((r) => setTimeout(r, 220));
  const pressed = await press.evaluate((b) => getComputedStyle(b).transform);
  await p.mouse.move(2, 2); await p.mouse.up();
  const scale = Number((pressed.match(/matrix\(([\d.]+)/) || [])[1]);
  assert.ok(scale > 0.9 && scale < 1, "pressed buttons squash slightly (scale " + scale + ")");
  // wind-up before Delete: the confirm button carries .winding for about 100ms, then the delete runs
  await p.evaluate(() => document.querySelector('[data-act="del"]').click());
  await p.waitForSelector('[data-act="confirm-del"]');
  await p.evaluate(() => { window.__wind = []; const b = document.querySelector('[data-act="confirm-del"]'); new MutationObserver(() => window.__wind.push([b.classList.contains("winding"), performance.now()])).observe(b, { attributes: true, attributeFilter: ["class"] }); });
  await p.click('[data-act="confirm-del"]');
  await new Promise((r) => setTimeout(r, 400));
  const wind = await p.evaluate(() => window.__wind);
  assert.ok(wind.length >= 2 && wind[0][0] === true && wind[1][0] === false, "wind-up class on, then off");
  assert.ok(wind[1][1] - wind[0][1] >= 80 && wind[1][1] - wind[0][1] <= 200, "wind-up lasts about 100ms (" + Math.round(wind[1][1] - wind[0][1]) + ")");
  await p.close();

  const r = await open("qrcodes/del-b", { head: true });
  await r.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  assert.equal(await r.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
  await r.waitForSelector('[data-act="edit"]');
  const css = await r.evaluate(() => { const b = [...document.querySelectorAll(".btn")].find((e) => e.checkVisibility()); return { trans: getComputedStyle(b).transitionDuration, anim: getComputedStyle(document.getElementById("toast")).animationName }; });
  assert.match(css.trans, /^0s/, "no transitions");
  await r.evaluate(() => document.querySelector('[data-act="del"]').click());
  await r.waitForSelector(".modal-card");
  assert.equal(await r.evaluate(() => getComputedStyle(document.querySelector(".modal-card")).animationName), "none", "modal does not animate in");
  assert.equal(await r.evaluate(() => getComputedStyle(document.querySelector(".modal-back")).animationName), "none");
  const box2 = await (await r.$('[data-act="confirm-del"]')).boundingBox();
  await r.mouse.move(box2.x + 5, box2.y + 5); await r.mouse.down(); await new Promise((x) => setTimeout(x, 150));
  assert.equal(await r.evaluate(() => getComputedStyle(document.querySelector('[data-act="confirm-del"]')).transform), "none", "no squash under reduced motion");
  await r.mouse.move(2, 2); await r.mouse.up();
  await r.evaluate(() => { window.__wind = false; new MutationObserver(() => { if (document.querySelector(".winding")) window.__wind = true; }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] }); });
  await r.click('[data-act="confirm-del"]');
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(await r.evaluate(() => window.__wind), false, "no wind-up under reduced motion, the action is instant");
  await r.close();
});

test("pose to pose: a moved ticket card slides to its new column (FLIP) and the count pulses; none of it under reduced motion", { skip: SKIP, timeout: 90000 }, async () => {
  for (const reduce of [false, true]) {
    const p = await open("tickets", { w: 1440, h: 1000 });
    if (reduce) await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await p.waitForSelector(".ticket-col.st-submitted .ticket-card");
    const id = await p.$eval(".ticket-col.st-submitted .ticket-card", (c) => c.dataset.id);
    await p.evaluate(() => { window.__anims = 0; });
    await p.select("#move-" + id, "in-progress");
    await p.click('[data-act="ticket-move"][data-id="' + id + '"]');
    await p.waitForFunction((tid) => document.querySelector('.ticket-col.st-in-progress .ticket-card[data-id="' + tid + '"]'), { timeout: 8000 }, id);
    await new Promise((r) => setTimeout(r, 400));
    const anims = await p.evaluate(() => window.__anims);
    if (reduce) assert.equal(anims, 0, "no Web Animations under reduced motion");
    else assert.ok(anims >= 2, "cards animated to their new places (" + anims + ")");
    assert.equal(await p.$eval("#toast", (t) => t.dataset.kind + ":" + t.textContent), "success:Ticket moved");
    await p.close();
  }
});

test("toasts: success, copied and error are distinct, announced, and the error is assertive", { skip: SKIP, timeout: 60000 }, async () => {
  const p = await open("home", { head: true });
  const say = (message, kind) => p.evaluate((m, k) => document.dispatchEvent(new CustomEvent("eh:toast", { detail: { message: m, kind: k } })), message, kind);
  const read = () => p.evaluate(() => { const t = document.getElementById("toast"); return { kind: t.dataset.kind, live: t.getAttribute("aria-live"), text: t.textContent, hidden: t.classList.contains("hidden"), icon: getComputedStyle(t, "::before").content, bg: getComputedStyle(t).backgroundColor, size: getComputedStyle(t, "::before").width }; });
  await say("Saved", "success"); await new Promise((r) => setTimeout(r, 350));
  const ok = await read();
  assert.deepEqual([ok.kind, ok.live, ok.text, ok.hidden], ["success", "polite", "Saved", false]);
  assert.match(ok.icon, /✓/);
  await say("Copied", "copied"); await new Promise((r) => setTimeout(r, 350));
  const copied = await read();
  assert.equal(copied.kind, "copied"); assert.match(copied.icon, /✓/);
  assert.ok(parseFloat(copied.size) > parseFloat(ok.size), "the copied tick is bigger");
  await say("That did not work", "error"); await new Promise((r) => setTimeout(r, 350));
  const bad = await read();
  assert.deepEqual([bad.kind, bad.live], ["error", "assertive"]);
  assert.equal(bad.bg, "rgb(180, 35, 24)");
  assert.match(bad.icon, /!/);
  await p.close();
});

test("frequent actions are instant: tabs have no transition and the theme menu has no entrance animation", { skip: SKIP, timeout: 60000 }, async () => {
  const p = await open("tickets");
  await p.waitForSelector(".tabs button");
  assert.equal(await p.$eval(".tabs button", (b) => getComputedStyle(b).transitionDuration), "0s");
  await p.click("#theme-btn");
  await p.waitForSelector("#pop-theme:not(.hidden)");
  assert.equal(await p.$eval("#pop-theme", (e) => getComputedStyle(e).animationName), "none");
  await p.close();
});
