import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.IDENTITY_BIND_TOKEN = "fixture-bind-token-value";
process.env.IDENTITY_SESSION_SECRET = "fixture-session-secret-value";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const auth = (await import("../netlify/functions/auth.mjs")).default;
const sitesFn = (await import("../netlify/functions/sites.mjs")).default;
const staffFn = (await import("../netlify/functions/staff.mjs")).default;
const posFn = (await import("../netlify/functions/pos-drafts.mjs")).default;
const identityFn = (await import("../netlify/functions/identity.mjs")).default;
const reviewFn = (await import("../netlify/functions/pos-review.mjs")).default;
const claimFn = (await import("../netlify/functions/claim-public.mjs")).default;
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const { materialDigest } = await import("../netlify/lib/pos-approval.mjs");
const { evaluateClaim } = await import("../netlify/lib/claim.mjs");
const { issueVoucher, redeemVoucher } = await import("../netlify/lib/vouchers.mjs");

const messages = [];
function req(method, url, { cookie, body, accept, token } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (accept) headers.set("accept", accept);
  if (token) headers.set("x-identity-bind-token", token);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json(), text: "" };
  if (type.includes("zip")) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), text: "" };
  const text = await res.text();
  return { status: res.status, body: text, text };
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
function tokenFrom(messagesList) {
  const last = messagesList[messagesList.length - 1];
  const match = last?.text?.match(/\/api\/pos-review\/([a-f0-9]{64})/);
  return match ? match[1] : "";
}
const headLogin = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
const head = cookieNamed(headLogin, "qr_admin");
const site = (await read(await sitesFn(req("POST", "/api/sites", { cookie: head, body: { name: "Approval North" } })))).body;

async function bind(body) {
  const res = await read(await identityFn(req("POST", "/api/identity/bind", { token: process.env.IDENTITY_BIND_TOKEN, body })));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.identity;
}
async function identLogin(login, password) {
  const res = await identityFn(req("POST", "/api/identity/session", { body: { login, password } }));
  return cookieNamed(res, "qr_ident");
}
const preparer = await bind({ kind: "preparer", preparerClass: "regional-business-manager", displayName: "Fixture RBM", contactEmail: "requester@fixture.test", password: "preparer-pass-1", siteIds: [site.id] });
const neil = await bind({ kind: "approver", approverKey: "neil", password: "neil-pass-123", siteIds: [site.id] });
const joshua = await bind({ kind: "approver", approverKey: "joshua", password: "joshua-pass-123", siteIds: [site.id] });
const preparerCookie = await identLogin(preparer.id, "preparer-pass-1");
const neilCookie = await identLogin("nanderson@libertyretail.com.au", "neil-pass-123");
const joshuaCookie = await identLogin(joshua.id, "joshua-pass-123");

function draftBody(extra = {}) {
  return { offer: "Saturday fuel", conditions: "One fill", start: "2026-11-01", end: "2026-11-30", siteIds: [site.id], posRedemption: "single-use", distribution: "shareable-claim-link", claimCap: 20, ...extra };
}

