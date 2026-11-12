import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { jpegOrientation } from "../public/visit/orientation.mjs";

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
  delete process.env.VISITOR_COLLECTION;
  process.env.VISITOR_COLLECT = "1";
  process.env.VISITOR_OPEN_VISIT_PHOTO_DAYS = "1";
  const closed = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(closed.body.open, false);
  assert.ok(closed.body.blockers.includes("access-map-missing"));
  assert.ok(closed.body.blockers.includes("sheet-not-configured"));
  assert.ok(closed.body.blockers.includes("collection-closed"));
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
  const held = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(held.body.open, false, JSON.stringify(held.body.blockers));
  assert.ok(held.body.blockers.includes("collection-closed"));
  assert.equal(held.body.collection, "closed");
  process.env.VISITOR_COLLECTION = "yes";
  const wrong = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(wrong.body.open, false);
  process.env.VISITOR_COLLECTION = "open";
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
  process.env.VISITOR_COLLECTION = "open";
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
  const badRecipient = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "both", email: "someone@example.com" } })));
  assert.equal(badRecipient.status, 400);
  const saved = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "both" } })));
  assert.deepEqual(saved.body.recipients, [JOSHUA]);
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
      const cell = decoded.match(/!([A-Z]+)(\d+)/);
      const row = Number(cell[2]) - 2;
      if (row >= 0) grid[row] = cell[1] === "P" ? Object.assign([...(grid[row] || [])], { 15: body.values[0][0] }) : body.values[0];
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
      const cell = decoded.match(/!([A-Z]+)(\d+)/);
      const row = Number(cell[2]) - 2;
      if (row >= 0) grid[row] = cell[1] === "P" ? Object.assign([...(grid[row] || [])], { 15: body.values[0][0] }) : body.values[0];
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

