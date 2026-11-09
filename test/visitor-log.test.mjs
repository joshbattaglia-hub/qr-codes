import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;
delete process.env.VISITOR_ACCESS_MAP;
delete process.env.VISITOR_SHEETS_SPREADSHEET_ID;
delete process.env.VISITOR_SHEETS_CLIENT_EMAIL;
delete process.env.VISITOR_SHEETS_PRIVATE_KEY;

const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [NEIL]: { approverKey: "neil", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
const sheetLib = await import("../netlify/lib/visitor-sheet.mjs");
const imageLib = await import("../netlify/lib/visitor-image.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const publicFn = (await import("../netlify/functions/visitor-public.mjs")).default;
const adminFn = (await import("../netlify/functions/visitor-admin.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;

const sentMail = [];
const otpMail = [];
const sheetCalls = [];
otpLib.setOtpTestHooks({ deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
setMailTransport(async (message) => { sentMail.push(message); return { status: "sent", id: "local-mock" }; });
sheetLib.setVisitorSheetFetch(async (url, init) => {
  sheetCalls.push({ url: String(url), method: init.method, body: init.body ? String(init.body) : "" });
  if (String(url).includes("oauth2.googleapis.com")) {
    return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const decoded = decodeURIComponent(String(url));
  if (decoded.includes("Visits!A1") && init.method === "GET") {
    return new Response(JSON.stringify({ values: [["visit_id"]] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (decoded.endsWith(":append") || decoded.includes(":append?")) {
    return new Response(JSON.stringify({ updates: { updatedRange: "Visits!A2:N2" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (decoded.includes("Visits!A:A")) {
    return new Response(JSON.stringify({ values: [["visit_id"]] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});

function req(method, url, { cookie = "", body, origin, ip, raw } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  if (ip) headers.set("x-nf-client-connection-ip", ip);
  if (body !== undefined || raw !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json(), headers: res.headers };
  if (type.startsWith("image/") || type.includes("csv")) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  return { status: res.status, body: await res.text(), headers: res.headers };
}
function photoBytes() {
  const encoded = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80);
  const comment = Buffer.from("GPSLatitude secret-exif", "ascii");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), comment]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([encoded.data.subarray(0, 2), app1, encoded.data.subarray(2)]);
}
async function otpCookie(email, ip) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email }, ip }));
  assert.equal(started.status, 200);
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code }, ip }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_otp");
}

test("visitor access is Joshua-only and ignores site directory grants", () => {
  assert.equal(visitLib.parseVisitorAccess("").joshuaOtp, false);
  assert.equal(visitLib.parseVisitorAccess(JSON.stringify({ joshuaOtp: true, siteIds: ["s00000001"] })).error, "site-scope-not-used");
  assert.equal(visitLib.parseVisitorAccess(JSON.stringify({ joshuaOtp: true, allSites: true })).error, "site-scope-not-used");
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "otp", email: JOSHUA }), true);
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "otp", email: NEIL, approverKey: "neil", role: "approver" }), false);
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "otp", email: JOSHUA, approverKey: "joshua", role: "approver" }), true);
  assert.equal(visitLib.visitorCapability({ role: "head", id: "head-office" }), false);
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "entra", oid: "44444444-4444-4444-8444-444444444444", email: JOSHUA }), false);
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true, joshuaEntraOid: "44444444-4444-4444-8444-444444444444" });
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "entra", oid: "44444444-4444-4444-8444-444444444444" }), true);
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "entra", oid: "55555555-5555-4555-8555-555555555555", email: JOSHUA }), false);
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
});

test("the public form stays closed while never-signed-out photo retention is undecided", async () => {
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  visitLib.setVisitorTestHooks({ collect: false });
  const status = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(status.body.open, false);
  assert.ok(status.body.blockers.includes("open-visit-photo-retention-unresolved"));
  assert.match(status.body.notice, /90 days/);
  assert.match(status.body.notice, /after you sign out/i);
  assert.match(status.body.notice, /has not been decided/);
  assert.equal(status.body.textRetention, "not-authorised");
  assert.equal(status.body.sheetSharing, "none");
  assert.equal(status.headers.get("cache-control"), "private, no-store");
  const closed = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: { location: "Shell Suburb", name: "Pat", phone: "0412345678", company: "ACME", photo: photoBytes().toString("base64") }, ip: "203.0.113.10" })));
  assert.equal(closed.status, 403);
});