test("binding fails closed and shared or spoofed identities cannot approve", async () => {
  const blocked = await read(await identityFn(req("POST", "/api/identity/bind", { body: { kind: "approver", approverKey: "neil", password: "another-password" } })));
  assert.equal(blocked.status, 403);
  const typed = await read(await identityFn(req("POST", "/api/identity/bind", { token: process.env.IDENTITY_BIND_TOKEN, body: { kind: "approver", approverKey: "neil", email: "someone@example.com", password: "another-password" } })));
  assert.equal(typed.status, 400);
  const again = await read(await identityFn(req("POST", "/api/identity/bind", { token: process.env.IDENTITY_BIND_TOKEN, body: { kind: "approver", approverKey: "neil", password: "another-password", siteIds: [site.id] } })));
  assert.equal(again.status, 409);
  const adminAsIdentity = await read(await identityFn(req("POST", "/api/identity/session", { body: { login: "nanderson@libertyretail.com.au", password: "test-pass" } })));
  assert.equal(adminAsIdentity.status, 401);
  await staffFn(req("POST", "/api/staff", { cookie: head, body: { name: "Spoof", email: "nanderson@libertyretail.com.au", password: "staff-pass-12", siteIds: [site.id] } }));
  const staffLogin = await auth(req("POST", "/api/auth", { body: { email: "nanderson@libertyretail.com.au", password: "staff-pass-12" } }));
  const staff = cookieNamed(staffLogin, "qr_staff");
  const created = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: preparerCookie, body: draftBody() })));
  const deniedStaff = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/decision", { cookie: staff, body: { decision: "approve", etag: created.body.etag, identityId: neil.id, email: "nanderson@libertyretail.com.au" } })));
  const deniedHead = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/decision", { cookie: head, body: { decision: "approve", etag: created.body.etag, approverKey: "neil" } })));
  assert.equal(deniedStaff.status, 403);
  assert.equal(deniedHead.status, 403);
});

test("one approver is enough, GET is side-effect free, and mail stays honest", async () => {
  const created = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: preparerCookie, body: draftBody({ offer: "Review fuel" }) })));
  const unsent = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "neil", email: "evil@example.com", etag: created.body.etag } })));
  assert.equal(unsent.status, 409);
  assert.equal(unsent.body.sent, false);
  assert.equal(unsent.body.status, "not-configured");
  assert.equal((await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id, { cookie: preparerCookie })))).body.approvalStatus, "draft");
  const headRequest = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: head, body: { approverKey: "neil", etag: created.body.etag } })));
  assert.equal(headRequest.status, 403);
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM = "Fixture <fixture@example.com>";
  messages.length = 0;
  setMailTransport(async (message) => { messages.push(message); return { status: "sent", id: "mock-" + messages.length }; });
  const current = await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id, { cookie: preparerCookie })));
  const requested = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "neil", email: "evil@example.com", etag: current.body.etag } })));
  assert.equal(requested.body.sent, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "nanderson@libertyretail.com.au");
  assert.equal(JSON.stringify(requested.body).includes(tokenFrom(messages)), false);
  const token = tokenFrom(messages);
  const before = JSON.stringify(await lib.posDrafts().get(created.body.id, { type: "json" }));
  const review = await read(await reviewFn(req("GET", "/api/pos-review/" + token, { accept: "application/json" })));
  assert.equal(review.status, 200);
  assert.equal(review.body.revision, requested.body.draft.revision);
  assert.equal(JSON.stringify(review.body).includes(token), false);
  assert.equal(JSON.stringify(await lib.posDrafts().get(created.body.id, { type: "json" })), before);
  const anon = await read(await reviewFn(req("POST", "/api/pos-review/" + token + "/decision", { body: { decision: "approve", etag: review.body.etag } })));
  assert.equal(anon.status, 401);
  const wrong = await read(await reviewFn(req("POST", "/api/pos-review/" + token + "/decision", { cookie: joshuaCookie, body: { decision: "approve", etag: review.body.etag, approverKey: "neil", identityId: neil.id } })));
  assert.equal(wrong.status, 403);
  const approved = await read(await reviewFn(req("POST", "/api/pos-review/" + token + "/decision", { cookie: neilCookie, body: { decision: "approve", etag: review.body.etag, identityId: joshua.id, email: "jbattaglia@libertyretail.com.au" } })));
  assert.equal(approved.status, 200);
  assert.equal(approved.body.draft.approvalStatus, "approved");
  assert.equal(approved.body.draft.approval.approverKey, "neil");
  assert.equal(approved.body.draft.approval.identityId, neil.id);
  assert.equal(approved.body.confirmation.sent, true);
  assert.equal(messages.at(-1).to, "requester@fixture.test");
  assert.equal(messages.filter((message) => message.to === "support@quickfuel.com.au").length, 0);
  assert.equal((await read(await claimFn(req("GET", "/api/claim/" + (await lib.posDrafts().get(created.body.id, { type: "json" })).claimToken + "?activate=1")))).status, 404);
  const finalPackage = await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id + "/final-package", { cookie: preparerCookie })));
  assert.equal(finalPackage.status, 200);
  assert.match(finalPackage.body.toString("utf8"), /INTERNALLY APPROVED/);
  assert.match(finalPackage.body.toString("utf8"), /still unconfirmed/);
  const early = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/send-quickfuel", { cookie: head, body: { confirm: true, recipient: "support@quickfuel.com.au", etag: approved.body.draft.etag } })));
  assert.equal(early.status, 403);
  const wrongRecipient = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/send-quickfuel", { cookie: preparerCookie, body: { confirm: true, recipient: "evil@example.com", etag: approved.body.draft.etag } })));
  assert.equal(wrongRecipient.status, 400);
  const sent = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/send-quickfuel", { cookie: preparerCookie, body: { confirm: true, recipient: "support@quickfuel.com.au", etag: approved.body.draft.etag } })));
  assert.equal(sent.body.sent, true);
  assert.equal(sent.body.recipient, "support@quickfuel.com.au");
  const calls = messages.length;
  const again = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/send-quickfuel", { cookie: preparerCookie, body: { confirm: true, recipient: "support@quickfuel.com.au", etag: approved.body.draft.etag } })));
  assert.equal(again.body.sent, true);
  assert.equal(messages.length, calls);
  const fuel = messages.find((message) => message.to === "support@quickfuel.com.au");
  assert.equal(fuel.attachments[0].filename.startsWith("pos-setup-p"), true);
  assert.equal(Buffer.from(fuel.attachments[0].content, "base64")[0], 0x50);
  const stored = await lib.posDrafts().get(created.body.id, { type: "json" });
  assert.equal(stored.confirmationStatus, "pending");
  assert.equal(stored.activation, undefined);
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  setMailTransport(null);
});

