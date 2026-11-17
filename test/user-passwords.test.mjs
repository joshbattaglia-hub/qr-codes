import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ADMIN_PASSWORD = "test-pass-synthetic";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
process.env.VISITOR_COLLECTION = "open";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] } });

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const usersLib = await import("../netlify/lib/users.mjs");
const cred = await import("../netlify/lib/credentials.mjs");
const mailLib = await import("../netlify/lib/mail.mjs");
const fn = async (name) => (await import("../netlify/functions/" + name + ".mjs")).default;
const passwordFn = await fn("password");
const identityFn = await fn("identity");
const usersFn = await fn("users");
const whFn = await fn("warehouse");
const authFn = await fn("auth");
const otpFn = await fn("otp");
const entraFn = await fn("entra");
const sitesFn = await fn("sites");

const sent = [];
let failNext = null;
mailLib.setMailTransport(async (m) => { sent.push(m); return { status: failNext || "sent", id: "mock" }; });
let t = Date.parse("2026-11-18T08:00:00+11:00");
cred.setCredentialsTestHooks({ now: () => t });
const HOUR = 3600e3;

let ip = 0;
function req(method, url, { cookie = "", body, source } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-nf-client-connection-ip", source || "2001:db8:c0de::" + (++ip).toString(16));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const post = (handler, url, body, extra = {}) => handler(req("POST", url, { body, ...extra }));
const cookieOf = (res) => {
  const row = (res.headers.getSetCookie?.() || []).find((x) => x.startsWith("qr_otp=") && !x.startsWith("qr_otp=;"));
  return row ? row.split(";")[0] : "";
};
const invites = () => sent.filter((m) => /Set your Express Help password/.test(m.subject));
const resets = () => sent.filter((m) => /Reset your Express Help password/.test(m.subject));
const linkOf = (m) => m.text.match(/https:\/\/expresshelp\.site\/set-password#(\S+)/)[1];
const owner = await otpLib.actorForEmail(JOSHUA);
const GOOD = "correct horse battery";

async function addUser(email, extra = {}) {
  const before = invites().length;
  const res = await usersLib.saveUser(owner, { mode: "add", email, visitor: "none", tickets: [], assets: "none", warehouse: true, ...extra });
  assert.equal(res.status, 200, res.error);
  return { res, mail: invites().slice(before) };
}
async function setPw(token, password) { return post(passwordFn, "/api/identity/password/set", { token, password }); }
async function login(email, password, extra = {}) { return post(passwordFn, "/api/identity/password/login", { email, password }, extra); }

test("adding a user sends exactly one invite to that address; edits and existing users send nothing", async () => {
  await lib.usersStore().delete("registry");
  const listed = await usersLib.listUsers(owner);
  assert.equal(listed.status, 200);
  assert.equal(sent.length, 0, "opening Users (and the first-time migration) emails nobody");
  const { res, mail } = await addUser("invitee.one@libertyretail.com.au");
  assert.equal(res.body.invite.status, "sent");
  assert.equal(mail.length, 1);
  assert.deepEqual(sent.map((m) => m.to), ["invitee.one@libertyretail.com.au"]);
  const m = mail[0];
  assert.equal(m.subject, "Set your Express Help password");
  assert.match(m.text, /works once and expires in 72 hours/);
  assert.match(m.html, /Cowabunga - please hesitate to reach out/);
  assert.match(m.html, /mailto:jbattaglia@libertyretail\.com\.au/);
  assert.match(m.text, /Cowabunga - please hesitate to reach out email me here: mailto:jbattaglia@libertyretail\.com\.au/);
  assert.match(m.idempotencyKey, /^invite-t[a-f0-9]{24}$/);
  const edit = await usersLib.saveUser(owner, { mode: "edit", email: "invitee.one@libertyretail.com.au", visitor: "view", tickets: [], assets: "none", warehouse: true });
  assert.equal(edit.status, 200);
  assert.equal("invite" in edit.body, false);
  assert.equal(invites().length, 1, "edit sends nothing");
  const duplicate = await usersLib.saveUser(owner, { mode: "add", email: "invitee.one@libertyretail.com.au", visitor: "view" });
  assert.equal(duplicate.status, 409);
  assert.equal(invites().length, 1);
});

test("the link is 32 random bytes; only a SHA-256 of the secret is stored; no password or secret in storage or audit", async () => {
  const token = linkOf(invites()[0]);
  const [id, secret] = token.split(".");
  assert.match(id, /^t[a-f0-9]{24}$/);
  assert.equal(Buffer.from(secret, "base64url").length, 32);
  const store = lib.credStore();
  const { blobs } = await store.list();
  for (const blob of blobs) assert.equal(JSON.stringify(await store.get(blob.key, { type: "json" })).includes(secret), false, blob.key);
  const row = await store.get("tok/" + id, { type: "json" });
  assert.match(row.digest, /^[a-f0-9]{64}$/);
  assert.equal(row.exp - row.createdAt, 72 * HOUR);
  const audit = JSON.stringify((await usersLib.listUsers(owner)).body.history);
  assert.equal(audit.includes(secret), false);
  assert.match(audit, /user-invite/);
});

test("expiry: an invite lasts 72 hours, a reset link lasts 1 hour", async () => {
  const token = linkOf(invites()[0]);
  t += 71 * HOUR;
  assert.equal((await cred.peekLink(token)).ok, true);
  t += 2 * HOUR; // 73h
  assert.deepEqual(await cred.peekLink(token), { ok: false, reason: "expired" });
  const checked = await (await post(passwordFn, "/api/identity/password/link", { token })).json();
  assert.deepEqual([checked.valid, checked.reason], [false, "expired"]);
  assert.equal((await setPw(token, GOOD)).status, 400);
  assert.equal((await cred.passwordStatus("invitee.one@libertyretail.com.au")).state, "expired");
  assert.equal((await cred.hasPassword("invitee.one@libertyretail.com.au")), false);
  // reset: 59 minutes ok, 61 minutes expired
  const before = resets().length;
  await post(passwordFn, "/api/identity/password/forgot", { email: "invitee.one@libertyretail.com.au" });
  const reset = linkOf(resets()[before]);
  t += 59 * 60e3;
  assert.equal((await cred.peekLink(reset)).ok, true);
  t += 2 * 60e3;
  assert.equal((await cred.peekLink(reset)).reason, "expired");
});

test("single use, constant-time compare of a hash, tampered links refused, and a parallel double submit has one winner", async () => {
  const { mail } = await addUser("invitee.two@libertyretail.com.au");
  const token = linkOf(mail[0]);
  const [id, secret] = token.split(".");
  for (const bad of ["", "nope", id + ".", id + "." + secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A"), "t" + "0".repeat(24) + "." + secret]) {
    const res = await setPw(bad, GOOD);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).error, "This link is not valid. Ask for a new one.");
  }
  const [a, b] = await Promise.all([setPw(token, GOOD), setPw(token, "another long passphrase")]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal((await setPw(token, "third passphrase here")).status, 400, "used link stays dead");
  assert.equal((await cred.peekLink(token)).reason, "used");
  const winner = a.status === 200 ? GOOD : "another long passphrase";
  assert.equal((await login("invitee.two@libertyretail.com.au", winner)).status, 200);
  assert.equal((await cred.passwordStatus("invitee.two@libertyretail.com.au")).state, "active");
});

test("resend invalidates the earlier link; a newer reset replaces an older reset; setting a password kills every other link", async () => {
  const email = "invitee.three@libertyretail.com.au";
  const { mail } = await addUser(email);
  const first = linkOf(mail[0]);
  const again = await usersLib.resendInvite(owner, { email });
  assert.equal(again.status, 200);
  assert.equal(again.body.password.state, "invited");
  const second = linkOf(invites().at(-1));
  assert.notEqual(first, second);
  assert.equal((await cred.peekLink(first)).ok, false, "old invite dead");
  assert.equal((await cred.peekLink(second)).ok, true);
  await post(passwordFn, "/api/identity/password/forgot", { email });
  await post(passwordFn, "/api/identity/password/forgot", { email });
  const r1 = linkOf(resets().at(-2)), r2 = linkOf(resets().at(-1));
  assert.equal((await cred.peekLink(r1)).ok, false);
  assert.equal((await cred.peekLink(r2)).ok, true);
  assert.equal((await cred.peekLink(second)).ok, true, "a reset request does not cancel the invite");
  assert.equal((await setPw(second, GOOD)).status, 200);
  assert.equal((await cred.peekLink(r2)).ok, false, "setting a password cancels the open reset link");
});

test("resend invite: owner only, only for listed users, rate limited, nothing sent to others", async () => {
  const email = "invitee.four@libertyretail.com.au";
  await addUser(email);
  const before = sent.length;
  const normal = await otpLib.actorForEmail(email);
  assert.equal((await usersLib.resendInvite(normal, { email })).status, 403);
  assert.equal((await usersLib.resendInvite(owner, { email: "not.on.the.list@libertyretail.com.au" })).status, 404);
  assert.equal((await usersLib.resendInvite(owner, { email: "" })).status, 400);
  assert.equal(sent.length, before);
  // endpoint is owner-only for signed-out callers too
  assert.equal((await post(usersFn, "/api/users/invite", { email })).status, 401);
  let ok = 0, limited = 0;
  for (let i = 0; i < 7; i++) { const r = await usersLib.resendInvite(owner, { email }); if (r.status === 200) ok += 1; else if (r.status === 429) limited += 1; }
  assert.equal(ok + limited, 7);
  assert.ok(limited >= 2, "5 per hour per address");
  assert.ok(sent.slice(before).every((m) => m.to === email));
});

test("password hashing: scrypt with a per-user salt; never stored or returned in clear", async () => {
  await cred.writePassword("salt.a@libertyretail.com.au", GOOD);
  await cred.writePassword("salt.b@libertyretail.com.au", GOOD);
  const a = await cred.storedHash("salt.a@libertyretail.com.au"), b = await cred.storedHash("salt.b@libertyretail.com.au");
  assert.match(a, /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.equal(a.includes(GOOD), false);
  assert.equal(await cred.verifyPasswordHash(GOOD, a), true);
  assert.equal(await cred.verifyPasswordHash(GOOD + "x", a), false);
  assert.equal(await cred.verifyPasswordHash(GOOD, ""), false);
  assert.equal(await cred.verifyPasswordHash(GOOD, "plain-text"), false);
  const { blobs } = await lib.credStore().list();
  for (const blob of blobs) assert.equal(JSON.stringify(await lib.credStore().get(blob.key, { type: "json" })).includes(GOOD), false);
});

test("password policy: length, email, common passwords, repetition", () => {
  const email = "someone.long@libertyretail.com.au";
  assert.match(cred.passwordProblem("short1", email), /at least 10/);
  assert.match(cred.passwordProblem("x".repeat(129), email), /at most 128/);
  assert.match(cred.passwordProblem(email, email), /email/);
  assert.match(cred.passwordProblem("someone.long12345", email), /email name/);
  assert.match(cred.passwordProblem("Password123", email), /too common/);
  assert.match(cred.passwordProblem("1234567890", email), /too common/);
  assert.match(cred.passwordProblem("aaaaaaaaaaaa", email), /repetitive/);
  assert.equal(cred.passwordProblem(GOOD, email), "");
  assert.equal(cred.passwordProblem("a long passphrase with spaces", email), "");
});

test("bad passwords do not burn the link; good ones do", async () => {
  const { mail } = await addUser("invitee.five@libertyretail.com.au");
  const token = linkOf(mail[0]);
  const weak = await setPw(token, "password123");
  assert.equal(weak.status, 422);
  assert.equal((await cred.peekLink(token)).ok, true);
  assert.equal((await setPw(token, "short")).status, 422);
  assert.equal((await setPw(token, GOOD)).status, 200);
});

test("password sign-in: same email-code session and permissions (warehouse-only user), generic errors, no user enumeration", async () => {
  const email = "area.pw.synthetic@libertyretail.com.au";
  const { mail } = await addUser(email, { warehouse: true, warehouseGenerate: true, warehouseReprint: true });
  assert.equal((await login(email, GOOD)).status, 401, "no password yet");
  assert.equal((await setPw(linkOf(mail[0]), GOOD)).status, 200);
  const wrong = await login(email, "wrong password here");
  const unknown = await login("nobody.here@libertyretail.com.au", "wrong password here");
  const noPw = await login("invitee.zero@libertyretail.com.au", GOOD);
  for (const r of [wrong, unknown, noPw]) { assert.equal(r.status, 401); assert.equal(cookieOf(r), ""); }
  const bodies = await Promise.all([wrong, unknown, noPw].map(async (r) => JSON.stringify(await r.json())));
  assert.equal(new Set(bodies).size, 1, "same body for wrong password, unknown user, and user without a password");
  const ok = await login(email, GOOD);
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.match(cookie, /^qr_otp=o[a-f0-9]{32}\./);
  assert.match(ok.headers.getSetCookie().find((x) => x.startsWith("qr_otp=")), /HttpOnly/);
  const session = await (await identityFn(req("GET", "/api/identity/session", { cookie }))).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.otp, true);
  assert.equal(session.identity.email, email);
  assert.equal(session.identity.warehouse, true);
  assert.equal(session.identity.role, "building-maintenance");
  // PR56 permissions apply identically after a password login.
  const overview = await (await whFn(req("GET", "/api/warehouse", { cookie }))).json();
  assert.deepEqual(overview.can, { generate: true, reprint: true, admin: false });
  assert.equal((await whFn(req("POST", "/api/warehouse/settings", { cookie, body: { next: 9999 } }))).status, 403);
  for (const [h, url] of [[usersFn, "/api/users"], [sitesFn, "/api/sites"], [await fn("pos-drafts"), "/api/pos-drafts"], [await fn("tickets"), "/api/tickets"], [await fn("visitor-admin"), "/api/visitor-log/visits"], [await fn("codes"), "/api/codes"]]) {
    const res = await h(req("GET", url, { cookie }));
    assert.ok([401, 403].includes(res.status), url + " " + res.status);
  }
  assert.equal((await post(usersFn, "/api/users/invite", { email }, { cookie })).status, 403);
  // Unticking the tool applies at once, as with email-code sessions.
  await usersLib.saveUser(owner, { mode: "edit", email, visitor: "view", tickets: [], assets: "none", warehouse: false });
  assert.equal((await whFn(req("GET", "/api/warehouse", { cookie }))).status, 403);
  // Removing the user ends the session and the password sign-in; re-adding starts with no password.
  await usersLib.removeUser(owner, { email });
  assert.equal((await identityFn(req("GET", "/api/identity/session", { cookie }))).status, 200);
  assert.equal((await (await identityFn(req("GET", "/api/identity/session", { cookie }))).json()).authenticated, false);
  assert.equal((await login(email, GOOD)).status, 401);
  assert.equal(await cred.hasPassword(email), false);
  await addUser(email);
  assert.equal((await login(email, GOOD)).status, 401, "old password does not come back");
});

test("sign-in rate limits: per email and per source, with generic 429 and no lockout leak for unknown emails", async () => {
  const email = "invitee.rate@libertyretail.com.au";
  const { mail } = await addUser(email);
  await setPw(linkOf(mail[0]), GOOD);
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await login(email, "wrong-" + i + "-password")).status);
  assert.deepEqual(codes.slice(0, 8), Array(8).fill(401));
  assert.deepEqual(codes.slice(8), [429, 429]);
  assert.equal((await login(email, GOOD)).status, 429, "correct password is refused while limited");
  t += 16 * 60e3;
  assert.equal((await login(email, GOOD)).status, 200, "window passes");
  // An unknown address is limited the same way (so limits do not reveal who exists).
  const ghost = [];
  for (let i = 0; i < 10; i++) ghost.push((await login("ghost.user@libertyretail.com.au", "x-" + i + "-password")).status);
  assert.deepEqual(ghost, [...Array(8).fill(401), 429, 429]);
  // Per source: many different addresses from one source.
  const source = "2001:db8:beef::1";
  const many = [];
  for (let i = 0; i < 23; i++) many.push((await login("spray" + i + "@libertyretail.com.au", "x-" + i + "-password", { source })).status);
  assert.equal(many.slice(0, 20).every((s) => s === 401), true);
  assert.equal(many.slice(20).every((s) => s === 429), true);
  // Counters hold hashes only.
  const keys = (await lib.rateStore().list({ prefix: "pw/" })).blobs.map((b) => b.key).join("\n");
  assert.equal(/libertyretail|2001:db8/.test(keys), false);
});

