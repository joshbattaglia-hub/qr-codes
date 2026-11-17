import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const JOSHUA = "jbattaglia@libertyretail.com.au";
const WH = "warehouse.synthetic@libertyretail.com.au";
const OTHER = "visitor.synthetic@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] } });

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const mail = await import("../netlify/lib/mail.mjs");
const sent = [];
mail.setMailTransport(async (m) => { sent.push(m); return { status: "sent", id: "x" }; });
const wh = await import("../netlify/lib/warehouse.mjs");
const usersLib = await import("../netlify/lib/users.mjs");
const otpLib = await import("../netlify/lib/otp.mjs");
const ui = await import("../public/admin/warehouse-ui.mjs");
const code39 = await import("../public/admin/code39.mjs");
const whFn = (await import("../netlify/functions/warehouse.mjs")).default;
wh.setWarehouseTestHooks({ sleep: () => new Promise((r) => setImmediate(r)) });

const head = { role: "head", id: "head-office", siteIds: null, name: "Head office" };
const owner = await otpLib.actorForEmail(JOSHUA);
const store = () => lib.warehouseStore();
async function reset() {
  for (const b of (await store().list()).blobs) await store().delete(b.key);
}
let n = 0;
const key = () => "test-key-" + (++n).toString().padStart(6, "0");

test("codes: WH prefix, no zero padding, 9999 rolls to 10000", () => {
  assert.equal(wh.codeFor(1000), "WH1000");
  assert.deepEqual(wh.codesFor(9998, 10001), ["WH9998", "WH9999", "WH10000", "WH10001"]);
  assert.equal(wh.LABEL_SHEET.perSheet, 21);
});

test("first sheet is WH1000-WH1020, next continues at WH1021; counter starts at 1000 untouched until a press", async () => {
  await reset();
  assert.equal((await wh.readCounter()).next, 1000);
  assert.equal((await wh.readCounter()).exists, false, "reading does not create or move the counter");
  const a = await wh.issueSheet(head, { idempotencyKey: key() });
  assert.equal(a.status, 200);
  assert.equal(a.body.sheet.first, "WH1000");
  assert.equal(a.body.sheet.last, "WH1020");
  assert.equal(a.body.codes.length, 21);
  const b = await wh.issueSheet(owner, { idempotencyKey: key() });
  assert.equal(b.body.sheet.first, "WH1021");
  assert.equal(b.body.sheet.by, JOSHUA);
  assert.equal(a.body.sheet.by, "Head office");
  assert.equal((await wh.readCounter()).next, 1042);
});

test("parallel race: 25 concurrent presses get 25 disjoint ranges, no gaps or duplicates", async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 25 }, () => wh.issueSheet(head, { idempotencyKey: key() })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.find((r) => r.status !== 200)));
  const all = results.flatMap((r) => r.body.codes);
  assert.equal(new Set(all).size, 25 * 21, "no duplicates");
  const nums = all.map((c) => Number(c.slice(2))).sort((x, y) => x - y);
  assert.equal(nums[0], 1000);
  assert.equal(nums.at(-1), 1000 + 25 * 21 - 1, "contiguous");
  assert.equal((await wh.readCounter()).next, 1000 + 25 * 21);
  assert.equal((await wh.listSheets()).total, 25);
});

test("idempotency: a double click or retry with the same key burns one sheet only", async () => {
  await reset();
  const k = key();
  const results = await Promise.all(Array.from({ length: 6 }, () => wh.issueSheet(head, { idempotencyKey: k })));
  const ok = results.filter((r) => r.status === 200);
  assert.ok(ok.length >= 1);
  assert.ok(ok.every((r) => r.body.sheet.first === "WH1000"));
  assert.equal((await wh.readCounter()).next, 1021);
  const retry = await wh.issueSheet(head, { idempotencyKey: k });
  assert.equal(retry.body.replay, true);
  assert.equal(retry.body.sheet.first, "WH1000");
  assert.equal((await wh.readCounter()).next, 1021);
  assert.equal((await wh.issueSheet(head, { idempotencyKey: "short" })).status, 400);
  // Same key from a different person is a different press.
  const other = await wh.issueSheet(owner, { idempotencyKey: k });
  assert.equal(other.body.sheet.first, "WH1021");
});

