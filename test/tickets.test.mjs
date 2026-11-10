import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;

const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
const STAFF = "screens.staff@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [NEIL]: { approverKey: "neil", siteIds: ["s00000001"] },
  [STAFF]: { preparerClass: "regional-business-manager", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const tickets = await import("../netlify/lib/tickets.mjs");
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;
const otpMail = [];
otpLib.setOtpTestHooks({ deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
tickets.setTicketTestHooks({ now: () => Date.parse("2026-11-10T02:00:00.000Z") });

function req(method, url, { cookie = "", body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
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
  if (type.includes("json")) return { status: res.status, body: await res.json(), headers: res.headers };
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
async function otpCookie(email) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }));
  assert.equal(started.status, 200, JSON.stringify(started.body || started));
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_otp");
}
function photoBytes() {
  const encoded = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80);
  const comment = Buffer.from("GPSLatitude secret-exif", "ascii");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), comment]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([encoded.data.subarray(0, 2), app1, encoded.data.subarray(2)]);
}

test("ticket staff access ignores the shared password and POS roles", async () => {
  await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  const denied = await read(await ticketFn(req("GET", "/api/tickets", { cookie: head })));
  assert.equal(denied.status, 403);
  const neil = await otpCookie(NEIL);
  const neilDenied = await read(await ticketFn(req("GET", "/api/tickets/summary", { cookie: neil })));
  assert.equal(neilDenied.status, 403);
  const joshua = await otpCookie(JOSHUA);
  const settings = await read(await ticketFn(req("GET", "/api/tickets/settings", { cookie: joshua })));
  assert.equal(settings.status, 200);
  assert.equal(settings.body.notify.screens, false);
  assert.equal(settings.body.notify.signage, false);
  assert.equal(settings.body.notifyGlobal, false);
  assert.equal(settings.body.inbound.enabled, false);
  assert.deepEqual(settings.body.types.screens, tickets.DEFAULT_TYPES.screens);
  assert.deepEqual(settings.body.types.signage, tickets.DEFAULT_TYPES.signage);
  assert.deepEqual(settings.body.staff.screens, [JOSHUA]);
  assert.deepEqual(settings.body.staff.signage, [JOSHUA]);
  assert.equal(settings.body.domains[0].domain, "libertyretail.com.au");
  const anonymous = await read(await ticketFn(req("GET", "/api/tickets")));
  assert.equal(anonymous.status, 401);
  const anonymousFile = await read(await ticketFn(req("GET", "/api/tickets/t0123456789abcdef/files/f0123456789abcdef")));
  assert.equal(anonymousFile.status, 401);
  const staffSaved = await read(await ticketFn(req("PUT", "/api/tickets/settings", { cookie: joshua, body: { ...settings.body, staff: { screens: [STAFF], signage: [] } } })));
  assert.equal(staffSaved.status, 200);
  const staffTry = await read(await ticketFn(req("PUT", "/api/tickets/settings", { cookie: neil, body: settings.body })));
  assert.equal(staffTry.status, 403);
  const screens = await otpCookie(STAFF);
  const created = await read(await ticketFn(req("POST", "/api/tickets", { cookie: joshua, body: {
    queue: "screens", siteId: "s00000001", requestType: "Fault or repair", priority: "high", neededBy: "2026-11-01",
    subject: "Example screen fault", description: "The example screen is blank.", requesterEmail: "requester.one@example.com",
  } })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.ticket.overdue, true);
  const waiting = await read(await ticketFn(req("POST", "/api/tickets", { cookie: joshua, body: {
    queue: "screens", siteId: "other", siteOther: "Example pop-up", requestType: "Other", priority: "normal", neededBy: "2026-12-01",
    subject: "Example playlist", description: "Swap the example playlist.", requesterEmail: "requester.two@example.com",
  } })));
  await ticketFn(req("POST", "/api/tickets/" + waiting.body.ticket.id + "/status", { cookie: joshua, body: { status: "awaiting" } }));
  const signage = await read(await ticketFn(req("POST", "/api/tickets", { cookie: joshua, body: {
    queue: "signage", siteId: "s00000001", requestType: "Damage or repair", priority: "urgent", neededBy: "2026-12-01",
    subject: "Example sign damage", description: "An example panel is cracked.", requesterEmail: "requester.one@example.com",
  } })));
  const done = await read(await ticketFn(req("POST", "/api/tickets/" + signage.body.ticket.id + "/status", { cookie: joshua, body: { status: "done" } })));
  assert.equal(done.body.ticket.overdue, false);
  const counts = await read(await ticketFn(req("GET", "/api/tickets/summary?queue=screens", { cookie: joshua })));
  assert.equal(counts.body.open, 2);
  assert.equal(counts.body.awaiting, 1);
  assert.equal(counts.body.overdue, 1);
  const filtered = await read(await ticketFn(req("GET", "/api/tickets?queue=screens&status=awaiting&priority=normal", { cookie: joshua })));
  assert.equal(filtered.body.tickets.length, 1);
  assert.equal(filtered.body.tickets[0].subject, "Example playlist");
  const updatedOk = await read(await ticketFn(req("GET", "/api/tickets?queue=screens&updatedFrom=2026-11-10&updatedTo=2026-11-10", { cookie: joshua })));
  assert.equal(updatedOk.body.tickets.length, 2);
  const updatedMiss = await read(await ticketFn(req("GET", "/api/tickets?queue=screens&updatedTo=2026-11-09", { cookie: joshua })));
  assert.equal(updatedMiss.body.tickets.length, 0);
  const staffList = await read(await ticketFn(req("GET", "/api/tickets", { cookie: screens })));
  assert.equal(staffList.body.tickets.some((row) => row.queue === "signage"), false);
  const hidden = await read(await ticketFn(req("GET", "/api/tickets/" + signage.body.ticket.id, { cookie: screens })));
  assert.equal(hidden.status, 404);
  const noted = await read(await ticketFn(req("POST", "/api/tickets/" + created.body.ticket.id + "/note", { cookie: joshua, body: { text: "Internal supplier chase" } })));
  const raw = await lib.ticketStore().get("ticket/" + created.body.ticket.id, { type: "json" });
  assert.equal(tickets.presentTicket(raw, { staff: false }).messages.some((row) => row.kind === "internal"), false);
  assert.equal(tickets.presentTicket(raw, { staff: true }).messages.some((row) => row.text === "Internal supplier chase"), true);
  assert.equal(noted.body.ticket.messages[0].kind, "internal");
  const uploaded = await read(await ticketFn(req("POST", "/api/tickets/" + created.body.ticket.id + "/file", { cookie: joshua, body: { name: "id.jpg", data: photoBytes().toString("base64") } })));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const fileId = uploaded.body.ticket.files[0].id;
  const anon = await read(await ticketFn(req("GET", "/api/tickets/" + created.body.ticket.id + "/files/" + fileId)));
  assert.equal(anon.status, 401);
  const neilFile = await read(await ticketFn(req("GET", "/api/tickets/" + created.body.ticket.id + "/files/" + fileId, { cookie: neil })));
  assert.equal(neilFile.status, 403);
  const file = await read(await ticketFn(req("GET", "/api/tickets/" + created.body.ticket.id + "/files/" + fileId, { cookie: joshua })));
  assert.equal(file.status, 200);
  assert.equal(file.body.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(String(file.headers.get("cache-control")).includes("private"), true);
  const badPdf = await read(await ticketFn(req("POST", "/api/tickets/" + created.body.ticket.id + "/file", { cookie: joshua, body: { name: "bad.pdf", data: Buffer.from("%PDF-1.4 /JavaScript").toString("base64") } })));
  assert.equal(badPdf.status, 400);
  const audit = await read(await ticketFn(req("GET", "/api/tickets/audit", { cookie: joshua })));
  assert.equal(audit.body.audit.some((row) => row.action === "create"), true);
  assert.equal(JSON.stringify(audit.body).includes("secret"), false);
});

test("requester domain gate is exact and rejects lookalikes", () => {
  const settings = tickets.normaliseSettings({});
  assert.equal(tickets.requesterAllowed("jbattaglia@libertyretail.com.au", settings), true);
  assert.equal(tickets.requesterAllowed("Store.Manager@LibertyRetail.com.au", settings), true);
  assert.equal(tickets.requesterAllowed("user@shop.libertyretail.com.au", settings), false);
  assert.equal(tickets.requesterAllowed("user@libertyretail.com.au.evil.com", settings), false);
  assert.equal(tickets.requesterAllowed("user@libertyreta1l.com.au", settings), false);
  assert.equal(tickets.requesterAllowed("user@notlibertyretail.com.au", settings), false);
  assert.equal(tickets.domainAllowed("user@example.com", settings.domains), false);
  const withExtra = tickets.normaliseSettings({
    requesters: [{ email: "contractor@example.com", sites: ["s00000001"], area: "North" }],
  });
  assert.equal(tickets.requesterAllowed("contractor@example.com", withExtra), true);
  assert.equal(withExtra.requesters[0].sites[0], "s00000001");
  assert.equal(withExtra.requesters[0].area, "North");
});
