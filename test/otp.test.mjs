import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;
delete process.env.ALLOW_FIXTURE_IDENTITY_BIND;

const SITE = "s1234abcd";
const OTHER = "s1234abce";
const NEIL = "nanderson@libertyretail.com.au";
const JOSHUA = "jbattaglia@libertyretail.com.au";
const RBM = "rbm.fixture@libertyretail.com.au";

function allowlist(extra = {}) {
  return JSON.stringify({
    [NEIL]: { approverKey: "neil", siteIds: [SITE] },
    [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [SITE] },
    [RBM]: { preparerClass: "regional-business-manager", siteIds: [SITE] },
    ...extra,
  });
}
process.env.OTP_ALLOWLIST = allowlist();

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const otpFn = (await import("../netlify/functions/otp.mjs")).default;
const identityFn = (await import("../netlify/functions/identity.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const { isVerifiedApprover, isVerifiedPreparer, canSeeDraft, requestApproval } = await import("../netlify/lib/pos-workflow.mjs");
const { materialDigest } = await import("../netlify/lib/pos-approval.mjs");

const sent = [];
let current = Date.now();
const recordDelivery = async (message) => {
  sent.push(message);
  return { status: "sent", id: "local-mock" };
};
function useClock(deliver = recordDelivery) {
  otpLib.setOtpTestHooks({ now: () => current, deliver });
}
function advance() {
  current += 16 * 60 * 1000;
}
useClock();

function req(method, url, { cookie = "", body, origin, ip, forwarded } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  if (ip) headers.set("x-nf-client-connection-ip", ip);
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  return { status: res.status, body: await res.json(), cookie: cookieNamed(res, "qr_otp") };
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
function codeFrom(message) {
  return message.text.match(/code is (\d{8})/)[1];
}
async function issued(email, ip) {
  const before = sent.length;
  const res = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email }, ip })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.message, otpLib.OTP_ACCEPTED);
  assert.equal(sent.length, before + 1);
  return codeFrom(sent.at(-1));
}

test("email codes stay off without the secret, allowlist, and Resend", async () => {
  advance();
  const savedSecret = process.env.OTP_SESSION_SECRET;
  const savedList = process.env.OTP_ALLOWLIST;
  delete process.env.OTP_SESSION_SECRET;
  let status = await read(await otpFn(req("GET", "/api/identity/otp/status")));
  assert.equal(status.body.operational, false);
  assert.match(status.body.setup, /OTP_SESSION_SECRET/);
  process.env.OTP_SESSION_SECRET = savedSecret;
  process.env.OTP_ALLOWLIST = "{}";
  status = await read(await otpFn(req("GET", "/api/identity/otp/status")));
  assert.equal(status.body.operational, false);
  process.env.OTP_ALLOWLIST = savedList;
  otpLib.setOtpTestHooks({ now: () => current });
  process.env.POS_MAIL_MOCK = "1";
  status = await read(await otpFn(req("GET", "/api/identity/otp/status")));
  assert.equal(status.body.operational, false);
  assert.equal(status.body.mock, false);
  delete process.env.POS_MAIL_MOCK;
  const blocked = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: NEIL }, ip: "203.0.113.10" })));
  assert.equal(blocked.status, 403);
  useClock();
  status = await read(await otpFn(req("GET", "/api/identity/otp/status")));
  assert.equal(status.body.operational, true);
  assert.equal(status.body.mock, true);
});

test("unknown addresses get the same response and no message", async () => {
  advance();
  const before = sent.length;
  const stranger = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: "person@libertyretail.com.au" }, ip: "203.0.113.11" })));
  const known = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: NEIL }, ip: "203.0.113.12" })));
  assert.deepEqual(stranger.body, known.body);
  assert.equal(stranger.status, 200);
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to, NEIL);
  assert.equal(sent.at(-1).subject.includes(codeFrom(sent.at(-1))), false);
});

