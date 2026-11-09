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

function req(method, url, { cookie = "", body, origin, ip, raw, forwarded } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  if (ip) headers.set("x-nf-client-connection-ip", ip);
  if (forwarded) headers.set("x-forwarded-for", forwarded);
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

test("new records stay closed until the access map and sheet exist, and retention is not an env switch", async () => {
  delete process.env.VISITOR_ACCESS_MAP;
  delete process.env.VISITOR_SHEETS_SPREADSHEET_ID;
  process.env.VISITOR_COLLECT = "1";
  process.env.VISITOR_OPEN_VISIT_PHOTO_DAYS = "1";
  const closed = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(closed.body.open, false);
  assert.ok(closed.body.blockers.includes("access-map-missing"));
  assert.ok(closed.body.blockers.includes("sheet-not-configured"));
  assert.equal(closed.body.blockers.includes("open-visit-photo-retention-unresolved"), false);
  assert.match(closed.body.notice, /90 days after sign-out/);
  assert.match(closed.body.notice, /90 days after sign-in/);
  assert.match(closed.body.notice, /until Joshua deletes/);
  assert.equal(closed.body.textRetention, "until Joshua deletes the record");
  assert.equal(closed.headers.get("cache-control"), "private, no-store");
  const refused = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: { location: "Shell Suburb", name: "Pat", phone: "0412345678", company: "ACME", photo: photoBytes().toString("base64") }, ip: "203.0.113.10" })));
  assert.equal(refused.status, 403);
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  const ready = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(ready.body.open, true, JSON.stringify(ready.body.blockers));
  assert.equal(visitLib.PHOTO_RETENTION_MS, 90 * 24 * 60 * 60 * 1000);
});