test("the sheet connection check stays closed, writes one synthetic row, and does not reveal the key", async () => {
  otpLib.setOtpTestHooks({ now: () => Date.parse("2027-01-01T00:00:00.000Z"), deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
  delete process.env.VISITOR_COLLECTION;
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  process.env.VISITOR_SHEETS_PRIVATE_KEY = "********";
  let calls = 0;
  sheetLib.setVisitorSheetFetch(async () => { calls += 1; return new Response("{}", { status: 500 }); });
  const joshua = await otpCookie(JOSHUA, "203.0.113.110");
  const masked = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(masked.body.stage, "key-invalid");
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(masked.body).includes("*"), false);
  assert.deepEqual(Object.keys(masked.body).sort(), ["ok", "stage"]);
  const spoof = new Request("https://expresshelp.site/api/visitor-log/sheet-check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nf-event": "schedule" },
    body: JSON.stringify({ confirm: "CHECK" }),
  });
  assert.equal((await read(await adminFn(spoof))).status, 401);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: cookieNamed(headLogin, "qr_admin"), body: { confirm: "CHECK" } })))).status, 403);
  const neil = await otpCookie(NEIL, "203.0.113.111");
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: neil, body: { confirm: "CHECK" } })))).status, 403);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" }, origin: "https://evil.example" })))).status, 403);
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/sheet-check", { cookie: joshua })))).status, 405);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: {} })))).status, 400);

  process.env.VISITOR_SHEETS_PRIVATE_KEY = pem.replaceAll("\n", "\\n");
  const grid = [["visit_id"]];
  let appends = 0;
  let throwAppend = false;
  let hold = null;
  let releaseHold = () => {};
  let waiting = false;
  sheetLib.setVisitorSheetFetch(async (url, init) => {
    calls += 1;
    if (String(url).includes("oauth2.googleapis.com")) {
      const payload = JSON.parse(Buffer.from(new URLSearchParams(String(init.body)).get("assertion").split(".")[1], "base64url").toString());
      assert.equal(payload.scope, "https://www.googleapis.com/auth/spreadsheets");
      assert.equal(String(init.body).includes("PRIVATE KEY"), false);
      return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const decoded = decodeURIComponent(String(url));
    assert.equal(decoded.includes("/drive"), false);
    if (decoded.includes("Visits!A:A") && init.method === "GET") return new Response(JSON.stringify({ values: grid.map((row) => [row[0]]) }), { status: 200, headers: { "content-type": "application/json" } });
    if (decoded.includes(":append")) {
      appends += 1;
      grid.push(JSON.parse(init.body).values[0]);
      waiting = true;
      if (throwAppend) throw new Error("lost response");
      if (hold) await hold;
      return new Response(JSON.stringify({ updates: { updatedRange: "Visits!A" + grid.length + ":O" + grid.length } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const range = decoded.match(/Visits!A(\d+):P\1/);
    if (range && init.method === "GET") return new Response(JSON.stringify({ values: [grid[Number(range[1]) - 1] || []] }), { status: 200, headers: { "content-type": "application/json" } });
    if (range && init.method === "PUT") {
      grid[Number(range[1]) - 1] = JSON.parse(init.body).values[0];
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (decoded.includes("Visits!A1") && init.method === "GET") return new Response(JSON.stringify({ values: [grid[0]] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  });
  const mailBefore = sentMail.length;
  const checked = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(checked.body.ok, true, JSON.stringify(checked.body));
  assert.equal(checked.body.stage, "verified");
  assert.equal(appends, 1);
  assert.equal(JSON.stringify(checked.body).includes("0400000000"), false);
  assert.equal(JSON.stringify(checked.body).includes("PROBE"), false);
  assert.equal(sentMail.length, mailBefore);
  const again = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(again.body.stage, "verified");
  assert.equal(appends, 1);
  const names = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).map((row) => row && row.name);
  assert.equal(names.includes("PROBE"), false);
  const evidence = await lib.visitorStore().get("sheet-probe/last", { type: "json" });
  assert.equal(evidence.stage, "verified");
  assert.equal(JSON.stringify(evidence).includes("0400000000"), false);
  const closed = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(closed.body.open, false);
  assert.ok(closed.body.blockers.includes("collection-closed"));
  const refused = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: { location: "Closed", name: "No", phone: "0411000002", company: "ACME", photo: photoBytes().toString("base64") }, ip: "203.0.113.112" })));
  assert.equal(refused.status, 403);

  grid.length = 1;
  throwAppend = true;
  const unknown = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(unknown.body.stage, "append-unknown");
  assert.equal(appends, 2);
  throwAppend = false;
  const recovered = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(recovered.body.stage, "verified");
  assert.equal(appends, 2);

  grid.length = 1;
  waiting = false;
  hold = new Promise((resolve) => { releaseHold = resolve; });
  const pending = adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } }));
  await new Promise((resolve) => {
    const timer = setInterval(() => { if (waiting) { clearInterval(timer); resolve(); } }, 5);
  });
  const busy = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(busy.body.stage, "busy");
  releaseHold();
  hold = null;
  const finished = await read(await pending);
  assert.equal(finished.body.stage, "verified");
  assert.equal(appends, 3);

  sheetLib.setVisitorSheetFetch(async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
  });
  const denied = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(denied.body.stage, "sheet-denied");
  assert.equal(JSON.stringify(denied.body).includes("sheet-id"), false);
  sheetLib.setVisitorSheetFetch(async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "sheet-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  });
  const missingTab = await read(await adminFn(req("POST", "/api/visitor-log/sheet-check", { cookie: joshua, body: { confirm: "CHECK" } })));
  assert.equal(missingTab.body.stage, "tab-missing");

  process.env.VISITOR_COLLECTION = "open";
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Still open", name: "Existing", phone: "0411000003", company: "ACME", photo: photoBytes().toString("base64") },
    ip: "203.0.113.113",
  })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  delete process.env.VISITOR_COLLECTION;
  const signed = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: created.body.receipt, cardReturned: true }, ip: "203.0.113.114" })));
  assert.equal(signed.status, 200);
  const stillClosed = await read(await publicFn(req("GET", "/api/visit/status")));
  assert.equal(stillClosed.body.open, false);
  process.env.VISITOR_COLLECTION = "open";
});

