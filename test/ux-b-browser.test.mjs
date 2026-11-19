import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Real-browser checks for PR B: optimistic moves with rollback, chunked forms, Hick's More menus, Postel on blur, Enter submits, skeletons.
 *  Synthetic data, real handlers, in-memory store, mail blocked. */
const SKIP = !["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].some((p) => fs.existsSync(p));
const JOSHUA = "jbattaglia@libertyretail.com.au";
let ctx = null; let browser = null;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function boot() {
  if (ctx) return ctx;
  const H = await import("./support/browser-harness.mjs");
  const owner = await H.otpCookie(JOSHUA);
  const j = async (p) => (await p).json();
  const site = (await j(H.call("POST", "/api/sites", { cookie: H.head, body: { name: "North yard" } }))).id;
  await H.call("POST", "/api/codes", { cookie: H.head, body: { url: "https://example.com/spring-sale", slug: "spring-sale", siteId: site, type: "qr", name: "Code spring-sale" } });
  for (let i = 0; i < 4; i++) await H.call("POST", "/api/tickets", { cookie: owner, body: { queue: "screens", requestType: "Fault or repair", priority: "normal", subject: "Synthetic ticket " + i, description: "Synthetic only.", requesterEmail: "someone.synthetic@libertyretail.com.au", siteId: site } });
  ctx = { H, owner };
  return ctx;
}
const seed = (extra = "") => `try{if(!sessionStorage.getItem("__s")){sessionStorage.setItem("__s","1");localStorage.clear();localStorage.setItem("eh-theme:last","${JOSHUA}");localStorage.setItem("eh-theme:u:${JOSHUA}","crazy");}}catch(e){}${extra}`;
async function open(hash, { w = 1440, h = 1000, head = false, init = "" } = {}) {
  const { H, owner } = await boot();
  if (!browser) browser = await H.launch();
  const page = await H.openPage(browser, head ? H.head : owner, hash, { w, h, init: seed(init), log: false });
  await H.wait(300);
  return page;
}
after(async () => { if (browser) await browser.close(); });
// Slow or fail one kind of request from inside the page, so the test sees what the person sees while the server is "thinking".
const tamper = (p, pattern, { delay = 0, fail = 0 } = {}) => p.evaluate((pat, d, f) => {
  const real = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (new RegExp(pat).test(String(url)) && (opts?.method || "GET") !== "GET") {
      if (d) await new Promise((r) => setTimeout(r, d));
      if (f) return new Response(JSON.stringify({ error: "Synthetic failure" }), { status: f, headers: { "content-type": "application/json" } });
    }
    return real(url, opts);
  };
}, pattern.source, delay, fail);

test("optimistic move: the card is in its new column within 400ms even while the server is slow", { skip: SKIP, timeout: 90000 }, async () => {
  const p = await open("tickets");
  await p.waitForSelector(".ticket-col.st-submitted .ticket-card");
  const id = await p.$eval(".ticket-col.st-submitted .ticket-card", (c) => c.dataset.id);
  await tamper(p, /\/move$/, { delay: 1500 });
  await p.select("#move-" + id, "in-progress");
  const t0 = Date.now();
  await p.click('[data-act="ticket-move"][data-id="' + id + '"]');
  await p.waitForFunction((tid) => document.querySelector('.ticket-col.st-in-progress .ticket-card[data-id="' + tid + '"]'), { timeout: 2000 }, id);
  assert.ok(Date.now() - t0 < 400, "moved on screen within the Doherty threshold (" + (Date.now() - t0) + "ms)");
  await p.waitForFunction(() => document.getElementById("toast")?.textContent === "Ticket moved", { timeout: 6000 });
  const stored = await p.evaluate((tid) => fetch("/api/tickets/" + tid).then((r) => r.json()), id);
  assert.equal(stored.ticket.column, "in-progress", "the server agreed");
  await p.close();
});

