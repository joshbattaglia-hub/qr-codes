import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
process.env.VISITOR_COLLECTION = "open";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.VISITOR_SHEETS_SPREADSHEET_ID;
delete process.env.VISITOR_SHEETS_CLIENT_EMAIL;
delete process.env.VISITOR_SHEETS_PRIVATE_KEY;

const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
const MAINT = "maint.one@libertyretail.com.au";
const MAINT2 = "maint.two@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [NEIL]: { approverKey: "neil", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
const bm = await import("../netlify/lib/building-maintenance.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const fn = async (name) => (await import("../netlify/functions/" + name + ".mjs")).default;
const publicFn = await fn("visitor-public");
const adminFn = await fn("visitor-admin");
const cleanupFn = await fn("visitor-cleanup");
const authFn = await fn("auth");
const otpFn = await fn("otp");
const identityFn = await fn("identity");
const ticketsFn = await fn("tickets");
const sitesFn = await fn("sites");
const posFn = await fn("pos-drafts");
const codesFn = await fn("codes");
const settingsFn = await fn("settings");
const vouchersFn = await fn("vouchers");
const staffFn = await fn("staff");
const otpMail = [];
let otpNow = Date.now();
otpLib.setOtpTestHooks({ now: () => otpNow, deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
const mail = [];
setMailTransport(async (message) => { mail.push(message); return { status: "sent", id: "fake" }; });

let ipSeq = 0;
function req(method, url, { cookie = "", body, origin } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  headers.set("x-nf-client-connection-ip", "2001:db8:b111::" + (++ipSeq).toString(16));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json() };
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), type };
}
async function otpCookie(email) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }));
  assert.equal(started.status, 200);
  const message = otpMail.slice(before).at(-1);
  if (!message) return "";
  const code = message.text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  if (verified.status !== 200) return "";
  return cookieNamed(verified, "qr_otp");
}
async function auditRows(action) {
  const { blobs } = await lib.visitorStore().list({ prefix: "audit/" });
  return (await Promise.all(blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).filter((row) => row && row.action === action);
}
function photoBytes() {
  return Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80).data);
}

let visitId = "";
let joshua = "";
test("setup: one synthetic visit; no building maintenance users by default; unknown addresses get no code", async () => {
  visitId = "v" + "ab12".repeat(8);
  const at = new Date().toISOString();
  await lib.visitorStore().setJSON("visit/" + visitId, { id: visitId, location: "Example Site", name: "Synthetic Visitor", phone: "0400 000 000", company: "Example Co", issues: "", signedInAt: at, signedOutAt: "", cardReturned: false, photoStatus: "stored", sheetSync: "pending", generation: 1 });
  await lib.visitorStore().setJSON("photo/" + visitId, { contentType: "image/jpeg", bytes: photoBytes().toString("base64"), storedAt: at });
  assert.deepEqual((await bm.readBuildingMaintenance()).emails, []);
  const before = otpMail.length;
  assert.equal(await otpCookie(MAINT), "");
  assert.equal(otpMail.length, before, "no code sent to an address that is not granted");
  joshua = await otpCookie(JOSHUA);
  assert.ok(joshua);
  const list = await read(await adminFn(req("GET", "/api/visitor-log/building-maintenance", { cookie: joshua })));
  assert.deepEqual(list.body, { users: [] });
});

test("only Joshua can list, add and remove building maintenance users; exact @libertyretail.com.au only", async () => {
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/building-maintenance")))).status, 401);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { body: { action: "add", email: MAINT } })))).status, 401);
  const head = cookieNamed(await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } })), "qr_admin");
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: head, body: { action: "add", email: MAINT } })))).status, 403);
  const neil = await otpCookie(NEIL);
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/building-maintenance", { cookie: neil })))).status, 403);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: neil, body: { action: "add", email: MAINT } })))).status, 403);
  assert.equal((await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, origin: "https://evil.example", body: { action: "add", email: MAINT } }))).status, 403);
  for (const bad of ["maint@example.com", "maint@sub.libertyretail.com.au", "maint@libertyretail.com.au.evil.com", "a,b@libertyretail.com.au", "a@b@libertyretail.com.au", "", "maint.@libertyretail.com.au"]) {
    const res = await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "add", email: bad } })));
    assert.equal(res.status, 400, bad);
  }
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "add", email: JOSHUA } })))).status, 400);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "grant", email: MAINT } })))).status, 400);
  assert.deepEqual((await bm.readBuildingMaintenance()).emails, []);
  const added = await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "add", email: " Maint.One@LibertyRetail.com.au " } })));
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body, { users: [MAINT], changed: true });
  const again = await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "add", email: MAINT } })));
  assert.equal(again.body.changed, false);
  const rows = await auditRows("maintenance-user-add");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, MAINT);
  assert.match(rows[0].actorId, /^otp:[a-f0-9]{16}$/);
  assert.equal(mail.length, 0, "no notification mail");
});

