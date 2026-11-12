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

// Synthetic data in the same shapes as production: OTP_ALLOWLIST object keyed by email, building maintenance list, ticket staff lists.
const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
const PREP = "prep.one@libertyretail.com.au";
const RBM = "rbm.one@libertyretail.com.au";
const OUTSIDE = "outside.preparer@example.com";
const MAINT = "maint.one@libertyretail.com.au";
const NEWBIE = "new.person@libertyretail.com.au";
const S1 = "s00000001", S2 = "s00000002", S3 = "s0000000a";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [S1, S2] },
  [NEIL]: { approverKey: "neil", siteIds: [S1] },
  [PREP]: { preparerClass: "jeremy", siteIds: [S2] },
  [RBM]: { preparerClass: "regional-business-manager", siteIds: [S1, S2, S1] },
  [OUTSIDE]: { preparerClass: "jeremy" },
  "dropped.bad@libertyretail.com.au": { approverKey: "neil" },
  "dropped.none@libertyretail.com.au": { siteIds: [S1] },
  "dropped.head@libertyretail.com.au": { role: "head", preparerClass: "jeremy" },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const usersLib = await import("../netlify/lib/users.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const fn = async (name) => (await import("../netlify/functions/" + name + ".mjs")).default;
const usersFn = await fn("users");
const adminFn = await fn("visitor-admin");
const authFn = await fn("auth");
const otpFn = await fn("otp");
const identityFn = await fn("identity");
const ticketsFn = await fn("tickets");
const sitesFn = await fn("sites");
const posFn = await fn("pos-drafts");
const deployFn = await fn("deploy-succeeded");
const otpMail = [];
let otpNow = Date.now();
otpLib.setOtpTestHooks({ now: () => otpNow, deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
visitLib.setVisitorTestHooks({ collect: true });
const mail = [];
setMailTransport(async (message) => { mail.push(message); return { status: "sent", id: "fake" }; });

let ipSeq = 0;
function req(method, url, { cookie = "", body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-nf-client-connection-ip", "2001:db8:a5e5::" + (++ipSeq).toString(16));
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
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}
async function otpCookie(email) {
  otpNow += 16 * 60 * 1000; // fresh rate window per sign-in in this synthetic run
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
async function session(cookie) {
  return (await read(await identityFn(req("GET", "/api/identity/session", { cookie })))).body;
}
const strip = (actor) => actor && ({ role: actor.role, approverKey: actor.approverKey, preparerClass: actor.preparerClass, siteIds: [...actor.siteIds].sort(), email: actor.email, id: actor.id });

let visitId = "";
test("setup: synthetic sites, building maintenance list, ticket staff and one visit", async () => {
  for (const id of [S1, S2, S3]) await lib.sitesStore().setJSON(id, { id, name: "Synthetic " + id, created: "2026-01-01T00:00:00.000Z" });
  await lib.visitorStore().setJSON("access/building-maintenance", { emails: [MAINT, NEIL], updatedAt: "2026-11-12T00:00:00.000Z" });
  await lib.ticketStore().setJSON("settings", { staff: { screens: [JOSHUA], signage: [JOSHUA, PREP, MAINT] } });
  visitId = "v" + "cd34".repeat(8);
  const at = new Date().toISOString();
  await lib.visitorStore().setJSON("visit/" + visitId, { id: visitId, location: "Example Site", name: "Synthetic Visitor", phone: "0400 000 000", company: "Example Co", issues: "", signedInAt: at, signedOutAt: "", cardReturned: false, photoStatus: "stored", generation: 1 });
  await lib.visitorStore().setJSON("photo/" + visitId, { contentType: "image/jpeg", bytes: Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80).data).toString("base64"), storedAt: at });
});

test("migration: effective access is identical before and after, for every address any source knows", async () => {
  // Before: derived from the old sources; actors match the old allowlist actor exactly.
  for (const email of [JOSHUA, NEIL, PREP, RBM, OUTSIDE]) {
    assert.deepEqual(strip(await otpLib.actorForEmail(email)), strip(otpLib.actorFromOtp(email)), email);
  }
  assert.equal(await otpLib.actorForEmail("dropped.bad@libertyretail.com.au"), null);
  assert.equal(await otpLib.actorForEmail("dropped.none@libertyretail.com.au"), null);
  const maintBefore = await otpLib.actorForEmail(MAINT);
  assert.equal(maintBefore.role, "building-maintenance");
  const proof = await usersLib.compareAccess((await usersLib.readUsers()).users, { visitorOwnerOk: true });
  assert.equal(proof.same, true, JSON.stringify(proof.diffs));
  assert.deepEqual(proof.before, proof.after);
  assert.deepEqual(proof.before, { logins: 6, approvers: 2, preparers: 4, limited: 1, visitorPhotos: 2, visitorOwner: 1, ticketStaff: 2, owners: 1 });
  // MAINT is on the signage staff list but had no ticket access (limited role); that must not change.
  assert.equal((await usersLib.effectiveAccess(MAINT, { legacy: true })).tickets, "none");
  // The proof does catch a change: letting MAINT into tickets would be reported, and migration would be blocked.
  const widened = (await usersLib.readUsers()).users.map((u) => (u.email === MAINT ? { ...u, ticketsEnabled: true } : u));
  const caught = await usersLib.compareAccess(widened, { visitorOwnerOk: true });
  assert.deepEqual([caught.same, caught.diffs], [false, [MAINT]]);
  // Deploy event writes the list once, with the proof; a second run is a no-op.
  const first = await read(await deployFn(new Request("https://expresshelp.site/.netlify/functions/deploy-succeeded", { method: "POST" })));
  assert.deepEqual(first.body, { status: "migrated", same: true, checked: proof.checked });
  const second = await read(await deployFn(new Request("https://expresshelp.site/.netlify/functions/deploy-succeeded", { method: "POST" })));
  assert.equal(second.body.status, "already");
  const stored = await usersLib.readUsers();
  assert.equal(stored.stored, true);
  assert.deepEqual(stored.users.map((u) => u.email), [JOSHUA, MAINT, NEIL, OUTSIDE, PREP, RBM].sort());
  // After: same actors, and the comparison against the old rules still holds.
  for (const email of [JOSHUA, NEIL, PREP, RBM, OUTSIDE]) {
    assert.deepEqual(strip(await otpLib.actorForEmail(email)), strip(otpLib.actorFromOtp(email)), email);
  }
  assert.equal((await usersLib.compareAccess(stored.users, { visitorOwnerOk: true })).same, true);
  // Old MAINT behaviour kept: no tickets even though listed on signage.
  const maint = await otpCookie(MAINT);
  assert.equal((await ticketsFn(req("GET", "/api/tickets/access", { cookie: maint }))).status, 403);
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/readiness", { cookie: maint })))).body.role, "maintenance");
  const neil = await otpCookie(NEIL);
  assert.equal((await session(neil)).role, "approver");
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/readiness", { cookie: neil })))).body.role, "maintenance");
});

let joshua = "";
test("Users endpoints: owner only, server-enforced", async () => {
  assert.equal((await usersFn(req("GET", "/api/users"))).status, 401);
  assert.equal((await usersFn(req("POST", "/api/users/save", { body: { mode: "add", email: NEWBIE, visitor: "view" } }))).status, 401);
  assert.equal((await usersFn(req("POST", "/api/users/remove", { body: { email: PREP } }))).status, 401);
  const head = cookieNamed(await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } })), "qr_admin");
  assert.equal((await usersFn(req("GET", "/api/users", { cookie: head }))).status, 403);
  for (const email of [NEIL, PREP, MAINT]) {
    const cookie = await otpCookie(email);
    assert.equal((await usersFn(req("GET", "/api/users", { cookie }))).status, 403, email);
    assert.equal((await usersFn(req("POST", "/api/users/save", { cookie, body: { mode: "add", email: NEWBIE, visitor: "view" } }))).status, 403, email);
  }
  joshua = await otpCookie(JOSHUA);
  const me = await session(joshua);
  assert.equal(me.identity.owner, true);
  const list = await read(await usersFn(req("GET", "/api/users", { cookie: joshua })));
  assert.equal(list.status, 200);
  assert.equal(list.body.migration.same, true);
  assert.equal(list.body.sites.length, 3);
  const prep = list.body.users.find((u) => u.email === PREP);
  assert.deepEqual([prep.posRole, prep.preparerClass, prep.siteIds, prep.visitor, prep.tickets], ["preparer", "jeremy", [S2], "none", ["signage"]]);
});