test("photos are re-encoded and unsafe files are rejected", () => {
  const jpegPhoto = imageLib.reencodeVisitorPhoto(photoBytes());
  assert.equal(jpegPhoto.contentType, "image/jpeg");
  assert.equal(jpegPhoto.bytes.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(jpegPhoto.bytes[0], 0xff);
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  const raw = PNG.sync.write(png);
  const withText = Buffer.concat([raw.subarray(0, raw.length - 12), Buffer.from("tEXTgpsGPSLatitude"), raw.subarray(raw.length - 12)]);
  const pngPhoto = imageLib.reencodeVisitorPhoto(withText.includes(PNG.sync.write(png)) ? PNG.sync.write(png) : raw);
  assert.equal(pngPhoto.contentType, "image/png");
  assert.equal(pngPhoto.bytes.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(imageLib.reencodeVisitorPhoto(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")).error.includes("JPEG or PNG"), true);
  assert.equal(imageLib.reencodeVisitorPhoto(Buffer.from("%PDF-1.7")).error.includes("JPEG or PNG"), true);
  assert.match(imageLib.reencodeVisitorPhoto(Buffer.concat([Buffer.from("....ftypheic"), Buffer.alloc(20)])).error, /HEIC/);
  assert.equal(imageLib.reencodeVisitorPhoto(Buffer.from([0x4d, 0x5a, 0, 0])).error.includes("JPEG or PNG"), true);
});

test("sign-in, sign-out, sheet row, and Joshua-only access", async () => {
  visitLib.setVisitorTestHooks({ collect: true });
  const bytes = photoBytes();
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "=HYPERLINK(\"http://evil\")", name: "Pat Visitor", phone: "0411999888", company: "ACME", issues: "Gate was open", photo: bytes.toString("base64") },
    ip: "203.0.113.21",
  })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(created.body.receipt);
  assert.equal(created.body.phone, undefined);
  assert.equal(JSON.stringify(created.body).includes("photo/"), false);
  assert.equal(JSON.stringify(created.body).includes("0411999888"), false);
  const getOut = await publicFn(req("GET", "/api/visit/sign-out"));
  assert.equal(getOut.status, 405);
  const noCard = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: false }, ip: "203.0.113.22" })));
  assert.equal(noCard.status, 400);
  const visits = await lib.visitorStore().list({ prefix: "visit/" });
  const visit = await lib.visitorStore().get(visits.blobs[0].key, { type: "json" });
  assert.equal(visit.cardReturned, false);
  assert.equal(visit.signedOutAt, "");
  assert.equal(visit.photoStatus, "stored");
  assert.equal(String(visit.location).startsWith("'="), false);
  const sheetValues = sheetLib.sheetRowValues(visit, () => "time");
  assert.equal(sheetValues[1].startsWith("'="), true);
  assert.equal(sheetValues[10], "");
  assert.equal(sheetValues[11], "app-record:" + visit.id);
  assert.equal(String(sheetValues[11]).includes("http"), false);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  const headList = await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: head })));
  assert.equal(headList.status, 403);
  const anon = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visit.id + "/photo")));
  assert.equal(anon.status, 401);
  const neil = await otpCookie(NEIL, "203.0.113.30");
  const neilList = await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: neil })));
  assert.equal(neilList.status, 403);
  const joshua = await otpCookie(JOSHUA, "203.0.113.31");
  const allowed = await read(await adminFn(req("GET", "/api/visitor-log/visits?status=in", { cookie: joshua })));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.visits.length, 1);
  assert.equal(allowed.body.visits[0].phone, "0411999888");
  const photo = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visit.id + "/photo", { cookie: joshua })));
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("cache-control"), "private, no-store");
  assert.equal(photo.body.includes(Buffer.from("GPSLatitude")), false);
  const other = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: neil, body: { enabled: true, events: "both", email: "someone@example.com" } })));
  assert.equal(other.status, 403);
  const badRecipient = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "both", email: NEIL } })));
  assert.equal(badRecipient.status, 400);
  const saved = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "both" } })));
  assert.equal(saved.body.recipient, JOSHUA);
  assert.equal(visitLib.visitorCapability({ kind: "verified-identity", provider: "otp", email: NEIL }), false);
  const signed = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.23" })));
  assert.equal(signed.status, 200);
  assert.equal(signed.body.cardReturned, true);
  const again = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.24" })));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadySignedOut, true);
  const after = await lib.visitorStore().get("visit/" + visit.id, { type: "json" });
  assert.equal(after.signedOutAt, signed.body.signedOutAt);
  assert.equal(after.name, "Pat Visitor");
  const mail = sentMail.find((message) => message.to === JOSHUA);
  assert.ok(mail);
  assert.equal(mail.text.includes("0411999888"), false);
  assert.equal(mail.text.includes("Pat Visitor"), false);
  assert.equal(mail.text.includes("/admin#/visitors/" + visit.id), true);
  assert.equal(mail.text.includes("app-record"), false);
  const appends = sheetCalls.filter((call) => call.url.includes(":append"));
  assert.equal(appends.length, 1);
  const tokenCall = sheetCalls.find((call) => call.url.includes("oauth2.googleapis.com"));
  const assertion = new URLSearchParams(tokenCall.body).get("assertion");
  const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
  assert.equal(payload.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert.equal(payload.scope.includes("drive"), false);
});