test("optimistic rollback: when the server refuses, the card goes back and an assertive error toast says so", { skip: SKIP, timeout: 90000 }, async () => {
  const p = await open("tickets");
  await p.waitForSelector(".ticket-col.st-submitted .ticket-card");
  const id = await p.$eval(".ticket-col.st-submitted .ticket-card", (c) => c.dataset.id);
  await tamper(p, /\/move$/, { delay: 300, fail: 500 });
  await p.select("#move-" + id, "done");
  await p.click('[data-act="ticket-move"][data-id="' + id + '"]');
  await p.waitForFunction((tid) => document.querySelector('.ticket-col.st-done .ticket-card[data-id="' + tid + '"]'), { timeout: 2000 }, id);
  await p.waitForFunction((tid) => document.querySelector('.ticket-col.st-submitted .ticket-card[data-id="' + tid + '"]'), { timeout: 5000 }, id);
  const toast = await p.evaluate(() => { const t = document.getElementById("toast"); return { kind: t.dataset.kind, live: t.getAttribute("aria-live"), text: t.textContent }; });
  assert.equal(toast.kind, "error"); assert.equal(toast.live, "assertive"); assert.match(toast.text, /Synthetic failure/);
  const counts = await p.$$eval(".ticket-col", (cols) => cols.map((c) => [c.dataset.column, +c.querySelector(".ticket-col-count").textContent, c.querySelectorAll(".ticket-card").length]));
  for (const [col, n, real] of counts) assert.equal(n, real, "count badge matches the cards in " + col);
  await p.close();
});

test("code pause is optimistic too: shows at once, and goes back with an error toast if the server says no", { skip: SKIP, timeout: 90000 }, async () => {
  const p = await open("qrcodes/spring-sale", { head: true });
  await p.waitForSelector('[data-act="pause"]');
  await tamper(p, /\/api\/codes\//, { delay: 400, fail: 500 });
  const t0 = Date.now();
  await p.evaluate(() => document.querySelector('[data-act="pause"]').click());
  await p.waitForFunction(() => document.getElementById("toast")?.textContent === "Paused", { timeout: 1500 });
  assert.ok(Date.now() - t0 < 400, "Paused is shown within 400ms (" + (Date.now() - t0) + "ms)");
  await p.waitForFunction(() => document.getElementById("toast")?.dataset.kind === "error", { timeout: 4000 });
  const stored = await p.evaluate(() => fetch("/api/codes/spring-sale").then((r) => r.json()));
  assert.ok(!(stored.code?.paused ?? stored.paused), "nothing was changed on the server");
  await p.close();
});

test("Hick and Miller: users rows keep Edit visible and tuck Invite/Remove into More; permissions and ticket details are labelled groups", { skip: SKIP, timeout: 90000 }, async () => {
  const u = await open("users");
  await u.waitForSelector('[data-act="user-edit"]');
  const row = await u.evaluate(() => { const tr = [...document.querySelectorAll('[data-testid="user-row"]')].find((r) => r.querySelector(".row-more")); const more = tr.querySelector(".row-more"); const b = more.querySelector("summary").getBoundingClientRect(); return { open: more.open, hidden: [...more.querySelectorAll('[data-act="user-remove"],[data-act="user-invite"]')].every((x) => !x.checkVisibility()), w: b.width, h: b.height }; });
  assert.equal(row.open, false); assert.ok(row.hidden, "rare actions are folded away until More is opened");
  assert.ok(row.w >= 44 && row.h >= 44, "More is a 44px target");
  await u.evaluate(() => document.querySelector('[data-act="user-add-open"]').click());
  await u.waitForSelector(".perm-group");
  const groups = await u.$$eval(".perm-group", (g) => g.length);
  assert.ok(groups >= 3, "permission rows are chunked into labelled groups (" + groups + ")");
  const sticky = await u.evaluate(() => { const f = document.querySelector(".form-actions"); return f ? getComputedStyle(f).position : ""; });
  assert.equal(sticky, "sticky", "Save stays in reach at the bottom of the form (Fitts)");
  await u.close();
  const p = await open("tickets");
  await p.waitForSelector(".ticket-card");
  const id = await p.$eval(".ticket-card", (c) => c.dataset.id);
  await p.close();
  const d = await open("tickets/" + id);
  await d.waitForSelector(".detail-group");
  const g = await d.$$eval(".detail-group", (all) => all.map((x) => [x.querySelector("summary").textContent.trim(), x.open]));
  assert.ok(g.length >= 5, "ticket detail is chunked (" + g.map((x) => x[0]).join(" | ") + ")");
  assert.ok(g.some(([, open]) => open) && g.some(([, open]) => !open), "the working groups are open and the rare ones (history, close out) are folded");
  await d.click(".detail-group:not([open]) summary");
  assert.equal(await d.$$eval(".detail-group[open]", (x) => x.length), g.filter(([, o]) => o).length + 1, "a folded group opens on click");
  await d.close();
});

test("Hick on a phone: ticket filters fold away until asked for; on desktop they are just there", { skip: SKIP, timeout: 90000 }, async () => {
  const m = await open("tickets", { w: 390, h: 844 });
  await m.waitForSelector(".filter-fold");
  const phone = await m.$eval(".filter-fold", (d) => ({ open: d.open, sum: d.querySelector("summary").checkVisibility(), h: d.querySelector("summary").getBoundingClientRect().height }));
  assert.equal(phone.open, false); assert.ok(phone.sum); assert.ok(phone.h >= 44, "filter toggle is a 44px target");
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll on a phone");
  await m.close();
  const d = await open("tickets", { w: 1440 });
  await d.waitForSelector(".filter-fold");
  const desk = await d.$eval(".filter-fold", (x) => ({ open: x.open, sum: x.querySelector("summary").checkVisibility() }));
  assert.equal(desk.open, true); assert.equal(desk.sum, false, "no extra click on desktop");
  await d.close();
});

test("Postel and Jakob in the ticket form: a messy email tidies on blur, and Enter in a single-line field submits", { skip: SKIP, timeout: 90000 }, async () => {
  const p = await open("tickets/new");
  await p.waitForSelector("#ticket-new-requester");
  const siteId = await p.$eval("#ticket-new-site option[value]:not([value=''])", (o) => o.value);
  await p.select("#ticket-new-site", siteId);
  await p.type("#ticket-new-subject", "Synthetic Enter submit");
  await p.type("#ticket-new-description", "Synthetic only.");
  await p.type("#ticket-new-requester", "  <Pat.Synthetic@Libertyretail.com.au> ");
  await p.focus("#ticket-new-subject");
  assert.equal(await p.$eval("#ticket-new-requester", (e) => e.value), "pat.synthetic@libertyretail.com.au", "tidied when the person leaves the field");
  assert.equal(await p.$eval(".form-actions", (f) => getComputedStyle(f).position), "sticky");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => location.hash.startsWith("#/tickets/") && !location.hash.endsWith("/new"), { timeout: 8000 });
  await p.waitForFunction(() => document.getElementById("toast")?.textContent === "Ticket created", { timeout: 5000 });
  await p.close();
});

