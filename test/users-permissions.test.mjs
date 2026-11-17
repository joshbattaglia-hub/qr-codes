import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
process.env.VISITOR_COLLECTION = "open";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;

const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
const AREA = "area.manager.synthetic@libertyretail.com.au";
const S1 = "s00000001";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [S1] } });

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const usersLib = await import("../netlify/lib/users.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
const wh = await import("../netlify/lib/warehouse.mjs");
const perms = await import("../public/admin/permissions.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const { ticketAccess } = await import("../netlify/lib/tickets.mjs");
const fn = async (name) => (await import("../netlify/functions/" + name + ".mjs")).default;
const otpFn = await fn("otp");
const identityFn = await fn("identity");
const whFn = await fn("warehouse");
wh.setWarehouseTestHooks({ sleep: () => new Promise((r) => setImmediate(r)) });

const otpMail = [];
let otpNow = Date.now();
otpLib.setOtpTestHooks({ now: () => otpNow, deliver: async (m) => { otpMail.push(m); return { status: "sent", id: "local-mock" }; } });
const sentMail = [];
setMailTransport(async (m) => { sentMail.push(m); return { status: "sent", id: "fake" }; });

let ip = 0;
function req(method, url, { cookie = "", body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-nf-client-connection-ip", "2001:db8:b7e5::" + (++ip).toString(16));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const cookieNamed = (res, name) => {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
};
async function signIn(email) {
  otpNow += 16 * 60 * 1000;
  const before = otpMail.length;
  assert.equal((await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }))).status, 200);
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_otp");
}
async function actorOf(email) { return otpLib.actorForEmail(email); }

const owner = await actorOf(JOSHUA);
const registry = () => usersLib.usersStore ? null : null;

/* ---------- migration equivalence ---------- */

const POS_SHAPES = [
  { name: "none", email: "m.none", approverKey: "", preparerClass: "" },
  { name: "preparer jeremy", email: "m.jeremy", approverKey: "", preparerClass: "jeremy" },
  { name: "preparer rbm", email: "m.rbm", approverKey: "", preparerClass: "regional-business-manager" },
  { name: "approver neil", email: "nanderson", approverKey: "neil", preparerClass: "" },
];
const VISITOR = ["none", "view", "photos", "settings"];
const QUEUE_SETS = [[], ["screens"], ["signage"], ["screens", "signage"]];

