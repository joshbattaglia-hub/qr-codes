import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";

/** Real-browser check of the Side menu editor. Synthetic data, mail mocked, no live writes. */
const H = await import("./support/browser-harness.mjs");
const SKIP = !H.CHROME;
const SHOTS = "/workspace/qr-codes-data/admin-menu-screenshots";
fs.mkdirSync(SHOTS, { recursive: true });
const ownerCookie = await H.otpCookie(H.JOSHUA);
const visibleNav = (page) => page.$$eval("#nav [data-go]", (els) => els.filter((e) => !e.hidden && getComputedStyle(e).display !== "none").map((e) => e.dataset.go));

test("owner can hide and reorder tools in Settings; hidden tools stay reachable by link", { skip: SKIP, timeout: 120000 }, async () => {
  const reset = await H.call("POST", "/api/admin-menu", { cookie: ownerCookie, body: { reset: true } });
  assert.equal(reset.status, 200);
  const browser = await H.launch();
  try {
    const page = await H.openPage(browser, ownerCookie, "settings", { w: 1440, h: 900 });
    await page.waitForSelector("[data-testid=side-menu-settings]");
    assert.ok(await page.$("[data-testid=side-menu-pinned-settings]"), "Settings has no Hide button");
    assert.equal(await page.$("[data-testid=side-menu-vis-settings]"), null);
    const start = await visibleNav(page);
    assert.ok(start.includes("analytics"));
    assert.ok(start.includes("settings"));
    assert.equal(start.at(-1), "settings");

    await page.evaluate(() => {
      const top = document.querySelector(".topbar");
      if (top) top.style.position = "static";
      window.scrollTo(0, 0);
    });
    await H.wait(200);
    await page.screenshot({ path: path.join(SHOTS, "settings-card-1440.png"), fullPage: true });
    await page.evaluate(() => { const top = document.querySelector(".topbar"); if (top) top.style.position = ""; });

    // hide Analytics and move Visitor log up above Support (tickets is just below visitors by default)
    await page.click("[data-testid=side-menu-vis-analytics]");
    await page.waitForFunction(() => !document.querySelector("#nav [data-go='analytics']") || document.querySelector("#nav [data-go='analytics']").hidden);
    const afterHide = await visibleNav(page);
    assert.ok(!afterHide.includes("analytics"), "Analytics is gone from the menu");
    assert.ok(afterHide.includes("settings"), "Settings stays in the menu");

    await page.click("[data-testid=side-menu-up-visitors]");
    await page.waitForFunction(() => {
      const ids = [...document.querySelectorAll("#nav [data-go]")].filter((e) => !e.hidden).map((e) => e.dataset.go);
      return ids.indexOf("visitors") < ids.indexOf("warehouse");
    });

    await page.evaluate(() => window.scrollTo(0, 0));
    await H.wait(200);
    await page.screenshot({ path: path.join(SHOTS, "menu-analytics-hidden-1440.png") });

    const hit = await page.$eval("[data-testid=side-menu-vis-analytics]", (el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    assert.ok(hit.w >= 44 && hit.h >= 44, "Show/Hide hit area is at least 44px, got " + JSON.stringify(hit));

    // direct link still opens the hidden tool
    await page.evaluate(() => { location.hash = "#/analytics"; });
    await page.waitForFunction(() => document.querySelector("#view h1")?.textContent === "Analytics");
    assert.equal(await page.$eval("#view h1", (e) => e.textContent), "Analytics");

    // mobile: settings card and hidden tool in the drawer
    const mobile = await H.openPage(browser, ownerCookie, "settings", { w: 390, h: 844 });
    await mobile.waitForSelector("[data-testid=side-menu-settings]");
    await mobile.evaluate(() => window.scrollTo(0, 0));
    await H.wait(200);
    await mobile.screenshot({ path: path.join(SHOTS, "settings-card-390.png"), fullPage: true });
    const mobNav = await visibleNav(mobile);
    assert.ok(!mobNav.includes("analytics"), "hidden tool stays hidden on a narrow screen");
    await mobile.evaluate(() => window.scrollTo(0, 0));
    await mobile.click("[data-testid=menu-btn]");
    await mobile.waitForSelector("#sidebar.open");
    await mobile.waitForFunction(() => {
      const side = document.querySelector("#sidebar");
      return side && side.getBoundingClientRect().left >= -1 && side.getBoundingClientRect().right > 120;
    });
    await H.wait(400);
    await mobile.screenshot({ path: path.join(SHOTS, "menu-analytics-hidden-390.png") });
    await mobile.close();
    await page.close();
  } finally {
    await browser.close();
  }
});

test("limited user still gets Other tools; a site-hidden tool is not listed there but a direct link still works", { skip: SKIP, timeout: 120000 }, async () => {
  const users = await import("../netlify/lib/users.mjs");
  const added = await users.saveUser(H.OWNER, { mode: "add", email: "staff.menubrowser@libertyretail.com.au", warehouse: true, visitor: "none", tickets: [], assets: "none" });
  assert.equal(added.status, 200, added.error);
  await H.call("POST", "/api/admin-menu", { cookie: ownerCookie, body: { hidden: ["analytics"], order: [] } });
  const staffCookie = await H.otpCookie("staff.menubrowser@libertyretail.com.au");
  const browser = await H.launch();
  try {
    const page = await H.openPage(browser, staffCookie, "warehouse", { w: 1280, h: 800 });
    assert.deepEqual(await visibleNav(page), ["warehouse"]);
    assert.equal(await page.$eval("#other-tools", (d) => d.hidden), false);
    const other = await page.$$eval("#other-tools-list [data-go]", (els) => els.map((e) => e.dataset.go));
    assert.ok(!other.includes("analytics"), "site-hidden tool is not in Other tools");
    assert.ok(other.includes("visitors"));
    assert.ok(other.includes("settings"));
    await page.evaluate(() => { location.hash = "#/analytics"; });
    await page.waitForSelector("[data-testid=request-page][data-tool=analytics]");
    await page.close();
  } finally {
    await browser.close();
    await H.call("POST", "/api/admin-menu", { cookie: ownerCookie, body: { reset: true } });
  }
});