test("a building maintenance user signs in with an email code and can only view visits, records and ID photos", async () => {
  const maint = await otpCookie(MAINT);
  assert.ok(maint, "email-code sign-in works for a granted address");
  const session = await read(await identityFn(req("GET", "/api/identity/session", { cookie: maint })));
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.role, "building-maintenance");
  assert.equal(session.body.identity.email, MAINT);
  assert.deepEqual(session.body.identity.siteIds, []);
  const ready = await read(await adminFn(req("GET", "/api/visitor-log/readiness", { cookie: maint })));
  assert.equal(ready.body.granted, true);
  assert.equal(ready.body.role, "maintenance");
  const list = await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: maint })));
  assert.equal(list.status, 200);
  assert.equal(list.body.visits.length, 1);
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visitId, { cookie: maint })))).status, 200);
  const photo = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visitId + "/photo", { cookie: maint })));
  assert.equal(photo.status, 200);
  assert.equal(photo.type, "image/jpeg");
  const views = await auditRows("photo-view");
  assert.equal(views.length, 1);
  assert.equal(views[0].visitId, visitId);
  assert.equal(views[0].detail, "building maintenance " + MAINT);
  assert.ok(views[0].at);
  // Joshua's own photo views are logged with his address too.
  await adminFn(req("GET", "/api/visitor-log/visits/" + visitId + "/photo", { cookie: joshua }));
  assert.ok((await auditRows("photo-view")).some((row) => row.detail === JOSHUA));

  // Everything else in the Visitor Log is Joshua-only.
  const denied = [
    ["GET", "/api/visitor-log/export"],
    ["POST", "/api/visitor-log/visits/" + visitId + "/delete", { confirm: "DELETE" }],
    ["POST", "/api/visitor-log/visits/" + visitId + "/recover", {}],
    ["GET", "/api/visitor-log/settings"],
    ["POST", "/api/visitor-log/settings", { enabled: true, events: "both", recipient: MAINT }],
    ["GET", "/api/visitor-log/maintenance"],
    ["POST", "/api/visitor-log/maintenance", { numbers: ["0400 000 000"] }],
    ["GET", "/api/visitor-log/building-maintenance"],
    ["POST", "/api/visitor-log/building-maintenance", { action: "add", email: MAINT2 }],
    ["POST", "/api/visitor-log/sheet-check", { confirm: "CHECK" }],
    ["POST", "/api/visitor-log/sheet-photo-backfill", { confirm: "BACKFILL" }],
  ];
  for (const [method, url, body] of denied) {
    const res = await adminFn(req(method, url, { cookie: maint, body }));
    assert.equal(res.status, 403, method + " " + url);
  }
  assert.equal((await cleanupFn(req("POST", "/.netlify/functions/visitor-cleanup", { cookie: maint }))).status, 401);
  // No other admin area.
  assert.equal((await ticketsFn(req("GET", "/api/tickets/access", { cookie: maint }))).status, 403);
  assert.equal((await ticketsFn(req("GET", "/api/tickets", { cookie: maint }))).status, 403);
  assert.equal((await sitesFn(req("GET", "/api/sites", { cookie: maint }))).status, 403);
  assert.equal((await posFn(req("GET", "/api/pos-drafts", { cookie: maint }))).status, 403);
  assert.equal((await identityFn(req("GET", "/api/identity/status", { cookie: maint }))).status, 403);
  for (const [f, url] of [[codesFn, "/api/codes"], [settingsFn, "/api/settings"], [vouchersFn, "/api/vouchers"], [staffFn, "/api/staff"]]) {
    assert.equal((await f(req("GET", url, { cookie: maint }))).status, 401, url);
  }
  assert.equal((await authFn(req("GET", "/api/auth", { cookie: maint })).then((res) => res.json())).authenticated, false);
  // Nothing changed on the visit or settings.
  const visit = await lib.visitorStore().get("visit/" + visitId, { type: "json" });
  assert.equal(visit.deleted, undefined);
  assert.equal(await lib.visitorStore().get("notify/settings", { type: "json" }), null);
  assert.equal(mail.length, 0);
});

test("removing a user revokes access immediately and is logged; Neil keeps his own role if added", async () => {
  const maint = await otpCookie(MAINT);
  const removed = await read(await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "remove", email: MAINT } })));
  assert.deepEqual(removed.body, { users: [], changed: true });
  const rows = await auditRows("maintenance-user-remove");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, MAINT);
  // Removal deletes their email-code sessions, so the old cookie is simply signed out.
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: maint })))).status, 401);
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visitId + "/photo", { cookie: maint })))).status, 401);
  const session = await read(await identityFn(req("GET", "/api/identity/session", { cookie: maint })));
  assert.equal(session.body.authenticated, false);
  otpNow += 16 * 60 * 1000; // past the per-email start window
  const before = otpMail.length;
  assert.equal(await otpCookie(MAINT), "");
  assert.equal(otpMail.length, before);
  // An env-allowlisted approver added as building maintenance gains view-only Visitor Log access and keeps their own role.
  await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "add", email: NEIL } }));
  const neil = await otpCookie(NEIL);
  const neilSession = await read(await identityFn(req("GET", "/api/identity/session", { cookie: neil })));
  assert.equal(neilSession.body.role, "approver");
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/readiness", { cookie: neil })))).body.role, "maintenance");
  assert.equal((await adminFn(req("GET", "/api/visitor-log/export", { cookie: neil }))).status, 403);
  await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie: joshua, body: { action: "remove", email: NEIL } }));
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/readiness", { cookie: neil })))).body.role, "none");
});

test("privacy wording names view-only building maintenance access and photo-view logging", async () => {
  const status = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.match(status.body.notice, /people Joshua has given Visitor Log access in Users \(for example building maintenance\)/);
  assert.match(status.body.notice, /whether they can see the ID photo and whether they can change visitor log settings/);
  assert.match(status.body.notice, /Only Joshua can export or delete records or decide who has access/);
  assert.match(status.body.notice, /Every ID photo view is logged/);
  assert.equal(status.body.notice.includes("only Joshua's explicit visitor-log access can open these records"), false);
  assert.match(status.body.viewer, /view, view with ID photos, or settings/);
});