test("photos are re-encoded and unsafe files are rejected", () => {
  const jpegPhoto = imageLib.reencodeVisitorPhoto(photoBytes());
  assert.equal(jpegPhoto.contentType, "image/jpeg");
  assert.equal(jpegPhoto.bytes.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(jpegPhoto.bytes.includes(Buffer.from([0xff, 0xe1])), false);
  assert.equal(jpegPhoto.bytes[0], 0xff);
  const bomb = Buffer.alloc(32, 0);
  bomb[0] = 0xff; bomb[1] = 0xd8; bomb[2] = 0xff; bomb[3] = 0xc0;
  bomb.writeUInt16BE(17, 4);
  bomb[6] = 8;
  bomb.writeUInt16BE(20000, 7);
  bomb.writeUInt16BE(20000, 9);
  assert.match(imageLib.reencodeVisitorPhoto(bomb).error, /too large/);
  const pngBomb = Buffer.alloc(32, 0);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngBomb);
  pngBomb.write("IHDR", 12, "ascii");
  pngBomb.writeUInt32BE(100000, 16);
  pngBomb.writeUInt32BE(100000, 20);
  assert.match(imageLib.reencodeVisitorPhoto(pngBomb).error, /too large/);
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
  assert.equal(sheetValues[11], "https://expresshelp.site/admin#/visitors/" + visit.id);
  assert.equal(sheetValues[11].includes("?"), false);
  assert.equal(sheetValues[11].includes("photo/"), false);
  assert.equal(sheetValues[11].includes(created.body.receipt), false);
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
  const beforeDeadline = clock + visitLib.PHOTO_RETENTION_MS - 1;
  await visitLib.runVisitorCleanup(beforeDeadline);
  const stillOpen = await lib.visitorStore().get("visit/" + openVisit.id, { type: "json" });
  assert.equal(stillOpen.photoStatus, "stored");
  clock += visitLib.PHOTO_RETENTION_MS;
  await visitLib.runVisitorCleanup(clock);
  const still = await lib.visitorStore().get("visit/" + openVisit.id, { type: "json" });
  assert.equal(still.signedOutAt, "");
  assert.equal(still.cardReturned, false);
  assert.equal(still.photoStatus, "purged");
  assert.equal(still.review, "open-photo-expired");
  assert.equal(still.name, "Still Here");
  assert.equal(await lib.visitorStore().get("photo/" + openVisit.id, { type: "json" }), null);
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

test("open photos expire 90 days after sign-in, a late sign-out cannot restore them, and Joshua can delete the text", async () => {
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  let clock = Date.parse("2026-06-01T00:00:00.000Z");
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  otpLib.setOtpTestHooks({ now: () => clock, deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
  const grid = [];
  const seen = [];
  let appends = 0;
  let throwAfterAppend = true;
  sheetLib.setVisitorSheetAfterAppend(async () => { if (throwAfterAppend) { throwAfterAppend = false; throw new Error("timeout"); } });
  sheetLib.setVisitorSheetFetch(async (url, init) => {
    seen.push(init.method + " " + url);
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (decoded.includes("Visits!A1") && init.method === "GET") return new Response(JSON.stringify({ values: [["visit_id"]] }), { status: 200, headers: { "content-type": "application/json" } });
    if (decoded.includes(":append")) {
      assert.match(decoded, /valueInputOption=RAW/);
      appends += 1;
      grid.push(body.values[0]);
      return new Response(JSON.stringify({ updates: { updatedRange: "Visits!A" + (grid.length + 1) + ":O" + (grid.length + 1) } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (decoded.includes("Visits!A:A") && init.method === "GET") {
      return new Response(JSON.stringify({ values: [["visit_id"], ...grid.map((row) => [row[0]])] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init.method === "PUT") {
      assert.match(decoded, /valueInputOption=RAW/);
      const row = Number(decoded.match(/A(\d+)/)[1]) - 2;
      if (row >= 0) grid[row] = body.values[0];
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  });
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "=cmd", name: "Expiry", phone: "0411888000", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.70",
  })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(appends, 1, seen.join("\n"));
  const visit = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row && row.name === "Expiry");
  assert.equal(visit.sheetSync, "unknown");
  await visitLib.runVisitorCleanup(clock);
  assert.equal(appends, 1);
  assert.equal(grid.length, 1);
  assert.equal(grid[0][1].startsWith("'="), true);
  assert.equal(grid[0][11], "https://expresshelp.site/admin#/visitors/" + visit.id);
  clock += visitLib.PHOTO_RETENTION_MS - 1;
  await visitLib.runVisitorCleanup(clock);
  assert.equal((await lib.visitorStore().get("visit/" + visit.id, { type: "json" })).photoStatus, "stored");
  clock += 1;
  const lateAndCleanup = await Promise.all([
    publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.71" })),
    visitLib.runVisitorCleanup(clock),
  ]);
  const late = await read(lateAndCleanup[0]);
  assert.equal(late.status, 200);
  const after = await lib.visitorStore().get("visit/" + visit.id, { type: "json" });
  assert.equal(after.photoStatus, "purged");
  assert.equal(after.cardReturned, true);
  assert.equal(await lib.visitorStore().get("photo/" + visit.id, { type: "json" }), null);
  const joshua = await otpCookie(JOSHUA, "203.0.113.72");
  const hidden = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visit.id + "/photo", { cookie: joshua })));
  assert.equal(hidden.status, 404);
  const record = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visit.id, { cookie: joshua })));
  assert.equal(record.status, 200);
  assert.equal(record.body.visit.name, "Expiry");
  assert.equal(record.body.recordUrl, grid[0][11]);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const denied = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visit.id, { cookie: cookieNamed(headLogin, "qr_admin") })));
  assert.equal(denied.status, 403);
  const removed = await read(await adminFn(req("POST", "/api/visitor-log/visits/" + visit.id + "/delete", { cookie: joshua, body: { confirm: "DELETE" } })));
  assert.equal(removed.status, 200);
  const gone = await lib.visitorStore().get("visit/" + visit.id, { type: "json" });
  assert.equal(gone.deleted, true);
  assert.equal(gone.name, undefined);
  assert.equal(gone.phone, undefined);
  await visitLib.runVisitorCleanup(clock);
  assert.equal(appends, 1);
  assert.equal(grid[0][2], "");
  assert.equal(grid[0][12], "deleted");
  const audits = JSON.stringify(await Promise.all((await lib.visitorStore().list({ prefix: "audit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" }))));
  assert.equal(audits.includes("0411888000"), false);
  assert.equal(audits.includes(created.body.receipt), false);
  sheetLib.setVisitorSheetAfterAppend(null);
});