test("a code is one-time, hashed, and rejected after expiry, replay, or five misses", async () => {
  advance();
  const code = await issued(NEIL, "203.0.113.20");
  const rows = await lib.otpStore().list({ prefix: "ch/" });
  const stored = await Promise.all(rows.blobs.map((blob) => lib.otpStore().get(blob.key, { type: "json" })));
  assert.equal(stored.some((row) => JSON.stringify(row).includes(code)), false);
  const get = await otpFn(req("GET", "/api/identity/otp/verify", { ip: "203.0.113.20" }));
  assert.equal(get.status, 405);
  const ok = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code }, ip: "203.0.113.21" })));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.identity.provider, "otp");
  assert.equal(ok.body.identity.allSites, false);
  assert.equal(ok.body.identity.approverKey, "neil");
  assert.equal(isVerifiedApprover(ok.body.identity), true);
  assert.equal(cookieNamed(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code }, ip: "203.0.113.22" })), "qr_otp"), "");
  const replay = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code }, ip: "203.0.113.22" })));
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, otpLib.OTP_REJECTED);

  const fresh = await issued(JOSHUA, "203.0.113.23");
  for (let i = 0; i < 5; i++) {
    const miss = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: JOSHUA, code: "00000000" }, ip: "203.0.113.24" })));
    assert.equal(miss.status, 401);
  }
  const locked = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: JOSHUA, code: fresh }, ip: "203.0.113.25" })));
  assert.equal(locked.status, 401);

  const expiring = await issued(NEIL, "203.0.113.26");
  current += 11 * 60 * 1000;
  const expired = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code: expiring }, ip: "203.0.113.27" })));
  assert.equal(expired.status, 401);
  useClock();
});

test("only one concurrent verify consumes the code", async () => {
  advance();
  const code = await issued(NEIL, "203.0.113.30");
  const pair = await Promise.all([
    read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code }, ip: "203.0.113.31" }))),
    read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code }, ip: "203.0.113.32" }))),
  ]);
  const wins = pair.filter((item) => item.status === 200);
  assert.equal(wins.length, 1);
  assert.equal(pair.filter((item) => item.status === 401).length, 1);
});

test("resend invalidates the previous code and then the limit holds", async () => {
  advance();
  const first = await issued(RBM, "203.0.113.40");
  const second = await issued(RBM, "203.0.113.40");
  assert.notEqual(first, second);
  const old = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: RBM, code: first }, ip: "203.0.113.41" })));
  assert.equal(old.status, 401);
  const again = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: RBM }, ip: "203.0.113.40" })));
  assert.equal(again.status, 200);
  const limited = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: RBM }, ip: "203.0.113.42" })));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, otpLib.OTP_LIMIT);
});

test("a lost or failed delivery does not leave a usable code and is not retried", async () => {
  advance();
  let calls = 0;
  otpLib.setOtpTestHooks({
    now: () => current,
    deliver: async () => { calls += 1; return { status: "unknown" }; },
  });
  const unknown = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: NEIL }, ip: "203.0.113.50" })));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.message, otpLib.OTP_ACCEPTED);
  assert.equal(calls, 1);
  const rejected = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code: "12345678" }, ip: "203.0.113.51" })));
  assert.equal(rejected.status, 401);
  otpLib.setOtpTestHooks({
    now: () => current,
    deliver: async () => { calls += 1; throw new Error("socket"); },
  });
  await otpFn(req("POST", "/api/identity/otp/start", { body: { email: JOSHUA }, ip: "203.0.113.52" }));
  assert.equal(calls, 2);
  useClock();
});

function siteIds(count) {
  return Array.from({ length: count }, (_, index) => "s" + index.toString(16).padStart(8, "0"));
}