test("add, edit and remove a user; permissions enforced on every endpoint; changes logged old > new", async () => {
  const save = (body) => usersFn(req("POST", "/api/users/save", { cookie: joshua, body })).then(read);
  for (const [body, error] of [
    [{ mode: "add", email: "someone@example.com", visitor: "view" }, /exact @libertyretail\.com\.au/],
    [{ mode: "add", email: "x@sub.libertyretail.com.au", visitor: "view" }, /exact @libertyretail\.com\.au/],
    [{ mode: "add", email: NEWBIE, approverKey: "neil" }, /another address/],
    [{ mode: "add", email: NEWBIE, preparerClass: "joshua" }, /Joshua's only/],
    [{ mode: "add", email: NEWBIE, visitor: "everything" }, /Unknown Visitor Log level/],
    [{ mode: "add", email: NEWBIE, tickets: ["finance"] }, /Unknown ticket area/],
    [{ mode: "add", email: NEWBIE, preparerClass: "jeremy", siteIds: ["s99999999"] }, /Unknown site/],
    [{ mode: "add", email: NEWBIE }, /at least one permission/],
    [{ mode: "add", email: PREP, visitor: "view" }, /already exists/],
    [{ mode: "edit", email: JOSHUA, approverKey: "", preparerClass: "joshua" }, /owner's own roles/],
  ]) {
    const res = await save(body);
    assert.equal(res.status >= 400, true, JSON.stringify(body));
    assert.match(res.body.error, error);
  }
  assert.match((await read(await usersFn(req("POST", "/api/users/remove", { cookie: joshua, body: { email: JOSHUA } })))).body.error, /owner cannot be removed/);
  // Add: Visitor Log view without ID photos.
  const added = await save({ mode: "add", email: " New.Person@LibertyRetail.com.au ", visitor: "view" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  let cookie = await otpCookie(NEWBIE);
  assert.equal((await session(cookie)).role, "building-maintenance");
  assert.equal((await adminFn(req("GET", "/api/visitor-log/visits", { cookie }))).status, 200);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/visits/" + visitId, { cookie }))).status, 200);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/visits/" + visitId + "/photo", { cookie }))).status, 403);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/settings", { cookie }))).status, 403);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/export", { cookie }))).status, 403);
  assert.equal((await ticketsFn(req("GET", "/api/tickets/access", { cookie }))).status, 403);
  assert.equal((await sitesFn(req("GET", "/api/sites", { cookie }))).status, 403);
  assert.equal((await posFn(req("GET", "/api/pos-drafts", { cookie }))).status, 403);
  // Edit: settings level + signage tickets. Same session picks it up on the next request.
  const edited = await save({ mode: "edit", email: NEWBIE, visitor: "settings", tickets: ["signage"] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await adminFn(req("GET", "/api/visitor-log/visits/" + visitId + "/photo", { cookie }))).status, 200);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/settings", { cookie }))).status, 200);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/maintenance", { cookie }))).status, 200);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/export", { cookie }))).status, 403);
  assert.equal((await adminFn(req("POST", "/api/visitor-log/building-maintenance", { cookie, body: { action: "add", email: "x@libertyretail.com.au" } }))).status, 403);
  assert.equal((await usersFn(req("GET", "/api/users", { cookie }))).status, 403);
  const access = await read(await ticketsFn(req("GET", "/api/tickets/access", { cookie })));
  assert.equal(access.status, 200);
  assert.deepEqual([access.body.role, access.body.queues], ["staff", ["signage"]]);
  assert.ok((await lib.ticketStore().get("settings", { type: "json" })).staff.signage.includes(NEWBIE));
  // Edit an existing preparer: add a site and Visitor Log view.
  assert.equal((await save({ mode: "edit", email: PREP, preparerClass: "jeremy", siteIds: [S2, S3], visitor: "view", tickets: ["signage"] })).status, 200);
  assert.deepEqual((await otpLib.actorForEmail(PREP)).siteIds.sort(), [S2, S3]);
  // Remove: sessions end immediately, ticket areas cleared, logged.
  const removed = await read(await usersFn(req("POST", "/api/users/remove", { cookie: joshua, body: { email: NEWBIE } })));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.sessionsEnded >= 1, true);
  assert.equal((await adminFn(req("GET", "/api/visitor-log/visits", { cookie }))).status, 401);
  assert.equal((await session(cookie)).authenticated, false);
  assert.equal((await lib.ticketStore().get("settings", { type: "json" })).staff.signage.includes(NEWBIE), false);
  const before = otpMail.length;
  assert.equal(await otpCookie(NEWBIE), "");
  assert.equal(otpMail.length, before);
  const history = (await read(await usersFn(req("GET", "/api/users", { cookie: joshua })))).body.history;
  const actions = history.map((h) => h.action);
  for (const action of ["user-add", "user-edit", "user-remove", "migrate"]) assert.ok(actions.includes(action), action);
  const edit = history.find((h) => h.action === "user-edit" && h.target === NEWBIE);
  assert.equal(edit.detail, "pos=none sites=0 visitor=view tickets=none > pos=none sites=0 visitor=settings tickets=signage");
  assert.equal(edit.actorEmail, JOSHUA);
  assert.match(history.find((h) => h.action === "user-remove").detail, / > removed; sessions ended \d+$/);
  // No visitor mail was sent by any of this.
  assert.equal(mail.length, 0);
});