test("Doherty: while a page loads there is a skeleton, not a bare 'Loading…', and it is marked busy", { skip: SKIP, timeout: 90000 }, async () => {
  const slow = `(() => { const real = window.fetch.bind(window); window.fetch = async (u, o) => { if (/\\/api\\/tickets(\\?|$)/.test(String(u))) await new Promise((r) => setTimeout(r, 1200)); return real(u, o); }; })();`;
  const p = await open("tickets", { init: slow });
  await p.reload();
  await p.waitForSelector(".skeleton", { timeout: 5000 });
  const busy = await p.evaluate(() => !!document.querySelector('[aria-busy="true"] .skeleton, .skeleton')?.closest("[aria-busy]"));
  assert.ok(busy, "the loading region is aria-busy");
  await p.waitForSelector(".ticket-card", { timeout: 8000 });
  assert.equal(await p.$(".skeleton"), null, "skeleton is gone when content arrives");
  await p.close();
});

test("the customer support form tidies phone and email input through the shared helper and keeps its own flow", () => {
  const html = fs.readFileSync("public/support/index.html", "utf8");
  assert.match(html, /from "\/admin\/ux\.mjs"/); assert.match(html, /wireTidyInputs\(document\.body\)/); assert.match(html, /formatPhone\(/); assert.match(html, /normaliseEmail\(/);
});