test("reject, resubmit, expiry, and material edits invalidate the old approval", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM = "Fixture <fixture@example.com>";
  messages.length = 0;
  setMailTransport(async (message) => { messages.push(message); return { status: "sent", id: "mock" }; });
  const created = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: preparerCookie, body: draftBody({ offer: "Reject fuel" }) })));
  const requested = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "joshua", etag: created.body.etag } })));
  const token = tokenFrom(messages);
  const review = await read(await reviewFn(req("GET", "/api/pos-review/" + token, { accept: "application/json" })));
  const rejected = await read(await reviewFn(req("POST", "/api/pos-review/" + token + "/decision", { cookie: joshuaCookie, body: { decision: "reject", etag: review.body.etag } })));
  assert.equal(rejected.body.draft.approvalStatus, "rejected");
  assert.equal((await read(await reviewFn(req("GET", "/api/pos-review/" + token, { accept: "application/json" })))).status, 404);
  const resubmit = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "joshua", etag: rejected.body.draft.etag } })));
  assert.equal(resubmit.body.sent, true);
  const nextToken = tokenFrom(messages);
  const record = await lib.posReviews().get("token/" + crypto.createHash("sha256").update(nextToken).digest("hex"), { type: "json" });
  record.expiresAt = "2000-01-01T00:00:00.000Z";
  await lib.posReviews().setJSON("token/" + crypto.createHash("sha256").update(nextToken).digest("hex"), record);
  assert.equal((await read(await reviewFn(req("GET", "/api/pos-review/" + nextToken, { accept: "application/json" })))).status, 410);
  const fresh = await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id, { cookie: preparerCookie })));
  const edited = await read(await posFn(req("PATCH", "/api/pos-drafts/" + created.body.id, { cookie: preparerCookie, body: { ...draftBody({ offer: "Edited fuel" }), etag: fresh.body.etag } })));
  assert.equal(edited.body.approvalStatus, "draft");
  assert.equal(edited.body.approval, null);
  assert.equal((await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id + "/final-package", { cookie: preparerCookie })))).status, 403);
  const pack = await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id + "/package", { cookie: preparerCookie })));
  assert.match(pack.body.toString("utf8"), /DRAFT \/ UNAPPROVED/);
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  setMailTransport(null);
});