test("ninety explicit sites stay granted for the two authorised role shapes", async () => {
  const ids = siteIds(90);
  assert.equal(new Set(ids).size, 90);
  const saved = process.env.OTP_ALLOWLIST;
  const document = JSON.stringify({
    [NEIL]: { approverKey: "neil", siteIds: ids },
    [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [...ids, ids[0]] },
  });
  assert.ok(document.length < 20000, document.length);
  process.env.OTP_ALLOWLIST = document;
  try {
    const map = otpLib.parseAllowlist();
    assert.equal(map.error, "");
    assert.equal(map.entries.size, 2);
    const neil = map.entries.get(NEIL);
    const joshua = map.entries.get(JOSHUA);
    assert.equal(neil.approverKey, "neil");
    assert.equal(neil.preparerClass, "");
    assert.deepEqual(neil.siteIds, ids);
    assert.equal(neil.allSites, false);
    assert.equal(joshua.approverKey, "joshua");
    assert.equal(joshua.preparerClass, "joshua");
    assert.deepEqual(joshua.siteIds, ids);
    assert.equal(joshua.allSites, false);
    assert.equal(otpLib.otpStatus().allowlistConfigured, true);
    const actor = otpLib.actorFromOtp(JOSHUA);
    assert.equal(isVerifiedApprover(actor), true);
    assert.equal(isVerifiedPreparer(actor), true);
    assert.equal(canSeeDraft(actor, { siteIds: ids }), true);
    assert.equal(canSeeDraft(actor, { siteIds: ["sffffffff"] }), false);
    assert.equal(isVerifiedPreparer(otpLib.actorFromOtp(NEIL)), false);
  } finally {
    process.env.OTP_ALLOWLIST = saved;
  }
});

test("an invalid id or a list past the explicit cap drops that entry and does not trim it", () => {
  const ids = siteIds(90);
  const invalid = otpLib.parseAllowlist(JSON.stringify({
    [NEIL]: { approverKey: "neil", siteIds: [...ids, "s123"] },
    [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ids },
  }));
  assert.equal(invalid.entries.has(NEIL), false);
  assert.equal(invalid.entries.get(JOSHUA).siteIds.length, 90);
  const oversized = siteIds(otpLib.OTP_EXPLICIT_SITE_CAP + 1);
  const dropped = otpLib.parseAllowlist(JSON.stringify({
    [NEIL]: { approverKey: "neil", siteIds: oversized },
  }));
  assert.equal(dropped.entries.size, 0);
  assert.equal(otpLib.parseAllowlist(JSON.stringify({
    [NEIL]: { approverKey: "neil", allSites: true, siteIds: ids },
  })).entries.size, 0);
  assert.equal(otpLib.parseAllowlist("x".repeat(20001)).error.includes("too large"), true);
});

test("scope is explicit, revocation is immediate, and domains or allSites do not grant access", async () => {
  advance();
  assert.equal(otpLib.parseAllowlist(JSON.stringify({ "*@libertyretail.com.au": { approverKey: "neil", siteIds: [SITE] } })).entries.size, 0);
  assert.equal(otpLib.parseAllowlist(JSON.stringify({ [NEIL]: { approverKey: "neil", allSites: true, siteIds: [SITE] } })).entries.size, 0);
  assert.equal(otpLib.parseAllowlist(JSON.stringify({ "someone@libertyretail.com.au": { approverKey: "neil", siteIds: [SITE] } })).entries.size, 0);
  assert.equal(otpLib.parseAllowlist(JSON.stringify({ [NEIL]: { preparerClass: "jeremy", siteIds: [SITE] } })).entries.size, 0);
  assert.equal(otpLib.parseAllowlist(JSON.stringify({ "jeremy@example.com": { preparerClass: "joshua", siteIds: [SITE] } })).entries.size, 0);
  const preparer = otpLib.parseAllowlist(JSON.stringify({ "jeremy.fixture@libertyretail.com.au": { preparerClass: "jeremy", siteIds: [SITE] } })).entries.get("jeremy.fixture@libertyretail.com.au");
  assert.equal(preparer.preparerClass, "jeremy");
  assert.deepEqual(preparer.siteIds, [SITE]);
  assert.equal(preparer.allSites, false);

  const code = await issued(JOSHUA, "203.0.113.60");
  const verified = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: JOSHUA, code }, ip: "203.0.113.61" })));
  const actor = verified.body.identity;
  assert.equal(isVerifiedApprover(actor), true);
  assert.equal(isVerifiedPreparer(actor), true);
  assert.equal(canSeeDraft(actor, { siteIds: [SITE] }), true);
  assert.equal(canSeeDraft(actor, { siteIds: [OTHER] }), false);
  assert.equal(actor.allSites, false);
  process.env.OTP_ALLOWLIST = allowlist({ [JOSHUA]: { disabled: true, approverKey: "joshua", siteIds: [SITE] } });
  const session = await read(await identityFn(req("GET", "/api/identity/session", { cookie: verified.cookie })));
  assert.equal(session.body.authenticated, false);
  process.env.OTP_ALLOWLIST = allowlist();
  const head = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" }, ip: "203.0.113.62" }));
  const headActor = await (await import("../netlify/lib/identity.mjs")).actorFromRequest(req("GET", "/api/pos-drafts", { cookie: cookieNamed(head, "qr_admin") }));
  assert.equal(isVerifiedApprover(headActor), false);
});

