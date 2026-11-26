import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";

/** Pages save: email-code owner can publish, oversized heroes are refused (not treated as a signed-out session), previews are look-only. */
const H = await import("./support/browser-harness.mjs");
const { validHero } = await import("../netlify/lib/pages.mjs");
const users = await import("../netlify/lib/users.mjs");
const owner = await H.otpCookie(H.JOSHUA);
const j = async (p) => {
  const r = await p;
  const t = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: t.includes("json") ? await r.json() : await r.text() };
};
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SHOTS = "/workspace/qr-codes-data/pages-save-screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

test("validHero accepts a small PNG and rejects an oversized data URL", () => {
  assert.equal(validHero(""), true);
  assert.equal(validHero(TINY_PNG), true);
  assert.equal(validHero("data:image/webp;base64,AAAA"), false);
  assert.equal(validHero("data:image/png;base64," + "A".repeat(180001)), false);
});

test("the owner signed in with an email code can create, save a hero, and publish a page", async () => {
  const anon = await j(H.call("POST", "/api/pages", { body: { name: "Nope", slug: "otp-anon-page" } }));
  assert.equal(anon.status, 401);

  const created = await j(H.call("POST", "/api/pages", {
    cookie: owner,
    body: {
      name: "Test Page",
      slug: "otp-test-page",
      heading: "Welcome",
      heroData: TINY_PNG,
      fields: [
        { id: "name", type: "text", label: "Name", required: true },
        { id: "email", type: "email", label: "Email", required: true },
      ],
    },
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.name, "Test Page");
  assert.equal(created.body.status, "draft");
  assert.equal(created.body.hasHero, true);

  const saved = await j(H.call("PATCH", "/api/pages/otp-test-page", {
    cookie: owner,
    body: { heading: "Welcome back", heroData: TINY_PNG },
  }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.heading, "Welcome back");

  const published = await j(H.call("PATCH", "/api/pages/otp-test-page", { cookie: owner, body: { status: "published" } }));
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "published");

  const list = await j(H.call("GET", "/api/pages", { cookie: owner }));
  assert.equal(list.status, 200);
  assert.equal(list.body.some((p) => p.slug === "otp-test-page"), true);
});

test("an oversized hero is a 400, not a 401, and a staff email-code user cannot save pages", async () => {
  const huge = await j(H.call("POST", "/api/pages", {
    cookie: owner,
    body: { name: "Huge", slug: "otp-huge-hero", heroData: "data:image/png;base64," + "A".repeat(180001) },
  }));
  assert.equal(huge.status, 400);
  assert.match(huge.body.error || "", /hero image/i);
  assert.notEqual(huge.status, 401);

  const added = await users.saveUser(H.OWNER, { mode: "add", email: "staff.pages@libertyretail.com.au", visitor: "view", tickets: [], assets: "none", warehouse: true });
  assert.equal(added.status, 200, added.error);
  const staff = await H.otpCookie("staff.pages@libertyretail.com.au");
  const denied = await j(H.call("POST", "/api/pages", { cookie: staff, body: { name: "Staff page", slug: "staff-page" } }));
  assert.equal(denied.status, 403);
});

test("previews refuse page writes and do not record public views", async () => {
  const fn = (await import("../netlify/functions/pages.mjs")).default;
  const previewReq = new Request("https://pages-save-pr77--liberty-qr-353.netlify.app/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner },
    body: JSON.stringify({ name: "Preview write", slug: "preview-write" }),
  });
  const blocked = await fn(previewReq, { deploy: { context: "production" } });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /preview/);

  const live = await j(H.call("GET", "/api/pages/otp-test-page", { cookie: owner }));
  assert.equal(live.status, 200);
  const before = live.body.stats?.total || 0;
  const viewReq = new Request("https://pages-save-pr77--liberty-qr-353.netlify.app/p/otp-test-page", { method: "GET", headers: { "user-agent": "Mozilla/5.0" } });
  const viewed = await fn(viewReq, { deploy: { context: "production" }, ip: "203.0.113.50" });
  assert.equal(viewed.status, 200);
  const after = await j(H.call("GET", "/api/pages/otp-test-page", { cookie: owner }));
  assert.equal(after.body.stats?.total || 0, before, "preview visits must not write live view counts");
});