test("a failed photo delete is retried, a failed visit write rolls back, and fresh uploads are not treated as orphans", async () => {
  let clock = Date.parse("2026-08-01T00:00:00.000Z");
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  visitLib.setVisitorFaults({ failVisitWrite: 1 });
  const failed = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Rollback", name: "No Record", phone: "0411333444", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.80",
  })));
  assert.equal(failed.status, 503);
  const names = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).map((row) => row && row.name);
  assert.equal(names.includes("No Record"), false);
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Keep", name: "Keep Photo", phone: "0411333555", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.81",
  })));
  assert.equal(created.status, 200);
  await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.82" }));
  const visit = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row && row.name === "Keep Photo");
  clock = Date.parse(visit.signedOutAt) + visitLib.PHOTO_RETENTION_MS;
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  visitLib.setVisitorFaults({ failPhotoDelete: 20 });
  await visitLib.runVisitorCleanup(clock);
  assert.equal((await lib.visitorStore().get("visit/" + visit.id, { type: "json" })).photoStatus, "stored");
  assert.ok(await lib.visitorStore().get("photo/" + visit.id, { type: "json" }));
  visitLib.setVisitorFaults({ failPhotoDelete: 0 });
  await visitLib.runVisitorCleanup(clock);
  assert.equal((await lib.visitorStore().get("visit/" + visit.id, { type: "json" })).photoStatus, "purged");
  await lib.visitorStore().setJSON("photo/orphan-old", { storedAt: new Date(clock - 60 * 60 * 1000).toISOString(), bytes: "eA==" });
  await lib.visitorStore().setJSON("photo/orphan-new", { storedAt: new Date(clock).toISOString(), bytes: "eA==" });
  await visitLib.runVisitorCleanup(clock);
  assert.equal(await lib.visitorStore().get("photo/orphan-old", { type: "json" }), null);
  assert.ok(await lib.visitorStore().get("photo/orphan-new", { type: "json" }));
  const cleanup = await import("../netlify/functions/visitor-cleanup.mjs");
  assert.equal(cleanup.config.schedule, "0 16 * * *");
  let blocked = 0;
  const sample = { location: "Rate", name: "Rate", phone: "0411000111", company: "ACME", photo: photoBytes().toString("base64") };
  for (let i = 0; i < 9; i++) {
    const res = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: sample, forwarded: "198.51.100." + i })));
    if (res.status === 429) blocked += 1;
  }
  assert.equal(blocked, 1);
  otpLib.setOtpTestHooks({ now: () => Date.parse("2026-04-01T00:00:00.000Z"), deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
  const joshua = await otpCookie(JOSHUA, "203.0.113.90");
  const before = await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: joshua })));
  assert.equal(before.status, 200);
  await authFn(req("DELETE", "/api/auth", { cookie: joshua }));
  const after = await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: joshua })));
  assert.equal(after.status, 401);
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: false });
  const restored = await otpCookie(JOSHUA, "203.0.113.91");
  const denied = await read(await adminFn(req("GET", "/api/visitor-log/visits", { cookie: restored })));
  assert.equal(denied.status, 403);
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
});