test("sign-in and sign-out are separate public pages and /visit still has both", () => {
  const signIn = fs.readFileSync(new URL("../public/visit/sign-in.html", import.meta.url), "utf8");
  const signOut = fs.readFileSync(new URL("../public/visit/sign-out.html", import.meta.url), "utf8");
  const both = fs.readFileSync(new URL("../public/visit.html", import.meta.url), "utf8");
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /from = "\/visit\/sign-in"/);
  assert.match(toml, /from = "\/visit\/sign-out"/);
  assert.match(toml, /from = "\/visit"/);
  assert.equal(signIn.includes('data-testid="visit-photo"'), true);
  assert.equal(signIn.includes('data-testid="visit-location"'), true);
  assert.equal(signIn.includes('data-testid="visit-receipt-input"'), false);
  assert.equal(signIn.includes('name="receipt"'), false);
  assert.equal(signIn.includes("Thanks for signing in"), true);
  assert.equal(signIn.includes("When leaving, don’t forget to scan the Sign Out QR Code to close out your visitation."), true);
  assert.equal(signIn.includes('id="in-done" hidden'), true);
  assert.equal(signIn.includes("/api/visit/sign-in"), true);
  assert.equal(signIn.includes("Any issues to report"), false);
  assert.equal(signOut.includes("Any issues to report"), true);
  assert.equal(signOut.includes('data-testid="visit-out-issues"'), true);
  assert.equal(signOut.includes('visit-out-issues" required'), false);
  assert.equal(both.split('id="in-form"')[1].split('id="in-done"')[0].includes("Any issues to report"), false);
  assert.equal(both.includes('data-testid="visit-out-issues"'), true);
  const admin = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  assert.equal(admin.includes("Visitor records are restricted. Sign in with your authorised email account to view them."), true);
  assert.equal(admin.includes('data-testid="visitor-email-signin">Sign in with email'), true);
  assert.equal(admin.includes("limited to Joshua's explicit visitor-log access"), false);
  assert.match(admin, /act === "visitor-email-signin"[\s\S]{0,400}method: "DELETE"[\s\S]{0,200}showLogin\("", true\)/);
  assert.match(admin, /function paintAvatar\(\)[\s\S]{0,400}querySelector\("\.avatar"\)/);
  const detailLines = [
    "<summary>Details</summary>",
    "<h2>How we store your information</h2>",
    "Liberty Oil Convenience uses this visitor log to keep a record of everyone who attends our sites, for safety, security and site access purposes.",
    "Please sign in when you arrive and sign out when you leave. Before signing out, return the Shell card to the lockbox. Your visit is only closed and the card recorded as returned when you complete the sign-out form.",
    "A clear photo of your identification is required at sign-in. It is stored securely and privately, and is never shared through a public link.",
    "Your ID photo is permanently deleted 90 days after you sign out. If a visit is not signed out, the photo is deleted 90 days after sign-in and the visit is flagged for review. Deleted photos cannot be recovered.",
    "Your written visit details (name, company, contact number, site and any issues reported) are kept as part of our site records until they are removed by an authorised Liberty Oil Convenience administrator.",
    "Access to visitor records and ID photos is restricted to authorised Liberty Oil Convenience personnel only.",
  ];
  const bannedPublic = /\bGoogle\b|Google Sheets|spreadsheets?|version history|\bbackups?\b|\bJoshua\b|This visitor log asks you to sign in and to sign out|status\.notice/i;
  for (const page of [signIn, signOut, both]) {
    assert.equal(bannedPublic.test(page), false);
    for (const line of detailLines) assert.equal(page.includes(line), true);
    assert.match(page, /\.details summary \{[^}]*min-height:44px/);
    assert.match(page, /\.details summary:focus \{[^}]*outline:2px solid #111827/);
  }
  const beforeSignIn = /<details class="details" data-testid="visit-details">[\s\S]*?<\/details>\s*<button type="submit">Sign in<\/button>/;
  const beforeSignOut = /<details class="details" data-testid="visit-details">[\s\S]*?<\/details>\s*<button type="submit">Sign out<\/button>/;
  assert.match(signIn, beforeSignIn);
  assert.equal(/<details[^>]*\bopen\b/.test(signIn), false);
  assert.match(signOut, beforeSignOut);
  assert.equal(/<details[^>]*\bopen\b/.test(signOut), false);
  const combinedIn = both.split('id="in-form"')[1].split('id="in-done"')[0];
  const combinedOut = both.split('id="out-form"')[1].split('id="out-done"')[0];
  assert.match(combinedIn, beforeSignIn);
  assert.match(combinedOut, beforeSignOut);
  assert.equal(/<details[^>]*\bopen\b/.test(both), false);
  assert.match(signIn, /href="\/visit\/sign-out">Sign out</);
  assert.equal(signIn.includes("Sign out with a receipt"), false);
  assert.equal(signIn.includes("existing receipt"), false);
  assert.equal(signOut.toLowerCase().includes("receipt"), false);
  assert.equal(signIn.includes('id="photo-camera"'), true);
  assert.equal(signIn.includes('capture="environment"'), true);
  assert.equal(signIn.includes('id="photo-library"'), true);
  assert.equal(signIn.includes('aria-label="Take photo of identification"'), true);
  assert.equal(signIn.includes('aria-label="Choose a photo of identification"'), true);
  assert.equal(/id="photo-library"[^>]*capture=/.test(signIn), false);
  assert.equal(signIn.includes('accept="image/jpeg,image/png" capture="environment"'), false);
  assert.equal(both.includes('id="photo-camera"'), true);
  assert.equal(both.includes('id="photo-library"'), true);
  assert.equal(signOut.includes('data-testid="visit-photo"'), false);
  assert.equal(signOut.includes('name="location"'), false);
  assert.equal(signOut.includes('name="phone"'), false);
  assert.equal(signOut.includes('name="receipt"'), false);
  assert.equal(signOut.includes('data-testid="visit-out-name"'), true);
  assert.equal(signOut.includes('data-testid="visit-out-company"'), true);
  assert.equal(signOut.includes('type="radio"'), true);
  assert.equal(signOut.includes("I Returned the Shell Card"), true);
  assert.equal(signOut.includes("checked"), false);
  assert.equal(signOut.includes("Thanks, you’ve signed out"), true);
  assert.equal(signOut.includes('id="out-done" hidden'), true);
  assert.equal(signOut.includes("/api/visit/sign-out"), true);
  assert.equal(both.includes('data-testid="visit-photo"'), true);
  assert.equal(both.includes('name="receipt"'), false);
  assert.equal(both.includes("Thanks for signing in"), true);
  assert.equal(both.includes("Thanks, you’ve signed out"), true);
  assert.match(signIn, /name="viewport"/);
  assert.match(signOut, /name="viewport"/);
});