test("cross-site origin is rejected and a forged cookie is not a session", async () => {
  advance();
  const forged = await read(await identityFn(req("GET", "/api/identity/session", { cookie: "qr_otp=o" + "ab".repeat(16) + ".9999999999999." + "cd".repeat(32) })));
  assert.equal(forged.body.authenticated, false);
  const csrf = await read(await otpFn(req("POST", "/api/identity/otp/start", { body: { email: NEIL }, origin: "https://evil.example", ip: "203.0.113.70" })));
  assert.equal(csrf.status, 403);
  const spoofed = otpLib.trustedClientKey(req("POST", "/api/identity/otp/start", { forwarded: "1.2.3.4" }));
  const other = otpLib.trustedClientKey(req("POST", "/api/identity/otp/start", { forwarded: "8.8.8.8" }));
  assert.equal(spoofed, "untrusted");
  assert.equal(other, "untrusted");
});

test("logout ends the email-code session and Entra scope is not merged", async () => {
  advance();
  const code = await issued(NEIL, "203.0.113.80");
  const verified = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: NEIL, code }, ip: "203.0.113.81" })));
  const gone = await authFn(req("DELETE", "/api/auth", { cookie: verified.cookie }));
  const after = await read(await identityFn(req("GET", "/api/identity/session", { cookie: verified.cookie })));
  assert.equal(cookieNamed(gone, "qr_otp"), "");
  assert.equal(after.body.authenticated, false);
  const { actorFromSession } = await import("../netlify/lib/entra.mjs");
  process.env.ENTRA_ROLE_MAP = JSON.stringify({ approverJoshua: { oid: "44444444-4444-4444-8444-444444444444", siteIds: [OTHER] } });
  const entraActor = actorFromSession({ id: "e" + "aa".repeat(16), oid: "44444444-4444-4444-8444-444444444444", name: "Joshua" });
  assert.deepEqual(entraActor.siteIds, [OTHER]);
  assert.equal(entraActor.provider, "entra");
  assert.notEqual(entraActor.siteIds.join(), verified.body.identity.siteIds.join());
});

test("an email-code preparer still asks both approvers and does not send to Quickfuel", async () => {
  advance();
  const messages = [];
  setMailTransport(async (message) => { messages.push(message); return { status: "sent", id: "local-mock", mock: true }; });
  process.env.POS_MAIL_MOCK = "1";
  const code = await issued(RBM, "203.0.113.90");
  const verified = await read(await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: RBM, code }, ip: "203.0.113.91" })));
  const actor = verified.body.identity;
  const draft = {
    id: "p1234abcd",
    revision: 1,
    offer: "Fixture offer",
    conditions: "Fixture conditions",
    start: "2026-11-01",
    end: "2026-11-30",
    siteIds: [SITE],
    posRedemption: "single-use",
    distribution: "shareable-claim-link",
    claimCap: 10,
    codeType: "code128",
    codeValue: "ABC",
    approvalStatus: "draft",
  };
  draft.materialDigest = materialDigest(draft);
  await lib.posDrafts().setJSON(draft.id, draft);
  const meta = await lib.posDrafts().getWithMetadata(draft.id, { type: "json" });
  const result = await requestApproval({ actor, draft: meta.data, etag: meta.etag });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.recipients.map((item) => item.to).sort(), [JOSHUA, NEIL]);
  assert.equal(result.body.recipients.filter((item) => item.sent).length, 2);
  assert.equal(messages.some((message) => message.to === "support@quickfuel.com.au"), false);
  assert.match(messages.find((message) => message.to === NEIL).text, /does not approve/);
  const saved = await lib.posDrafts().get(draft.id, { type: "json" });
  assert.equal(saved.requestedContact, RBM);
  delete process.env.POS_MAIL_MOCK;
  setMailTransport(null);
});