test("cleanup deletes a signed-out photo after 90 days and leaves text and open visits", async () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Open site", name: "Still Here", phone: "0411222333", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.40",
  })));
  const openId = (await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => blob.key).find(async () => true);
  const all = await lib.visitorStore().list({ prefix: "visit/" });
  const openVisit = (await Promise.all(all.blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row.name === "Still Here");
  clock += 200 * 24 * 60 * 60 * 1000;
  await visitLib.runVisitorCleanup(clock);
  const still = await lib.visitorStore().get("visit/" + openVisit.id, { type: "json" });
  assert.equal(still.signedOutAt, "");
  assert.equal(still.cardReturned, false);
  assert.equal(still.photoStatus, "stored");
  assert.equal(still.name, "Still Here");
  const signed = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Closed site", name: "Done", phone: "0411000000", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.41",
  })));
  const done = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row.name === "Done");
  await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: signed.body.receipt, cardReturned: true }, ip: "203.0.113.42" }));
  const early = await visitLib.runVisitorCleanup(clock + visitLib.PHOTO_RETENTION_MS - 1000);
  const kept = await lib.visitorStore().get("visit/" + done.id, { type: "json" });
  assert.equal(kept.photoStatus, "stored");
  assert.equal(early.purged, 0);
  await visitLib.runVisitorCleanup(Date.parse(kept.signedOutAt) + visitLib.PHOTO_RETENTION_MS);
  const purged = await lib.visitorStore().get("visit/" + done.id, { type: "json" });
  assert.equal(purged.photoStatus, "purged");
  assert.equal(purged.name, "Done");
  assert.equal(await lib.visitorStore().get("photo/" + done.id, { type: "json" }), null);
  const joshua = await otpCookie(JOSHUA, "203.0.113.43");
  const missing = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + done.id + "/photo", { cookie: joshua })));
  assert.equal(missing.status, 404);
  const audits = await lib.visitorStore().list({ prefix: "audit/" });
  const texts = await Promise.all(audits.blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })));
  const joined = JSON.stringify(texts);
  assert.equal(joined.includes("0411999888"), false);
  assert.equal(joined.includes("GPSLatitude"), false);
  assert.equal(joined.includes(signed.body.receipt), false);
  void created;
  void openId;
});

test("a cross-site post is rejected and a replaced receipt is the only one that signs out", async () => {
  visitLib.setVisitorTestHooks({ collect: true });
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Recovery site", name: "Lost", phone: "0411555666", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.50",
  })));
  const csrf = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, origin: "https://evil.example", ip: "203.0.113.51" })));
  assert.equal(csrf.status, 403);
  const joshua = await otpCookie(JOSHUA, "203.0.113.52");
  const visit = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row.name === "Lost");
  const recovered = await read(await adminFn(req("POST", "/api/visitor-log/visits/" + visit.id + "/recover", { cookie: joshua })));
  assert.equal(recovered.status, 200);
  assert.notEqual(recovered.body.receipt, created.body.receipt);
  const old = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.53" })));
  assert.equal(old.status, 401);
  const fresh = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: recovered.body.receipt, cardReturned: true }, ip: "203.0.113.54" })));
  assert.equal(fresh.status, 200);
  const exported = await read(await adminFn(req("GET", "/api/visitor-log/export", { cookie: joshua })));
  const csv = exported.body.toString();
  assert.equal(csv.includes(recovered.body.receipt), false);
  assert.match(csv, /'=HYPERLINK|Recovery site/);
  assert.equal(csv.includes("data:image"), false);
});

test("concurrent sign-out keeps one timestamp and an unknown mail result is not resent", async () => {
  visitLib.setVisitorTestHooks({ collect: true });
  const calls = [];
  setMailTransport(async (message) => { calls.push(message); return { status: "unknown" }; });
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Race site", name: "Race", phone: "0411777888", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.60",
  })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const pair = await Promise.all([
    read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.61" }))),
    read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.62" }))),
  ]);
  assert.equal(pair.filter((item) => item.status === 200).length, 2);
  const visit = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row.name === "Race");
  assert.equal(visit.cardReturned, true);
  await visitLib.runVisitorCleanup();
  assert.equal(calls.filter((message) => message.text.includes(visit.id) && message.subject.includes("sign-out")).length, 1);
  setMailTransport(async (message) => { sentMail.push(message); return { status: "sent", id: "local-mock" }; });
});