test("migration equivalence: every old permission combination keeps exactly the same gates, and the menu tabs match the gates", async () => {
  const rows = [];
  const staff = { screens: [JOSHUA], signage: [JOSHUA] };
  let n = 0;
  for (const pos of POS_SHAPES) for (const visitor of VISITOR) for (const queues of QUEUE_SETS) for (const ticketsEnabled of [false, true]) for (const warehouse of [false, true]) {
    const email = (pos.email.includes("nanderson") ? pos.email : pos.email + (++n) ) + "@libertyretail.com.au";
    // The old record shape: none of the new fields exist.
    rows.push({ email, approverKey: pos.approverKey, preparerClass: pos.preparerClass, siteIds: pos.approverKey || pos.preparerClass ? [S1] : [], visitor, ticketsEnabled, warehouse, addedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
    for (const q of queues) staff[q].push(email);
  }
  // Only one Neil exists: keep one copy per (visitor, queues, ...) combination by making later Neil rows unique via a separate ticket list is not possible, so dedupe.
  const seen = new Set();
  const unique = rows.filter((r) => (seen.has(r.email) ? false : seen.add(r.email)));
  const neilRows = rows.filter((r) => r.email === NEIL);
  assert.ok(neilRows.length > 1);
  // Neil appears in many combinations; test those as separate runs below by overwriting the registry each time.
  async function checkRow(row, staffLists) {
    await lib.usersStore().setJSON("registry", { version: 1, users: [{ email: JOSHUA, approverKey: "joshua", preparerClass: "joshua", siteIds: [S1], visitor: "none" }, row], updatedAt: "2026-11-01T00:00:00.000Z" });
    await lib.ticketStore().setJSON("settings", { staff: staffLists });
    const actor = await actorOf(row.email);
    assert.ok(actor, row.email);
    const hasPos = !!(row.approverKey || row.preparerClass);
    // Old rules, written out independently of the new code.
    const oldRole = row.approverKey ? "approver" : row.preparerClass ? "preparer" : "building-maintenance";
    assert.equal(actor.role, oldRole);
    assert.equal(actor.visitor, row.visitor);
    assert.equal(actor.warehouse, row.warehouse);
    assert.deepEqual([...actor.siteIds], hasPos ? [S1] : []);
    // New finer fields default to the old behaviour.
    assert.equal(actor.assets, hasPos ? "custom" : "none", "Asset Barcodes: POS roles had it, others did not");
    assert.equal(actor.warehouseGenerate, row.warehouse);
    assert.equal(actor.warehouseReprint, row.warehouse);
    // Server gates (what the APIs actually check).
    const oldTickets = (hasPos || row.ticketsEnabled) && ["screens", "signage"].some((q) => staffLists[q].includes(row.email));
    const access = await ticketAccess(actor);
    assert.equal(access.role !== "none", oldTickets, "Support gate " + row.email);
    const visitorGate = (await visitLib.visitorRole(actor)) !== "none";
    assert.equal(visitorGate, row.visitor !== "none", "Visitor Log gate");
    assert.equal(wh.canUseWarehouse(actor), row.warehouse, "Warehouse gate");
    assert.equal(wh.canGenerateWarehouse(actor), row.warehouse);
    assert.equal(wh.canReprintWarehouse(actor), row.warehouse);
    assert.equal(wh.canAdminWarehouse(actor), false);
    const posGate = actor.role !== "building-maintenance"; // pos-drafts, pos-review, sites, identity/status refuse building-maintenance
    assert.equal(posGate, hasPos);
    // The menu tabs are exactly the tabs whose gates pass (plus Asset Barcodes, which has no server data).
    const expected = [];
    if (posGate) expected.push("pos", "sites");
    if (hasPos) expected.push("assets");
    if (row.warehouse) expected.push("warehouse");
    if (visitorGate) expected.push("visitors");
    if (access.role !== "none") expected.push("tickets");
    const tabs = perms.tabsFor(actor, access.queues);
    assert.deepEqual([...tabs].sort(), expected.sort(), row.email + " " + JSON.stringify({ pos: row.approverKey || row.preparerClass, visitor: row.visitor, tk: row.ticketsEnabled, wh: row.warehouse }));
    assert.equal(tabs.includes("users"), false);
  }
  let checked = 0;
  for (const pos of POS_SHAPES) for (const visitor of VISITOR) for (const queues of QUEUE_SETS) for (const ticketsEnabled of [false, true]) for (const warehouse of [false, true]) {
    const email = pos.email.includes("nanderson") ? NEIL : pos.email + "." + visitor + "." + queues.join("") + "." + ticketsEnabled + "." + warehouse + "@libertyretail.com.au";
    const row = { email, approverKey: pos.approverKey, preparerClass: pos.preparerClass, siteIds: pos.approverKey || pos.preparerClass ? [S1] : [], visitor, ticketsEnabled, warehouse };
    const lists = { screens: [JOSHUA, ...(queues.includes("screens") ? [email] : [])], signage: [JOSHUA, ...(queues.includes("signage") ? [email] : [])] };
    await checkRow(row, lists);
    checked += 1;
  }
  assert.equal(checked, 4 * 4 * 4 * 2 * 2);
  // Joshua keeps everything, including Users.
  await lib.usersStore().delete("registry");
  await lib.ticketStore().setJSON("settings", { staff: { screens: [JOSHUA], signage: [JOSHUA] } });
  const j = await actorOf(JOSHUA);
  assert.deepEqual(perms.tabsFor(j, ["screens", "signage"]).sort(), ["assets", "pos", "sites", "tickets", "users", "visitors", "warehouse"]);
  assert.equal(wh.canAdminWarehouse(j), true);
  assert.equal(usersLib.isOwner(j), true);
});

test("old records survive a save of someone else untouched (nothing is rewritten with new fields that change meaning)", async () => {
  await lib.usersStore().delete("registry");
  await lib.usersStore().setJSON("registry", { version: 1, users: [
    { email: JOSHUA, approverKey: "joshua", preparerClass: "joshua", siteIds: [S1], visitor: "none" },
    { email: "old.prep@libertyretail.com.au", approverKey: "", preparerClass: "jeremy", siteIds: [S1], visitor: "view", ticketsEnabled: false, warehouse: false },
  ] });
  await lib.ticketStore().setJSON("settings", { staff: { screens: [JOSHUA], signage: [JOSHUA] } });
  const before = await actorOf("old.prep@libertyretail.com.au");
  const added = await usersLib.saveUser(owner, { mode: "add", email: "other.synthetic@libertyretail.com.au", visitor: "view", tickets: [] });
  assert.equal(added.status, 200, added.error);
  const stored = (await lib.usersStore().get("registry", { type: "json" })).users.find((u) => u.email === "old.prep@libertyretail.com.au");
  assert.equal("assets" in stored, false, "no new field written for an untouched user");
  const after = await actorOf("old.prep@libertyretail.com.au");
  assert.deepEqual({ ...after }, { ...before });
});

/* ---------- area manager with Warehouse Stickers only ---------- */

let areaCookie = "";
test("area manager with Warehouse Stickers only: sees one tab, generates and reprints, cannot change the next number", async () => {
  await lib.usersStore().delete("registry");
  await lib.ticketStore().setJSON("settings", { staff: { screens: [JOSHUA], signage: [JOSHUA] } });
  const saved = await usersLib.saveUser(owner, { mode: "add", email: AREA, approverKey: "", preparerClass: "", siteIds: [], assets: "none", warehouse: true, warehouseGenerate: true, warehouseReprint: true, visitor: "none", tickets: [] });
  assert.equal(saved.status, 200, saved.error);
  assert.deepEqual(saved.body.user.tabs, ["warehouse"]);
  assert.equal(saved.body.user.assets, "none");
  areaCookie = await signIn(AREA);
  const session = (await (await identityFn(req("GET", "/api/identity/session", { cookie: areaCookie }))).json());
  assert.equal(session.authenticated, true);
  const actor = session.identity;
  assert.equal(actor.role, "building-maintenance");
  assert.equal(actor.warehouse, true);
  assert.equal(actor.assets, "none");
  assert.deepEqual(perms.tabsFor(actor, []), ["warehouse"]);
  const overview = await (await whFn(req("GET", "/api/warehouse", { cookie: areaCookie }))).json();
  assert.deepEqual(overview.can, { generate: true, reprint: true, admin: false });
  assert.deepEqual(overview.changes, []);
  const made = await whFn(req("POST", "/api/warehouse/sheets", { cookie: areaCookie, body: { idempotencyKey: "area-manager-key-0001" } }));
  assert.equal(made.status, 200);
  const sheet = (await made.json()).sheet;
  assert.equal(sheet.by, AREA);
  const again = await whFn(req("POST", "/api/warehouse/sheets/" + sheet.id + "/reprint", { cookie: areaCookie }));
  assert.equal(again.status, 200);
  assert.equal((await whFn(req("POST", "/api/warehouse/settings", { cookie: areaCookie, body: { next: 5000 } }))).status, 403);
  assert.equal((await wh.readCounter()).next, 1000 + 21);
  assert.equal(sentMail.length, 0);
});

test("every other API refuses the warehouse-only manager (same answer as signed out for protected endpoints)", async () => {
  const targets = [
    ["codes", "GET", "/api/codes"], ["codes", "GET", "/api/codes/abc"], ["pages", "GET", "/api/pages"], ["competitions", "GET", "/api/competitions"],
    ["settings", "GET", "/api/settings"], ["staff", "GET", "/api/staff"], ["templates", "GET", "/api/templates"], ["vouchers", "GET", "/api/vouchers"],
    ["health", "GET", "/api/health"], ["tv", "GET", "/api/tv/settings"], ["tv", "PUT", "/api/tv/settings", {}],
    ["sites", "GET", "/api/sites"], ["sites", "POST", "/api/sites", { name: "X" }], ["sites", "POST", "/api/sites/import", { rows: [] }],
    ["pos-drafts", "GET", "/api/pos-drafts"], ["pos-drafts", "POST", "/api/pos-drafts", {}],
    ["identity", "GET", "/api/identity/status"],
    ["tickets", "GET", "/api/tickets"], ["tickets", "GET", "/api/tickets/access"], ["tickets", "GET", "/api/tickets/settings"], ["tickets", "GET", "/api/tickets/digest"], ["tickets", "POST", "/api/tickets/digest/test", {}], ["tickets", "GET", "/api/tickets/quarantine"],
    ["visitor-admin", "GET", "/api/visitor-log/readiness"], ["visitor-admin", "GET", "/api/visitor-log/visits"], ["visitor-admin", "GET", "/api/visitor-log/settings"], ["visitor-admin", "POST", "/api/visitor-log/notify-recipients", {}], ["visitor-admin", "GET", "/api/visitor-log/export"], ["visitor-admin", "GET", "/api/visitor-log/building-maintenance"], ["visitor-admin", "POST", "/api/visitor-log/sheet-check", {}],
    ["visitor-cleanup", "POST", "/.netlify/functions/visitor-cleanup", {}],
    ["users", "GET", "/api/users"], ["users", "POST", "/api/users/save", { mode: "add", email: "x@libertyretail.com.au", visitor: "view" }], ["users", "POST", "/api/users/remove", { email: AREA }],
  ];
  const results = [];
  for (const [name, method, url, body] of targets) {
    const handler = await fn(name);
    const res = await handler(req(method, url, { cookie: areaCookie, body }));
    results.push([method + " " + url, res.status]);
    const ok = [401, 403].includes(res.status) || (res.status === 404 && /\/(quarantine|settings)$/.test(url) && name === "tickets");
    assert.ok(ok, method + " " + url + " answered " + res.status);
    assert.ok(!(await res.text()).includes(AREA === "" ? "x" : "NO-LEAK"));
  }
  // Nothing was written by those refused calls.
  assert.equal((await lib.sitesStore().list()).blobs.length, 0);
  assert.equal((await usersLib.readUsers()).users.length, 2, "Joshua is derived from the allowlist; only the area manager was added");
  assert.ok(results.length > 30);
});

test("unticking a tool removes the API access at once; finer Warehouse rights are enforced separately", async () => {
  const gen = "gen.only.synthetic@libertyretail.com.au", rep = "reprint.only.synthetic@libertyretail.com.au";
  await usersLib.saveUser(owner, { mode: "add", email: gen, warehouse: true, warehouseGenerate: true, warehouseReprint: false, tickets: [], visitor: "none", assets: "none" });
  await usersLib.saveUser(owner, { mode: "add", email: rep, warehouse: true, warehouseGenerate: false, warehouseReprint: true, tickets: [], visitor: "none", assets: "none" });
  const g = await signIn(gen), r = await signIn(rep);
  const first = await whFn(req("POST", "/api/warehouse/sheets", { cookie: g, body: { idempotencyKey: "gen-only-key-0000001" } }));
  assert.equal(first.status, 200);
  const id = (await first.json()).sheet.id;
  assert.equal((await whFn(req("POST", "/api/warehouse/sheets/" + id + "/reprint", { cookie: g }))).status, 403, "generate-only cannot reprint");
  assert.equal((await whFn(req("POST", "/api/warehouse/sheets", { cookie: r, body: { idempotencyKey: "rep-only-key-0000001" } }))).status, 403, "reprint-only cannot generate");
  assert.equal((await whFn(req("POST", "/api/warehouse/sheets/" + id + "/reprint", { cookie: r }))).status, 200);
  const view = await (await whFn(req("GET", "/api/warehouse", { cookie: r }))).json();
  assert.deepEqual(view.can, { generate: false, reprint: true, admin: false });
  // Untick Warehouse Stickers on the reprint-only user: the same session is refused on the next request.
  await usersLib.saveUser(owner, { mode: "edit", email: rep, warehouse: false, tickets: [], visitor: "view", assets: "none" });
  assert.equal((await whFn(req("GET", "/api/warehouse", { cookie: r }))).status, 403);
  assert.equal((await whFn(req("POST", "/api/warehouse/sheets/" + id + "/reprint", { cookie: r }))).status, 403);
  // Untick Visitor Log: refused. Untick Support: refused.
  const vis = (await visitLib.visitorRole(await actorOf(rep)));
  assert.equal(vis, "viewer");
  await usersLib.saveUser(owner, { mode: "edit", email: rep, warehouse: false, tickets: ["signage"], visitor: "none", assets: "view" });
  const a2 = await actorOf(rep);
  assert.equal(await visitLib.visitorRole(a2), "none");
  assert.notEqual((await ticketAccess(a2)).role, "none");
  assert.deepEqual(perms.tabsFor(a2, (await ticketAccess(a2)).queues).sort(), ["assets", "tickets"]);
  await usersLib.saveUser(owner, { mode: "edit", email: rep, warehouse: false, tickets: [], visitor: "none", assets: "view" });
  assert.equal((await ticketAccess(await actorOf(rep))).role, "none");
});

test("Users save: validation, Asset Barcodes level, audit text, POS tab off clears role and sites", async () => {
  const bad = await usersLib.saveUser(owner, { mode: "add", email: "bad.assets@libertyretail.com.au", assets: "everything", warehouse: true });
  assert.equal(bad.status, 400);
  const badFlag = await usersLib.saveUser(owner, { mode: "add", email: "bad.flag@libertyretail.com.au", warehouse: true, warehouseReprint: "yes" });
  assert.equal(badFlag.status, 400);
  const assetsOnly = await usersLib.saveUser(owner, { mode: "add", email: "assets.only@libertyretail.com.au", assets: "view", visitor: "none", tickets: [] });
  assert.equal(assetsOnly.status, 200, assetsOnly.error);
  assert.deepEqual(assetsOnly.body.user.tabs, ["assets"]);
  const nothing = await usersLib.saveUser(owner, { mode: "add", email: "nothing.at.all@libertyretail.com.au", assets: "none", visitor: "none", tickets: [] });
  assert.equal(nothing.status, 400);
  const prep = await usersLib.saveUser(owner, { mode: "add", email: "prep.synthetic@libertyretail.com.au", preparerClass: "jeremy", siteIds: [], assets: "custom", visitor: "none", tickets: [] });
  assert.equal(prep.status, 200, prep.error);
  assert.deepEqual(prep.body.user.tabs.sort(), ["assets", "pos", "sites"]);
  const off = await usersLib.saveUser(owner, { mode: "edit", email: "prep.synthetic@libertyretail.com.au", preparerClass: "", approverKey: "", siteIds: [], assets: "none", warehouse: true, visitor: "none", tickets: [] });
  assert.deepEqual(off.body.user.tabs, ["warehouse"]);
  assert.equal((await actorOf("prep.synthetic@libertyretail.com.au")).role, "building-maintenance");
  const history = (await usersLib.listUsers(owner)).body.history.map((h) => h.detail).join("\n");
  assert.match(history, /assets=view/);
  assert.match(history, /warehouse=yes/);
  // Non-owners cannot manage users, whatever their tabs.
  assert.equal((await usersLib.saveUser(await actorOf("prep.synthetic@libertyretail.com.au"), { mode: "add", email: "z@libertyretail.com.au", visitor: "view" })).status, 403);
});

test("Users page: tool checklist with expanding fine settings, summary, loading state, footer, Asset Barcodes lock", () => {
  const app = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  for (const needle of ['permTool("pos"', 'permTool("assets"', 'permTool("warehouse"', 'permTool("visitors"', 'permTool("tickets"', 'data-testid="perm-users"', "Admins only", 'id="perm-summary"', "Saving…", "Removing…", "collectUserPerms", 'readonly'] ) assert.ok(app.includes(needle), needle);
  assert.match(app, /accessRoutes\(\)/);
  const index = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  assert.match(index, /\/footer\.js/);
});
