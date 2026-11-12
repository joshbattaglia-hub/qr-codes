import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jpeg from "jpeg-js";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
process.env.VISITOR_COLLECTION = "open";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const SHEET_ID = "1SyntheticSheetIdForTestsOnly_0123456789ab";
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.VISITOR_SHEETS_SPREADSHEET_ID = SHEET_ID;
process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [NEIL]: { approverKey: "neil", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
const sheetLib = await import("../netlify/lib/visitor-sheet.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const publicFn = (await import("../netlify/functions/visitor-public.mjs")).default;
const adminFn = (await import("../netlify/functions/visitor-admin.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;
const otpMail = [];
let clock = Date.parse("2026-11-12T01:00:00.000Z");
otpLib.setOtpTestHooks({ now: () => clock, deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
visitLib.setVisitorTestHooks({ collect: true, now: () => clock });
const mail = [];
setMailTransport(async (message) => { mail.push(message); return { status: "sent", id: "fake" }; });

// Fake Visits tab: grid[0] is the header row (sheet row 1). Records every request.
const OLD_HEADER = sheetLib.SHEET_HEADERS.slice(0, 15);
let grid = [];
const calls = [];
const COLS = "ABCDEFGHIJKLMNOP";
function respond(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
sheetLib.setVisitorSheetFetch(async (url, init) => {
  if (String(url).includes("oauth2.googleapis.com")) return respond({ access_token: "sheet-token", expires_in: 3600 });
  const decoded = decodeURIComponent(String(url));
  assert.ok(decoded.includes("/spreadsheets/" + SHEET_ID + "/values/Visits!"), decoded);
  const range = decoded.split("/values/")[1].split("?")[0].replace(":append", "");
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push(init.method + " " + range);
  if (decoded.includes(":append")) {
    assert.equal(range, "Visits!A:P");
    grid.push([...body.values[0]]);
    return respond({ updates: { updatedRange: "Visits!A" + grid.length + ":P" + grid.length } });
  }
  let match;
  if ((match = range.match(/^Visits!([A-P]):\1$/))) {
    const col = COLS.indexOf(match[1]);
    if (init.method !== "GET") return respond({}, 400);
    return respond({ values: grid.map((row) => [row[col] ?? ""]) });
  }
  if ((match = range.match(/^Visits!([A-P])(\d+)(?::([A-P])\2)?$/))) {
    const start = COLS.indexOf(match[1]);
    const end = match[3] ? COLS.indexOf(match[3]) : start;
    const r = Number(match[2]) - 1;
    if (init.method === "GET") return respond({ values: [(grid[r] || []).slice(start, end + 1)] });
    if (init.method === "PUT") {
      assert.match(decoded, /valueInputOption=RAW/);
      while (grid.length <= r) grid.push([]);
      const row = [...grid[r]];
      body.values[0].forEach((value, i) => { row[start + i] = value; });
      grid[r] = row;
      return respond({});
    }
  }
  return respond({}, 400);
});

let ipSeq = 0;
function req(method, url, { cookie = "", body, origin } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  headers.set("x-nf-client-connection-ip", "2001:db8:5eed::" + (++ipSeq).toString(16));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function read(res) {
  return { status: res.status, body: await res.json() };
}
async function otpCookie(email) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }));
  assert.equal(started.status, 200);
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  return cookieNamed(verified, "qr_otp");
}
function photoBytes() {
  return Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80).data);
}
async function clearStore() {
  for (const prefix of ["visit/", "photo/", "receipt/", "sheet-migration/", "notify/", "audit/"]) {
    const { blobs } = await lib.visitorStore().list({ prefix });
    for (const blob of blobs) await lib.visitorStore().delete(blob.key);
  }
}
async function signIn(name) {
  const res = await read(await publicFn(req("POST", "/api/visit/sign-in", { body: { location: "Example Site", name, phone: "0400 000 000", company: "Example Co", photo: photoBytes().toString("base64") } })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
  const visits = await Promise.all(blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })));
  return visits.find((row) => row.name === name);
}

test("ID photo cell: private record link while stored, Photo deleted after purge, No photo otherwise", () => {
  const id = "v" + "1".repeat(32);
  assert.deepEqual([sheetLib.ID_PHOTO_COLUMN, sheetLib.ID_PHOTO_HEADER, sheetLib.SHEET_HEADERS.indexOf("ID photo")], ["P", "ID photo", 15]);
  assert.equal(sheetLib.idPhotoCell({ id, photoStatus: "stored" }), "https://expresshelp.site/admin#/visitors/" + id);
  assert.equal(sheetLib.idPhotoCell({ id, photoStatus: "purged" }), "Photo deleted");
  assert.equal(sheetLib.idPhotoCell({ id, photoStatus: "" }), "No photo");
  assert.equal(sheetLib.idPhotoCell({ id }), "No photo");
  assert.equal(sheetLib.idPhotoCell({ id, photoStatus: "stored", deleted: true }), "");
  const values = sheetLib.sheetRowValues({ id, location: "X", name: "Synthetic", phone: "0400 000 000", company: "Co", signedInAt: "2026-11-12T00:00:00.000Z", photoStatus: "stored" }, () => "time");
  assert.equal(values.length, 16);
  assert.equal(values[15], values[11], "same private admin record link as record_url");
  for (const forbidden of ["?", "photo/", "IMAGE", "token", "base64", "data:"]) assert.equal(values[15].includes(forbidden), false, forbidden);
  assert.equal(sheetLib.deletedRowValues(id).length, 16);
  assert.equal(sheetLib.deletedRowValues(id)[15], "");
});

test("a new sign-in fills column P, adds only the P1 header to an existing header, and purge changes P to Photo deleted", async () => {
  await clearStore();
  grid = [[...OLD_HEADER]];
  calls.length = 0;
  const visit = await signIn("Synthetic New");
  assert.deepEqual(grid[0].slice(0, 15), OLD_HEADER, "A1:O1 untouched");
  assert.equal(grid[0][15], "ID photo");
  assert.ok(calls.includes("PUT Visits!P1"));
  assert.equal(calls.includes("PUT Visits!A1:P1"), false);
  assert.equal(grid.length, 2);
  assert.equal(grid[1][0], visit.id);
  assert.equal(grid[1][15], "https://expresshelp.site/admin#/visitors/" + visit.id);
  // 90 days later the cleanup purges the photo and the cell becomes "Photo deleted".
  clock += 91 * 24 * 60 * 60 * 1000;
  const cleaned = await visitLib.runVisitorCleanup(clock);
  assert.equal(cleaned.purged, 1);
  assert.equal(grid.length, 2, "no duplicate row");
  assert.equal(grid[1][0], visit.id);
  assert.equal(grid[1][12], "purged");
  assert.equal(grid[1][15], "Photo deleted");
  clock = Date.parse("2026-11-12T01:00:00.000Z");
});

test("a blank sheet gets the full 16-column header", async () => {
  await clearStore();
  grid = [];
  await signIn("Synthetic Blank");
  assert.deepEqual(grid[0], sheetLib.SHEET_HEADERS);
  assert.equal(grid[1][15].startsWith("https://expresshelp.site/admin#/visitors/v"), true);
});

test("backfill writes column P only for existing synced rows, matched by visit_id, and reads it back", async () => {
  await clearStore();
  const ids = Array.from({ length: 5 }, (_, i) => "v" + String(i + 1).repeat(32).slice(0, 32).padEnd(32, "0").replace(/[^0-9a-f]/g, "a"));
  const base = { location: "Example Site", name: "Synthetic", phone: "0400 000 000", company: "Example Co", signedInAt: "2026-11-10T00:00:00.000Z", sheetSync: "synced" };
  const visits = [
    { ...base, id: ids[0], photoStatus: "stored", sheetRow: 3 },
    { ...base, id: ids[1], photoStatus: "purged", sheetRow: 4 },
    { ...base, id: ids[2], photoStatus: "stored", sheetRow: 9 }, // stale row number; found by id in row 5
    { ...base, id: ids[3], photoStatus: "stored", sheetRow: 0, sheetSync: "pending" }, // not yet synced: skipped
    { ...base, id: ids[4], photoStatus: "stored", sheetRow: 6, deleted: true }, // deleted: skipped
  ];
  for (const visit of visits) await lib.visitorStore().setJSON("visit/" + visit.id, visit);
  const oldRow = (visit) => sheetLib.sheetRowValues(visit, () => "time").slice(0, 15);
  grid = [
    [...OLD_HEADER],
    ["v" + "0".repeat(32), "", "", "", "", "", "", "", "", "", "", "", "deleted", "", ""],
    oldRow(visits[0]),
    oldRow(visits[1]),
    oldRow(visits[2]),
    sheetLib.deletedRowValues(ids[4]).slice(0, 15),
  ];
  const before = grid.map((row) => [...row]);
  calls.length = 0;
  const mailBefore = mail.length;
  const result = await visitLib.runIdPhotoBackfill();
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.written, 3);
  assert.equal(result.header, "ID photo");
  assert.deepEqual(result.rows.map((row) => [row.row, row.outcome, row.idMatches, row.readBack]), [
    [3, "written", true, "record-link"],
    [4, "written", true, "Photo deleted"],
    [5, "written", true, "record-link"],
  ]);
  assert.equal(JSON.stringify(result).includes("Synthetic"), false, "no visitor details in the result");
  assert.equal(JSON.stringify(result).includes("0400"), false);
  // Only P cells were written; A:O, row order and row count unchanged; no appends.
  assert.equal(grid.length, before.length);
  grid.forEach((row, i) => assert.deepEqual(row.slice(0, 15), before[i].slice(0, 15), "row " + (i + 1)));
  assert.equal(grid[0][15], "ID photo");
  assert.equal(grid[2][15], "https://expresshelp.site/admin#/visitors/" + ids[0]);
  assert.equal(grid[3][15], "Photo deleted");
  assert.equal(grid[4][15], "https://expresshelp.site/admin#/visitors/" + ids[2]);
  assert.equal(grid[1][15], undefined);
  assert.equal(grid[5][15], undefined);
  const writes = calls.filter((call) => !call.startsWith("GET"));
  assert.deepEqual(writes, ["PUT Visits!P1", "PUT Visits!P3", "PUT Visits!P4", "PUT Visits!P5"]);
  assert.equal(mail.length, mailBefore);
  const marker = await lib.visitorStore().get("sheet-migration/id-photo-v1", { type: "json" });
  assert.equal(marker.done, true);
  assert.equal(marker.written, 3);
  // The daily cleanup does not run it again once done.
  calls.length = 0;
  const cleanup = await visitLib.runVisitorCleanup(clock);
  assert.equal(cleanup.idPhotoColumn, "already-done");
  assert.equal(calls.some((call) => call.includes("!P")), false);
});