test("concurrent approval and edit cannot approve a superseded revision, and unknown mail is not sent twice", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM = "Fixture <fixture@example.com>";
  let calls = 0;
  setMailTransport(async () => { calls += 1; return { status: "unknown" }; });
  const created = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: preparerCookie, body: draftBody({ offer: "Race fuel" }) })));
  const unknown = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "neil", etag: created.body.etag } })));
  assert.equal(unknown.body.sent, false);
  assert.equal(unknown.body.status, "unknown");
  const retry = await read(await posFn(req("POST", "/api/pos-drafts/" + created.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "neil", etag: created.body.etag } })));
  assert.equal(retry.body.sent, false);
  assert.equal(calls, 1);
  assert.notEqual((await lib.posDrafts().get(created.body.id, { type: "json" })).approvalStatus, "approved");
  setMailTransport(async (message) => { messages.push(message); return { status: "sent", id: "ok" }; });
  const other = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: preparerCookie, body: draftBody({ offer: "Second race" }) })));
  const requested = await read(await posFn(req("POST", "/api/pos-drafts/" + other.body.id + "/approval-request", { cookie: preparerCookie, body: { approverKey: "neil", etag: other.body.etag } })));
  const token = tokenFrom(messages);
  const review = await read(await reviewFn(req("GET", "/api/pos-review/" + token, { accept: "application/json" })));
  const [decision, edit] = await Promise.all([
    reviewFn(req("POST", "/api/pos-review/" + token + "/decision", { cookie: neilCookie, body: { decision: "approve", etag: review.body.etag } })).then(read),
    posFn(req("PATCH", "/api/pos-drafts/" + other.body.id, { cookie: head, body: { ...draftBody({ offer: "Changed during approval" }), etag: requested.body.draft.etag } })).then(read),
  ]);
  const after = await lib.posDrafts().get(other.body.id, { type: "json" });
  assert.equal(after.approvalStatus === "approved" && after.offer === "Changed during approval", false);
  assert.equal([decision.status, edit.status].includes(409), true);
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  setMailTransport(null);
});