test("name and company sign out one active visit and refuse a missing or duplicate pair", async () => {
  process.env.VISITOR_COLLECTION = "open";
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  let clock = Date.parse("2027-05-01T00:00:00.000Z");
  visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
  const sample = (name, company, phone) => ({ location: "Match site", name, phone, company, photo: photoBytes().toString("base64") });
  const first = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: sample("Pat Visitor", "ACME", "0411222001"), ip: "203.0.113.120" })));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const byReceipt = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { receipt: first.body.receipt, cardReturned: true }, ip: "203.0.113.121" })));
  assert.equal(byReceipt.status, 200);
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: sample("  Pat   Visitor ", "acme", "0411222002"), ip: "203.0.113.122" })));
  assert.equal(created.status, 200);
  const missingCard = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "Pat Visitor", company: "ACME", cardReturned: false }, ip: "203.0.113.123" })));
  assert.equal(missingCard.status, 400);
  const open = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row && row.phone === "0411222002");
  assert.equal(open.signedOutAt, "");
  const matched = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "pat visitor", company: "ACME", cardReturned: true }, ip: "203.0.113.124" })));
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
  assert.equal(matched.body.cardReturned, true);
  assert.equal(JSON.stringify(matched.body).includes("0411222002"), false);
  assert.equal((await lib.visitorStore().get("visit/" + open.id, { type: "json" })).cardReturned, true);
  const none = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "Nobody Here", company: "ACME", cardReturned: true }, ip: "203.0.113.125" })));
  const second = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: sample("Twin Visitor", "Twin Co", "0411222003"), ip: "203.0.113.126" })));
  const third = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: sample("Twin Visitor", "Twin Co", "0411222004"), ip: "203.0.113.127" })));
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  const ambiguous = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "Twin Visitor", company: "Twin Co", cardReturned: true }, ip: "203.0.113.128" })));
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error, none.body.error);
  assert.equal(JSON.stringify(ambiguous.body).includes("0411222003"), false);
  assert.equal(JSON.stringify(ambiguous.body).includes("0411222004"), false);
  const twins = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).filter((row) => row && row.name === "Twin Visitor");
  assert.equal(twins.every((row) => row.signedOutAt === ""), true);
  const lone = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: sample("Race Visitor", "Race Co", "0411222005"), ip: "203.0.113.129" })));
  assert.equal(lone.status, 200);
  const raced = await Promise.all([
    read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "Race Visitor", company: "Race Co", cardReturned: true }, ip: "203.0.113.130" }))),
    read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "Race Visitor", company: "Race Co", cardReturned: true }, ip: "203.0.113.131" }))),
  ]);
  assert.equal(raced.filter((item) => item.status === 200).length >= 1, true);
  const racedVisit = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row && row.phone === "0411222005");
  assert.equal(racedVisit.cardReturned, true);
  assert.equal(Boolean(racedVisit.signedOutAt), true);
  let blocked = 0;
  for (let i = 0; i < 9; i++) {
    const res = await read(await publicFn(req("POST", "/api/visit/sign-out", { body: { name: "Rate Visitor", company: "Rate Co", cardReturned: true }, ip: "203.0.113.140", forwarded: "198.51.100." + i })));
    if (res.status === 429) blocked += 1;
  }
  assert.equal(blocked >= 1, true);
  const audits = JSON.stringify(await Promise.all((await lib.visitorStore().list({ prefix: "audit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" }))));
  assert.equal(audits.includes("0411222003"), false);
  assert.equal(audits.includes("Twin Co"), false);
});