test("an in-flight sheet append and a pending notification cannot restore a deleted record", async () => {
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  const clock = Date.parse("2026-10-01T00:00:00.000Z");
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  const grid = [];
  let appends = 0;
  sheetLib.setVisitorSheetAfterAppend(async () => {
    const id = grid.at(-1)[0];
    await lib.visitorStore().setJSON("visit/" + id, { id, deleted: true, deletedAt: new Date(clock).toISOString(), photoStatus: "purged", sheetSync: "pending", generation: 2 });
  });
  sheetLib.setVisitorSheetFetch(async (url, init) => {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (decoded.includes("Visits!A1") && init.method === "GET") return new Response(JSON.stringify({ values: [["visit_id"]] }), { status: 200, headers: { "content-type": "application/json" } });
    if (decoded.includes(":append")) {
      appends += 1;
      grid.push(body.values[0]);
      return new Response(JSON.stringify({ updates: { updatedRange: "Visits!A" + (grid.length + 1) + ":O" + (grid.length + 1) } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (decoded.includes("Visits!A:A") && init.method === "GET") return new Response(JSON.stringify({ values: [["visit_id"], ...grid.map((row) => [row[0]])] }), { status: 200, headers: { "content-type": "application/json" } });
    if (init.method === "PUT") {
      const row = Number(decoded.match(/A(\d+)/)[1]) - 2;
      if (row >= 0) grid[row] = body.values[0];
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  });
  const overlapped = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Fence", name: "Must Not Remain", phone: "0411777000", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.100",
  })));
  assert.equal(overlapped.status, 200, JSON.stringify(overlapped.body));
  assert.equal(appends, 1);
  assert.equal(grid[0][2], "");
  assert.equal(grid[0][3], "");
  assert.equal(grid[0][12], "deleted");
  assert.equal(grid[0].join("").includes("0411777000"), false);
  sheetLib.setVisitorSheetAfterAppend(null);
  const joshua = await otpCookie(JOSHUA, "203.0.113.101");
  const saved = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "in" } })));
  assert.equal(saved.status, 200);
  const mail = [];
  setMailTransport(async (message) => { mail.push(message); return { status: "sent", id: "local-mock" }; });
  visitLib.setVisitorTestHooks({
    collect: true,
    now: () => clock,
    beforeNotifySend: async (visit) => {
      await visitLib.deleteVisit({ kind: "verified-identity", provider: "otp", email: JOSHUA, id: "otp:test" }, visit.id);
    },
  });
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Quiet", name: "Do Not Mail", phone: "0411666000", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.102",
  })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(mail.length, 0);
  const visit = await lib.visitorStore().get("visit/" + grid.at(-1)[0], { type: "json" });
  assert.equal(visit.deleted, true);
  assert.equal(visit.name, undefined);
  assert.equal(await lib.visitorStore().get("photo/" + visit.id, { type: "json" }), null);
  assert.equal((await lib.visitorStore().get("notify/" + visit.id + "/in", { type: "json" })).status, "suppressed");
  assert.equal(grid.at(-1)[2], "");
  assert.equal(grid.at(-1)[12], "deleted");
  assert.equal(appends, 2);
  await visitLib.runVisitorCleanup(clock);
  assert.equal(appends, 2);
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  setMailTransport(async (message) => { sentMail.push(message); return { status: "sent", id: "local-mock" }; });
  await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: false, events: "both" } }));
});

test("the sheet private key accepts a multiline PEM and the JSON escaped form", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const escaped = pem.replaceAll("\n", "\\n");
  const quoted = '"' + escaped + '"';
  assert.equal(escaped.includes("\n"), false);
  assert.throws(() => crypto.sign("RSA-SHA256", Buffer.from("fixture"), escaped));
  assert.equal(sheetLib.sheetPrivateKey(pem), pem);
  assert.equal(sheetLib.sheetPrivateKey(escaped), pem);
  assert.equal(sheetLib.sheetPrivateKey(quoted), pem);
  const pub = publicKey.export({ type: "spki", format: "pem" });
  for (const form of [pem, escaped, quoted]) {
    const sig = crypto.sign("RSA-SHA256", Buffer.from("fixture"), sheetLib.sheetPrivateKey(form));
    assert.equal(crypto.verify("RSA-SHA256", Buffer.from("fixture"), pub, sig), true);
  }
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = escaped;
  assert.equal(sheetLib.sheetConfigured(), true);
  let assertion = "";
  sheetLib.setVisitorSheetFetch(async (url, init) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      assertion = new URLSearchParams(String(init.body)).get("assertion");
      return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const decoded = decodeURIComponent(String(url));
    assert.equal(decoded.includes("Visits!"), true);
    if (decoded.includes(":append")) return new Response(JSON.stringify({ updates: { updatedRange: "Visits!A2:O2" } }), { status: 200, headers: { "content-type": "application/json" } });
    if (init.method === "PUT") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ values: [["visit_id"]] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const id = "v" + "ab".repeat(16);
  await lib.visitorStore().setJSON("visit/" + id, { id, location: "Key", name: "Fixture", phone: "0411000001", company: "ACME", signedInAt: "2026-11-09T00:00:00.000Z", photoStatus: "stored", storage: "sheet" });
  const synced = await sheetLib.syncVisitRow({ id }, () => "time");
  assert.equal(synced.status, "synced", JSON.stringify(synced));
  const [header, payload, signature] = assertion.split(".");
  const body = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(body.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(header + "." + payload), pub, Buffer.from(signature, "base64url")), true);
  assert.equal(assertion.includes(pem), false);
  assert.equal(assertion.includes("\\n"), false);
});