test("the admin fill button is Joshua-only and idempotent", async () => {
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-photo-backfill", { body: { confirm: "BACKFILL" } })))).status, 401);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-photo-backfill", { cookie: cookieNamed(headLogin, "qr_admin"), body: { confirm: "BACKFILL" } })))).status, 403);
  const neil = await otpCookie(NEIL);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-photo-backfill", { cookie: neil, body: { confirm: "BACKFILL" } })))).status, 403);
  const joshua = await otpCookie(JOSHUA);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/sheet-photo-backfill", { cookie: joshua, body: {} })))).status, 400);
  assert.equal((await adminFn(req("POST", "/api/visitor-log/sheet-photo-backfill", { cookie: joshua, origin: "https://evil.example", body: { confirm: "BACKFILL" } }))).status, 403);
  const before = grid.map((row) => [...row]);
  const again = await read(await adminFn(req("POST", "/api/visitor-log/sheet-photo-backfill", { cookie: joshua, body: { confirm: "BACKFILL" } })));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.status, "ok");
  assert.equal(again.body.written, 0);
  assert.ok(again.body.rows.length >= 3);
  assert.ok(again.body.rows.every((row) => row.outcome === "already-set" && row.idMatches));
  assert.deepEqual(grid, before);
});

test("notification email adds the spreadsheet link from the configured ID and still has no visitor details", async () => {
  await clearStore();
  grid = [[...sheetLib.SHEET_HEADERS]];
  const joshua = await otpCookie(JOSHUA);
  const saved = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "in" } })));
  assert.equal(saved.status, 200);
  const before = mail.length;
  await signIn("Synthetic Notify Name");
  const sent = mail.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JOSHUA);
  assert.match(sent[0].text, /^Record: https:\/\/expresshelp\.site\/admin#\/visitors\/v[a-f0-9]{32}$/m);
  assert.match(sent[0].text, new RegExp("^View visitor log spreadsheet: https://docs\\.google\\.com/spreadsheets/d/" + SHEET_ID + "/edit$", "m"));
  for (const detail of ["Synthetic Notify Name", "0400", "Example Co"]) assert.equal(sent[0].text.includes(detail), false, detail);
  assert.equal(sheetLib.sheetUrl("bad id with spaces"), "");
  assert.equal(sheetLib.sheetUrl(""), "");
  assert.equal(sheetLib.sheetUrl(SHEET_ID), "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/edit");
  // Turn notifications back off.
  await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: false } }));
  const off = mail.length;
  await signIn("Synthetic Quiet");
  assert.equal(mail.length, off);
});