test("public claims stay closed, and the active path enforces cap, dates, and reusable without touching web vouchers", async () => {
  const created = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: preparerCookie, body: draftBody({ offer: "Closed claim" }) })));
  const secret = (await lib.posDrafts().get(created.body.id, { type: "json" })).claimToken;
  assert.equal((await read(await claimFn(req("POST", "/api/claim/" + secret, { body: { activate: true, siteId: site.id, idempotencyKey: "idem-123456", reference: "person-a" } })))).status, 404);
  const forced = await read(await posFn(req("PATCH", "/api/pos-drafts/" + created.body.id, { cookie: head, body: { ...draftBody(), etag: created.body.etag, activation: "active", confirmationStatus: "confirmed", confirmationEvidence: { kind: "recorded", reference: "not-real" } } })));
  assert.equal(forced.status, 400);
  const base = { ...created.body, ...(await lib.posDrafts().get(created.body.id, { type: "json" })) };
  const published = {
    ...base,
    id: "p" + crypto.randomBytes(4).toString("hex"),
    codeValue: "EH-POS-LIVE1",
    claimToken: crypto.randomBytes(32).toString("hex"),
    claimCap: 2,
    start: "2020-01-01",
    end: "2099-01-01",
    confirmationStatus: "confirmed",
    confirmationEvidence: { kind: "recorded", reference: "fixture-provider-note" },
    activation: "active",
    activationAuthority: "recorded",
    approvalStatus: "approved",
    revision: 1,
    posRedemption: "single-use",
  };
  published.materialDigest = materialDigest(published);
  published.approval = { identityId: neil.id, approverKey: "neil", revision: 1, digest: published.materialDigest };
  await lib.posDrafts().setJSON(published.id, published);
  await lib.posDrafts().setJSON("claim/" + crypto.createHash("sha256").update(published.claimToken).digest("hex"), { id: published.id });
  const first = await evaluateClaim(lib.posClaims(), published, { reference: "person-a", idempotencyKey: "idem-single-1", siteId: site.id, ipHash: "ip", now: new Date("2026-11-06T00:00:00Z") });
  const replay = await evaluateClaim(lib.posClaims(), published, { reference: "person-a", idempotencyKey: "idem-single-1", siteId: site.id, ipHash: "ip", now: new Date("2026-11-06T00:00:00Z") });
  const second = await evaluateClaim(lib.posClaims(), published, { reference: "person-a", idempotencyKey: "idem-single-2", siteId: site.id, ipHash: "ip2", now: new Date("2026-11-06T00:00:00Z") });
  const early = await evaluateClaim(lib.posClaims(), published, { reference: "person-b", idempotencyKey: "idem-early-1", siteId: site.id, ipHash: "ip3", now: new Date("2019-06-01T00:00:00Z") });
  assert.equal(first.status, 201);
  assert.equal(replay.replay, true);
  assert.equal(second.status, 409);
  assert.equal(early.status, 400);
  const reusable = { ...published, id: "p" + crypto.randomBytes(4).toString("hex"), codeValue: "EH-POS-LIVE2", claimToken: crypto.randomBytes(32).toString("hex"), posRedemption: "reusable", claimCap: 5 };
  reusable.materialDigest = materialDigest(reusable);
  reusable.approval = { ...published.approval, digest: reusable.materialDigest };
  const reused = await evaluateClaim(lib.posClaims(), reusable, { reference: "person-a", idempotencyKey: "idem-reuse-1", siteId: site.id, ipHash: "ipa", now: new Date("2026-11-06T00:00:00Z") });
  const reusedAgain = await evaluateClaim(lib.posClaims(), reusable, { reference: "person-a", idempotencyKey: "idem-reuse-2", siteId: site.id, ipHash: "ipb", now: new Date("2026-11-06T00:00:00Z") });
  assert.equal(reused.status, 201);
  assert.equal(reusedAgain.status, 201);
  const rated = { ...reusable, id: "p" + crypto.randomBytes(4).toString("hex"), codeValue: "EH-POS-RATE", claimCap: 30 };
  rated.materialDigest = materialDigest(rated);
  rated.approval = { ...reusable.approval, digest: rated.materialDigest };
  const rateResults = [];
  for (let i = 0; i < 9; i++) {
    rateResults.push(await evaluateClaim(lib.posClaims(), rated, { reference: "rate-" + i, idempotencyKey: "idem-rate-" + i + "xxxx", siteId: site.id, ipHash: "rate-ip", now: new Date("2026-11-06T03:00:00Z") }));
  }
  assert.equal(rateResults.filter((result) => result.status === 429).length > 0, true);
  const issued = await issueVoucher(lib.vouchersStore(), { competition: "keep", source: "test", sourceId: "person", expires: "2026-12-31", label: "Coffee" });
  assert.equal((await redeemVoucher(lib.vouchersStore(), issued.token)).ok, true);
  assert.equal((await redeemVoucher(lib.vouchersStore(), issued.token)).conflict, true);
  const cross = await bind({ kind: "preparer", preparerClass: "jeremy", displayName: "Other", password: "other-preparer-1", siteIds: [] });
  assert.equal((await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id, { cookie: await identLogin(cross.id, "other-preparer-1") })))).status, 403);
});