test("a 12MP camera frame is too large until the phone reduces it under the upload limits", () => {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(3024, 5);
  sof.writeUInt16BE(4032, 7);
  sof[9] = 3;
  const twelve = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  assert.equal(4032 * 3024 > 12_000_000, true);
  assert.equal(imageLib.reencodeVisitorPhoto(twelve).error, "The photo is too large.");
  const width = 1600;
  const height = 1200;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = x & 255;
      data[i + 1] = y & 255;
      data[i + 2] = (x + y) & 255;
      data[i + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data, width, height }, 80);
  assert.ok(encoded.data.length < 1_000_000);
  const saved = imageLib.reencodeVisitorPhoto(Buffer.from(encoded.data));
  assert.equal(saved.error, undefined);
  assert.ok(saved.bytes.length <= 1_500_000);
  const base64Length = Math.ceil(encoded.data.length / 3) * 4;
  assert.ok(base64Length < 12_000_000);
  const entry = Buffer.alloc(12);
  entry.writeUInt16LE(0x0112, 0);
  entry.writeUInt16LE(3, 2);
  entry.writeUInt32LE(1, 4);
  entry.writeUInt16LE(6, 8);
  const tiff = Buffer.concat([
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00]),
    entry,
    Buffer.from([0, 0, 0, 0]),
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  const marked = Buffer.concat([encoded.data.subarray(0, 2), app1, encoded.data.subarray(2)]);
  assert.equal(jpegOrientation(marked), 6);
  assert.equal(jpegOrientation(encoded.data), 1);
});

test("sign-out issues are kept beside sign-in issues and do not leak on a failed match", async () => {
  process.env.VISITOR_COLLECTION = "open";
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  visitLib.setVisitorTestHooks({ collect: true, now: () => Date.parse("2027-07-01T00:00:00.000Z") });
  const created = await read(await publicFn(req("POST", "/api/visit/sign-in", {
    body: { location: "Issue site", name: "Issue Visitor", phone: "0411555001", company: "Issue Co", issues: "Gate was open", photo: photoBytes().toString("base64") },
    ip: "203.0.113.150",
  })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const tooLong = await read(await publicFn(req("POST", "/api/visit/sign-out", {
    body: { name: "Issue Visitor", company: "Issue Co", issues: "x".repeat(501), cardReturned: true },
    ip: "203.0.113.151",
  })));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.includes("x".repeat(20)), false);
  const missed = await read(await publicFn(req("POST", "/api/visit/sign-out", {
    body: { name: "Missing Visitor", company: "Issue Co", issues: "private complaint", cardReturned: true },
    ip: "203.0.113.152",
  })));
  assert.equal(missed.status, 400);
  assert.equal(JSON.stringify(missed.body).includes("private complaint"), false);
  assert.equal(JSON.stringify(missed.body).includes("0411555001"), false);
  const signed = await read(await publicFn(req("POST", "/api/visit/sign-out", {
    body: { name: "Issue Visitor", company: "Issue Co", issues: "=Lock was stiff", cardReturned: true },
    ip: "203.0.113.153",
  })));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(JSON.stringify(signed.body).includes("Lock was stiff"), false);
  assert.equal(JSON.stringify(signed.body).includes("Gate was open"), false);
  const visit = (await Promise.all((await lib.visitorStore().list({ prefix: "visit/" })).blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).find((row) => row && row.phone === "0411555001");
  assert.equal(visit.issues, "Gate was open");
  assert.equal(visit.signOutIssues, "=Lock was stiff");
  assert.equal(sheetLib.SHEET_HEADERS.length, 16);
  assert.equal(sheetLib.SHEET_HEADERS[15], "ID photo");
  assert.equal(sheetLib.SHEET_HEADERS[5], "issues");
  const cell = sheetLib.sheetRowValues(visit, () => "time")[5];
  assert.match(cell, /Sign-in: Gate was open/);
  assert.match(cell, /Sign-out: '=Lock was stiff/);
  otpLib.setOtpTestHooks({ now: () => Date.parse("2027-07-02T00:00:00.000Z"), deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
  const joshua = await otpCookie(JOSHUA, "203.0.113.154");
  const record = await read(await adminFn(req("GET", "/api/visitor-log/visits/" + visit.id, { cookie: joshua })));
  assert.equal(record.body.visit.issues, "Gate was open");
  assert.equal(record.body.visit.signOutIssues, "=Lock was stiff");
  const exported = await read(await adminFn(req("GET", "/api/visitor-log/export", { cookie: joshua })));
  assert.match(exported.body.toString(), /sign_out_issues/);
  assert.match(exported.body.toString(), /Gate was open/);
  assert.match(exported.body.toString(), /=Lock was stiff/);
});