test("notification recipient: defaults to Joshua, exact @libertyretail.com.au only, audited old > new, used for sending", async () => {
  await clearStore();
  grid = [[...sheetLib.SHEET_HEADERS]];
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/settings", { body: { recipient: "maint.one@libertyretail.com.au" } })))).status, 401);
  const neil = await otpCookie(NEIL);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: neil, body: { recipient: "maint.one@libertyretail.com.au" } })))).status, 403);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/settings", { cookie: cookieNamed(headLogin, "qr_admin") })))).status, 403);
  const joshua = await otpCookie(JOSHUA);
  const start = await read(await adminFn(req("GET", "/api/visitor-log/settings", { cookie: joshua })));
  assert.deepEqual(start.body, { enabled: false, events: "both", recipient: JOSHUA, domain: "libertyretail.com.au" });
  for (const bad of ["someone@example.com", "x@sub.libertyretail.com.au", "x@libertyretail.com.au.evil.com", "x@libertyretail.com", "a,b@libertyretail.com.au", "a@b@libertyretail.com.au", "two words@libertyretail.com.au", ".dot@libertyretail.com.au", "a..b@libertyretail.com.au"]) {
    const res = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: false, recipient: bad } })));
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error, "Use one exact @libertyretail.com.au email address.");
  }
  assert.equal(visitLib.notifyRecipientOk(" Maint.One@LibertyRetail.com.au "), "maint.one@libertyretail.com.au");
  // Saving without a recipient keeps the current one and records no change.
  const kept = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: false, events: "both" } })));
  assert.equal(kept.body.recipient, JOSHUA);
  const auditRows = async () => {
    const { blobs } = await lib.visitorStore().list({ prefix: "audit/" });
    return (await Promise.all(blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })))).filter((row) => row?.action === "notify-recipient").sort((a, b) => a.at.localeCompare(b.at) || 0);
  };
  assert.equal((await auditRows()).length, 0);
  const changed = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: true, events: "in", recipient: "Maint.One@libertyretail.com.au" } })));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.recipient, "maint.one@libertyretail.com.au");
  let rows = await auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, JOSHUA + " > maint.one@libertyretail.com.au");
  assert.match(rows[0].actorId, /^otp:[a-f0-9]{16}$/);
  const before = mail.length;
  await signIn("Synthetic Recipient Visitor");
  const sent = mail.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "maint.one@libertyretail.com.au");
  assert.equal(sent[0].text.includes("Synthetic Recipient Visitor"), false);
  // Change back to Joshua; audited again; notifications off again.
  clock += 1000;
  const back = await read(await adminFn(req("POST", "/api/visitor-log/settings", { cookie: joshua, body: { enabled: false, recipient: JOSHUA } })));
  assert.equal(back.body.recipient, JOSHUA);
  rows = await auditRows();
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.detail === "maint.one@libertyretail.com.au > " + JOSHUA));
  // A tampered stored recipient falls back to Joshua.
  await lib.visitorStore().setJSON("notify/settings", { enabled: true, events: "both", recipient: "attacker@example.com" });
  const fallback = mail.length;
  await signIn("Synthetic Tamper");
  assert.equal(mail.slice(fallback)[0].to, JOSHUA);
  await lib.visitorStore().setJSON("notify/settings", { enabled: false, events: "both", recipient: JOSHUA });
  clock = Date.parse("2026-11-12T01:00:00.000Z");
});