test("reprint returns exactly the stored range and never touches the counter", async () => {
  await reset();
  const a = await wh.issueSheet(head, { idempotencyKey: key() });
  await wh.issueSheet(head, { idempotencyKey: key() });
  const before = await wh.readCounter();
  const r = await wh.reprintSheet(head, a.body.sheet.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.codes, a.body.codes);
  assert.equal(r.body.sheet.reprints, 1);
  const after = await wh.readCounter();
  assert.equal(after.next, before.next);
  assert.equal(after.etag, before.etag, "counter blob not rewritten");
  assert.equal((await wh.reprintSheet(head, "999999")).status, 404);
  const changes = await wh.listChanges();
  assert.equal(changes[0].action, "reprint");
  assert.equal(changes[0].first, "WH1000");
});

test("admin next number: forward only, backward needs explicit override, every change logged, admins only", async () => {
  await reset();
  await wh.issueSheet(head, { idempotencyKey: key() }); // WH1000-1020 issued, next 1021
  assert.equal((await wh.setNextNumber(head, { next: "abc" })).status, 400);
  const fwd = await wh.setNextNumber(owner, { next: "WH1500" });
  assert.equal(fwd.status, 200);
  assert.equal(fwd.body.nextCode, "WH1500");
  const back = await wh.setNextNumber(owner, { next: 1010 });
  assert.equal(back.status, 409);
  assert.equal(back.needsConfirm, true);
  assert.match(back.error, /WH1020/);
  assert.equal((await wh.readCounter()).next, 1500, "refused change left the number alone");
  const forced = await wh.setNextNumber(head, { next: 1100, confirmBackward: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.override, true);
  const log = (await wh.listChanges()).filter((c) => c.action === "set-next");
  assert.equal(log.length, 2);
  assert.ok(log.some((c) => c.fromCode === "WH1021" && c.toCode === "WH1500" && c.override === false && c.by === JOSHUA));
  assert.ok(log.some((c) => c.fromCode === "WH1500" && c.toCode === "WH1100" && c.override === true));
  const next = await wh.issueSheet(head, { idempotencyKey: key() });
  assert.equal(next.body.sheet.first, "WH1100");
});

test("access: Users 'Warehouse Stickers' permission alone grants only this tool; admins can also change settings", async () => {
  await reset();
  // A warehouse-only user is accepted by the Users save (previously at least one other permission was required).
  const saved = await usersLib.saveUser(owner, { mode: "add", email: WH, visitor: "none", tickets: [], warehouse: true });
  assert.equal(saved.status, 200, saved.error);
  assert.equal(saved.body.user.warehouse, true);
  const noPerm = await usersLib.saveUser(owner, { mode: "add", email: "nothing.synthetic@libertyretail.com.au", visitor: "none", tickets: [] });
  assert.equal(noPerm.status, 400);
  const whActor = await otpLib.actorForEmail(WH);
  assert.equal(whActor.role, "building-maintenance", "limited role: no POS, sites or identity admin");
  assert.equal(whActor.warehouse, true);
  assert.equal(whActor.visitor, "none");
  assert.equal(wh.canUseWarehouse(whActor), true);
  assert.equal(wh.canAdminWarehouse(whActor), false);
  const issued = await wh.issueSheet(whActor, { idempotencyKey: key() });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.sheet.by, WH);
  assert.equal((await wh.setNextNumber(whActor, { next: 5000 })).status, 403);
  const view = await wh.warehouseOverview(whActor);
  assert.equal(view.body.canAdmin, false);
  assert.deepEqual(view.body.changes, []);
  // Other limited users and site managers are refused.
  await usersLib.saveUser(owner, { mode: "add", email: OTHER, visitor: "view", tickets: [] });
  const other = await otpLib.actorForEmail(OTHER);
  assert.equal(other.warehouse, false);
  assert.equal((await wh.issueSheet(other, { idempotencyKey: key() })).status, 403);
  assert.equal((await wh.issueSheet({ role: "manager", id: "m1", siteIds: [] }, { idempotencyKey: key() })).status, 403);
  assert.equal((await wh.warehouseOverview(null)).status, 403);
  // Changing Visitor Log level keeps the warehouse permission, and clearing visitor access does not remove a warehouse user.
  await usersLib.setVisitorLevel(owner, WH, "view");
  assert.equal((await usersLib.userFor(WH)).warehouse, true);
  await usersLib.setVisitorLevel(owner, WH, "none");
  assert.equal((await usersLib.userFor(WH)).warehouse, true);
  // Removing the permission ends access at once.
  await usersLib.saveUser(owner, { mode: "edit", email: WH, visitor: "view", tickets: [], warehouse: false });
  assert.equal(wh.canUseWarehouse(await otpLib.actorForEmail(WH)), false);
  const audit = (await usersLib.listUsers(owner)).body.history.map((h) => h.detail).join("\n");
  assert.match(audit, /warehouse=yes/);
  assert.equal(sent.length, 0, "no mail");
});