function phonePhoto(filePath) {
  const width = 3200, height = 2400;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 17 + y) & 255;
      data[i + 1] = (y * 13 + x) & 255;
      data[i + 2] = 64 + ((x + y) & 63);
      data[i + 3] = 255;
    }
  }
  fs.writeFileSync(filePath, jpeg.encode({ width, height, data }, 90).data);
}

test("in the admin, the owner can save a page with a phone-sized hero and an expired session keeps the draft", { skip: !H.CHROME, timeout: 120000 }, async () => {
  const photo = "/tmp/pages-hero-phone.jpg";
  phonePhoto(photo);
  assert.ok(fs.statSync(photo).size > 400000, "fixture is a realistically large photo");
  const browser = await H.launch();
  try {
    const page = await H.openPage(browser, owner, "pages/new");
    await page.waitForSelector("[data-testid=page-editor]");
    await page.$eval('[name="name"]', (el) => { el.value = ""; });
    await page.type('[name="name"]', "Test Page");
    const input = await page.$("#hero-file");
    await input.uploadFile(photo);
    await page.waitForFunction(() => {
      const img = document.getElementById("hero-preview");
      return img && !img.hidden && img.src && img.src.startsWith("data:image/");
    }, { timeout: 20000 });
    const heroLen = await page.$eval("#hero-preview", (img) => img.src.length);
    assert.ok(heroLen > 32 && heroLen <= 180000, "hero was resized under the 120 KB cap");
    await page.screenshot({ path: path.join(SHOTS, "01-editor-with-hero.png"), fullPage: true });

    await Promise.all([
      page.waitForFunction(() => !document.getElementById("login") || document.getElementById("login").classList.contains("hidden")),
      page.click('#page-editor button[type="submit"]'),
    ]);
    await page.waitForFunction(() => {
      const login = document.getElementById("login");
      const signedOut = login && !login.classList.contains("hidden");
      const url = location.hash || "";
      return !signedOut && /^#\/pages\/(?!new$).+/.test(url);
    }, { timeout: 15000 });
    assert.equal(await page.$eval("#login", (el) => el.classList.contains("hidden")), true, "saving must not bounce to the login page");
    assert.match(await page.evaluate(() => location.hash), /^#\/pages\//);
    assert.notEqual(await page.evaluate(() => location.hash), "#/pages/new");
    await page.screenshot({ path: path.join(SHOTS, "02-saved-stayed-signed-in.png"), fullPage: true });

    await page.goto("https://expresshelp.site/admin/#/pages/new");
    await page.waitForSelector("[data-testid=page-editor]");
    await page.type('[name="name"]', "Kept Draft Page");
    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        if (String(url).startsWith("/api/pages") && String(init.method || "GET").toUpperCase() === "POST") {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
        }
        return orig(input, init);
      };
    });
    await page.click('#page-editor button[type="submit"]');
    await page.waitForSelector("#login:not(.hidden)", { timeout: 10000 });
    const message = await page.$eval("#login-error", (el) => el.textContent);
    assert.match(message, /unsaved page will come back/i);
    const stored = await page.evaluate(() => sessionStorage.getItem("eh-page-draft"));
    assert.match(stored || "", /Kept Draft Page/);
    await page.screenshot({ path: path.join(SHOTS, "03-session-expired-keeps-draft.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#shell:not(.hidden)", { timeout: 15000 });
    await page.waitForSelector("[data-testid=page-editor]");
    const restored = await page.$eval('[name="name"]', (el) => el.value);
    assert.equal(restored, "Kept Draft Page");
    assert.equal(await page.$eval("#login", (el) => el.classList.contains("hidden")), true);
    await page.screenshot({ path: path.join(SHOTS, "04-draft-restored-after-sign-in.png"), fullPage: true });
  } finally {
    await browser.close();
  }
});