test("forgot password: same answer for everyone, mail only for listed users, reset keeps permissions, old password and sessions end", async () => {
  const email = "invitee.forgot@libertyretail.com.au";
  const { mail } = await addUser(email, { warehouse: true, visitor: "view" });
  await setPw(linkOf(mail[0]), GOOD);
  const cookie = cookieOf(await login(email, GOOD));
  const before = sent.length;
  const known = await post(passwordFn, "/api/identity/password/forgot", { email });
  const unknown = await post(passwordFn, "/api/identity/password/forgot", { email: "stranger@example.com" });
  const outside = await post(passwordFn, "/api/identity/password/forgot", { email: "stranger2@libertyretail.com.au" });
  assert.equal(known.status, 200);
  assert.deepEqual([unknown.status, outside.status], [200, 200]);
  const body = await known.json();
  assert.deepEqual(await unknown.json(), body);
  assert.deepEqual(await outside.json(), body);
  assert.equal(sent.length - before, 1, "only the listed address got a message");
  const reset = sent.at(-1);
  assert.equal(reset.to, email);
  assert.equal(reset.subject, "Reset your Express Help password");
  assert.match(reset.text, /expires in 1 hour/);
  assert.match(reset.html, /Cowabunga - please hesitate to reach out/);
  assert.equal((await post(passwordFn, "/api/identity/password/forgot", { email: "" })).status, 400);
  const view = await (await post(passwordFn, "/api/identity/password/link", { token: linkOf(reset) })).json();
  assert.deepEqual([view.valid, view.kind, view.email], [true, "reset", email]);
  const permsBefore = JSON.stringify(await otpLib.actorForEmail(email));
  const next = "a brand new passphrase";
  assert.equal((await setPw(linkOf(reset), next)).status, 200);
  assert.equal(JSON.stringify(await otpLib.actorForEmail(email)), permsBefore, "reset does not touch permissions");
  assert.equal((await login(email, GOOD)).status, 401);
  assert.equal((await login(email, next)).status, 200);
  assert.equal((await (await identityFn(req("GET", "/api/identity/session", { cookie }))).json()).authenticated, false, "sessions before the reset are ended");
  // forgot is limited: 3 per address per window
  const e2 = "invitee.forgot2@libertyretail.com.au";
  await addUser(e2);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post(passwordFn, "/api/identity/password/forgot", { email: e2 })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test("mail failures: add still works, no usable link is left, and nothing is sent when mail is not available", async () => {
  failNext = "failed";
  const { res } = await addUser("invitee.fail@libertyretail.com.au");
  assert.equal(res.body.invite.status, "failed");
  failNext = null;
  const status = await cred.passwordStatus("invitee.fail@libertyretail.com.au");
  assert.equal(status.state, "none");
  mailLib.setMailTransport(null);
  const before = sent.length;
  const added = await usersLib.saveUser(owner, { mode: "add", email: "invitee.nomail@libertyretail.com.au", visitor: "view" });
  assert.equal(added.status, 200);
  assert.equal(added.body.invite.status, "not-configured");
  assert.equal(sent.length, before);
  assert.equal((await usersLib.resendInvite(owner, { email: "invitee.nomail@libertyretail.com.au" })).status, 503);
  assert.equal((await post(passwordFn, "/api/identity/password/forgot", { email: "invitee.nomail@libertyretail.com.au" })).status, 200);
  assert.equal((await lib.credStore().list({ prefix: "tok/" })).blobs.length > 0, true);
  mailLib.setMailTransport(async (m) => { sent.push(m); return { status: failNext || "sent", id: "mock" }; });
});

test("Users list shows Active / Invited / Expired / No password set; legacy users are not emailed or changed", async () => {
  await lib.usersStore().delete("registry");
  await lib.usersStore().setJSON("registry", { version: 1, users: [
    { email: JOSHUA, approverKey: "joshua", preparerClass: "joshua", siteIds: [], visitor: "none" },
    { email: "legacy.user@libertyretail.com.au", approverKey: "", preparerClass: "jeremy", siteIds: [], visitor: "view" },
  ] });
  const before = sent.length;
  await addUser("status.invited@libertyretail.com.au");
  const exp = await addUser("status.expired@libertyretail.com.au");
  const act = await addUser("status.active@libertyretail.com.au");
  await setPw(linkOf(act.mail[0]), GOOD);
  t += 80 * HOUR;
  await addUser("status.fresh@libertyretail.com.au");
  const rows = Object.fromEntries((await usersLib.listUsers(owner)).body.users.map((u) => [u.email, u.password]));
  assert.equal(rows["status.active@libertyretail.com.au"].state, "active");
  assert.equal(rows["status.expired@libertyretail.com.au"].state, "expired");
  assert.equal(rows["status.fresh@libertyretail.com.au"].state, "invited");
  assert.equal(rows["legacy.user@libertyretail.com.au"].state, "none");
  assert.equal(rows[JOSHUA].state, "none");
  assert.equal(sent.slice(before).some((m) => m.to === "legacy.user@libertyretail.com.au" || m.to === JOSHUA), false);
  const legacy = await usersLib.userFor("legacy.user@libertyretail.com.au");
  assert.deepEqual([legacy.preparerClass, legacy.visitor], ["jeremy", "view"]);
  assert.equal(JSON.stringify(rows).includes("hash"), false);
  void exp;
});

test("head-office, site-manager and email-code sign-in are unaffected", async () => {
  const head = await authFn(req("POST", "/api/auth", { body: { password: "test-pass-synthetic" } }));
  assert.equal(head.status, 200);
  assert.equal((await head.json()).role, "head");
  assert.equal((await authFn(req("POST", "/api/auth", { body: { password: "wrong" } }))).status, 401);
  // A head-office password is never accepted by the user-password endpoint, with or without an email.
  assert.equal((await login("", "test-pass-synthetic")).status, 401);
  assert.equal((await login(JOSHUA, "test-pass-synthetic")).status, 401);
  assert.equal((await entraFn(req("GET", "/api/identity/entra/status"))).status, 200);
  assert.equal((await otpFn(req("GET", "/api/identity/otp/status"))).status, 200);
  // Owner can still use the email code path (unchanged).
  const codes = [];
  otpLib.setOtpTestHooks({ deliver: async (m) => { codes.push(m); return { status: "sent", id: "mock" }; } });
  assert.equal((await post(otpFn, "/api/identity/otp/start", { email: JOSHUA })).status, 200);
  assert.equal(codes.length, 1);
  assert.match(codes[0].text, /sign-in code is \d{8}/);
  otpLib.setOtpTestHooks({});
});

test("public endpoints refuse cross-site calls and non-POST, and set no cookie on failure", async () => {
  const cross = new Request("https://expresshelp.site/api/identity/password/login", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal((await passwordFn(cross)).status, 403);
  assert.equal((await passwordFn(req("GET", "/api/identity/password/login"))).status, 405);
  const bad = await login(JOSHUA, "nope nope nope");
  assert.equal(bad.headers.getSetCookie().length, 0);
});

test("pages: set-password page and sign-in carry the footer, loading states, show/hide, no token in the query string", () => {
  const page = fs.readFileSync(new URL("../public/set-password.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/set-password.js", import.meta.url), "utf8");
  assert.match(page, /<script src="\/footer\.js" defer><\/script>/);
  assert.match(page, /name="viewport"/);
  assert.match(page, /name="referrer" content="no-referrer"/);
  assert.match(page, /id="sp-toggle"/);
  assert.match(js, /Saving…/);
  assert.match(js, /location\.hash/);
  assert.match(js, /replaceState/);
  assert.equal(/location\.search/.test(js), false);
  const index = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  for (const id of ["pw-toggle", "forgot-open", "forgot-form", "login-submit", "otp-form"]) assert.ok(index.includes('id="' + id + '"'), id);
  const app = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  for (const needle of ["Signing in…", "Sending…", "Resend invite", "/api/identity/password/login", "/api/identity/password/forgot", "/api/users/invite", "inviteBadge"]) assert.ok(app.includes(needle), needle);
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /from = "\/set-password"\s+to = "\/set-password\.html"/);
});