test("endpoints: 401 signed out; cross-site POST refused", async () => {
  const get = await whFn(new Request("https://expresshelp.site/api/warehouse"));
  assert.equal(get.status, 401);
  assert.equal(get.headers.get("cache-control"), "private, no-store");
  const post = await whFn(new Request("https://expresshelp.site/api/warehouse/sheets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: key() }) }));
  assert.equal(post.status, 401);
  const cross = await whFn(new Request("https://expresshelp.site/api/warehouse/sheets", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }));
  assert.equal(cross.status, 403);
});

test("print sheet: Avery L7160 geometry, 21 labels, Asset Barcodes Code 39 look, readable code under each barcode", () => {
  const codes = wh.codesFor(1000, 1020);
  const html = ui.sheetHtml(codes);
  assert.match(html, /@page\{size:A4 portrait;margin:0\}/);
  assert.match(html, /padding:15\.15mm 7\.21mm 0/);
  assert.match(html, /grid-template-columns:repeat\(3,63\.5mm\)/);
  assert.match(html, /grid-auto-rows:38\.1mm/);
  assert.match(html, /column-gap:2\.54mm/);
  assert.equal((html.match(/class="label"/g) || []).length, 21);
  // Template arithmetic: margins + labels + gaps = A4.
  const t = ui.L7160;
  assert.ok(Math.abs(t.sideMarginMm * 2 + t.labelWidthMm * 3 + t.columnGapMm * 2 - 210) < 0.05);
  assert.ok(Math.abs(t.topMarginMm * 2 + t.labelHeightMm * 7 - 297) < 0.05);
  assert.ok(Math.abs(t.columnPitchMm - (t.labelWidthMm + t.columnGapMm)) < 0.01);
  assert.deepEqual({ ...ui.L7160, name: undefined }, { ...wh.LABEL_SHEET, name: undefined }, "client and server agree on the sheet");
  // Same encoder and look as Asset Barcodes: identical SVG for the same code and layout.
  const layout = ui.stickerLayout("WH1000");
  assert.equal(layout.moduleMm, code39.CODE39_DEFAULTS.moduleMm);
  assert.equal(layout.barHeightMm, code39.CODE39_DEFAULTS.barHeightMm);
  const svg = ui.stickerSvg("WH1000");
  assert.equal(svg, code39.code39Svg("WH1000", layout, code39.CODE39_DEFAULTS.heading).svg);
  assert.match(svg, />WH1000<\/text>/);
  // Fits inside the label with quiet zones, up to WH999999 at full size; longer codes shrink the module but stay >= 0.25 mm.
  for (const c of ["WH1000", "WH10000", "WH999999", "WH1000000", "WH999999999"]) {
    const l = ui.stickerLayout(c);
    const drawn = code39.code39Svg(c, l, code39.CODE39_DEFAULTS.heading);
    assert.ok(drawn.widthMm <= 60.001 && drawn.heightMm <= 38.1, c + " fits");
    assert.deepEqual(drawn.notes, [], c + " no overflow");
    assert.ok(l.moduleMm >= 0.25);
  }
  assert.equal(ui.stickerLayout("WH999999").moduleMm, 0.33);
  assert.equal(code39.code39Bits("WH1000").startsWith("100010111011101"), true, "Code 39 start char");
});

test("UI: one main button with loading state, history with Reprint, admin settings only for admins, footer and nav", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../public/admin/warehouse-ui.mjs", import.meta.url), "utf8");
  assert.match(src, /Generate next sheet of stickers/);
  assert.match(src, /button\.disabled = true/);
  assert.match(src, /Generating…/);
  assert.match(src, /idempotencyKey: pendingKey/);
  assert.match(src, /data-act="wh-reprint"/);
  assert.match(src, /data\.canAdmin \?/);
  const index = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  assert.match(index, /data-go="assets"[^]*Asset Barcodes<\/button>\s*<button type="button" data-go="warehouse"/);
  assert.match(index, /\/footer\.js/);
  const app = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  assert.match(app, /tabsFor\(a, /);
  assert.match(app, /id="perm-" + key|id="user-wh-generate"/);
});
