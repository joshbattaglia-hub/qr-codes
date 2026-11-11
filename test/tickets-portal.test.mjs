import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.TICKET_TRACK_KEY = "synthetic-track-key-for-tests-only-0123456789";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;

const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] } });

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const tickets = await import("../netlify/lib/tickets.mjs");
const supportAuth = await import("../netlify/lib/support-auth.mjs");
const publicLib = await import("../netlify/lib/support-public.mjs");
const supportFn = (await import("../netlify/functions/support.mjs")).default;
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const sitesFn = (await import("../netlify/functions/sites.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const posFn = (await import("../netlify/functions/pos-drafts.mjs")).default;
const visitAdminFn = (await import("../netlify/functions/visitor-admin.mjs")).default;
const settingsFn = (await import("../netlify/functions/settings.mjs")).default;

const mail = [];
supportAuth.setSupportTestHooks({ deliver: async (message) => { mail.push(message); return { status: "sent", id: "local-mock" }; } });
let fakeNow = Date.parse("2026-11-10T02:00:00.000Z");
tickets.setTicketTestHooks({ now: () => fakeNow });
publicLib.setPublicTestHooks({ now: () => fakeNow });
const ADMIN = { kind: "verified-identity", provider: "otp", email: JOSHUA };

let ipSeq = 0;
function freshIp() { ipSeq += 1; return "2001:db8:aaaa::" + ipSeq.toString(16); }
function clientIp(email) {
  const hex = Buffer.from(String(email || "anon")).toString("hex").slice(0, 8);
  return "2001:db8:" + hex.slice(0, 4) + ":" + hex.slice(4) + "::1";
}
function req(method, url, { cookie = "", body, ip } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  headers.set("x-nf-client-connection-ip", ip || "127.0.0.1");
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
function photoBytes() {
  const encoded = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80);
  return Buffer.from(encoded.data);
}

await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
await lib.sitesStore().setJSON("s00000002", { id: "s00000002", name: "Example South", operationalRegion: "South" });
await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
  requesters: [{ email: "listed.outsider@example.com", sites: ["s00000001"] }],
  domains: [{ domain: "libertyretail.com.au", sites: ["s00000001"], area: "North" }],
  visibility: "own-and-sites",
  notify: { screens: false, signage: false }, notifyGlobal: false,
}));

const sessions = new Map();
async function signIn(email) {
  if (sessions.has(email)) return sessions.get(email);
  const before = mail.length;
  const started = await read(await supportFn(req("POST", "/api/support/start", { body: { email }, ip: clientIp(email) })));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const sent = mail.slice(before).at(-1);
  assert.ok(sent, "expected a (fake) support code email");
  const code = sent.text.match(/code is (\d{8})/)[1];
  const verified = await supportFn(req("POST", "/api/support/verify", { body: { email, code }, ip: clientIp(email) }));
  assert.equal(verified.status, 200);
  const cookie = cookieNamed(verified, "qr_support");
  assert.ok(cookie.startsWith("qr_support="));
  sessions.set(email, cookie);
  return cookie;
}

async function submitAs(cookie, overrides = {}) {
  const ip = freshIp();
  const form = await read(await supportFn(req("GET", "/api/support/form", { cookie, ip })));
  assert.equal(form.status, 200, JSON.stringify(form.body));
  fakeNow += 5000;
  return read(await supportFn(req("POST", "/api/support/submit", { cookie, ip, body: {
    formToken: form.body.formToken, website: "",
    name: "Test Person", phone: "0412 345 678", siteId: "s00000001", siteOther: "",
    queue: "screens", requestType: "Fault or repair", priority: "normal", neededBy: "",
    subject: "TEST subject", description: "Synthetic description.", files: [],
    ...overrides,
  } })));
}

test("sign-in is limited to exact @libertyretail.com.au addresses; others get a neutral reply and no email", async () => {
  const before = mail.length;
  for (const email of ["listed.outsider@example.com", "user@shop.libertyretail.com.au", "user@libertyretail.com.au.evil.com", "user@evil-libertyretail.com.au", "user@libertyreta1l.com.au"]) {
    const started = await read(await supportFn(req("POST", "/api/support/start", { body: { email }, ip: clientIp(email) })));
    assert.equal(started.status, 200, email);
    assert.match(started.body.message, /if this address can open the support portal/i);
  }
  assert.equal(mail.length, before);
  const allowed = await read(await supportFn(req("POST", "/api/support/start", { body: { email: "Store.Manager@LibertyRetail.com.au" }, ip: clientIp("Store.Manager@LibertyRetail.com.au") })));
  assert.equal(allowed.status, 200);
  assert.equal(mail.length, before + 1);
  assert.equal(mail.at(-1).to, "store.manager@libertyretail.com.au");
  assert.ok(supportAuth.portalScope("A@LIBERTYRETAIL.COM.AU"));
  assert.equal(supportAuth.portalScope("a@sub.libertyretail.com.au"), null);
});

test("requester endpoints need a session; the old public board feed is gated", async () => {
  for (const [method, url] of [["GET", "/api/support/session"], ["GET", "/api/support/form"], ["POST", "/api/support/submit"], ["GET", "/api/support/tickets"], ["GET", "/api/support/board"], ["GET", "/api/support/tickets/t0000000000000001"], ["POST", "/api/support/tickets/t0000000000000001/comment"]]) {
    const res = await read(await supportFn(req(method, url, { body: method === "POST" ? {} : undefined, ip: freshIp() })));
    assert.equal(res.status, 401, method + " " + url);
  }
});

test("submit uses the session email, ignores any body email, and keeps honeypot and min-time checks", async () => {
  const ada = await signIn("ada.test@libertyretail.com.au");
  const created = await submitAs(ada, { email: "someone.else@libertyretail.com.au" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const stored = await lib.ticketStore().get("ticket/" + created.body.id, { type: "json" });
  assert.equal(stored.requesterEmail, "ada.test@libertyretail.com.au");
  assert.match(created.body.trackPath, /^\/support\/track#\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await submitAs(ada, { website: "spam" })).status, 400);
  assert.equal((await submitAs(ada, { name: "" })).status, 400);
  assert.equal((await submitAs(ada, { phone: "12" })).status, 400);
  assert.equal((await submitAs(ada, { siteId: "other", siteOther: "" })).status, 400);
  const ip = freshIp();
  const form = await read(await supportFn(req("GET", "/api/support/form", { cookie: ada, ip })));
  assert.equal(form.body.email, "ada.test@libertyretail.com.au");
  const quick = await read(await supportFn(req("POST", "/api/support/submit", { cookie: ada, ip, body: { formToken: form.body.formToken, name: "Test Person", phone: "0412345678", siteId: "s00000001", queue: "screens", requestType: "Fault or repair", priority: "normal", subject: "x", description: "y" } })));
  assert.equal(quick.status, 400);
});

test("requesters see only their own tickets, even at the same site and with a site mapping", async () => {
  const ada = await signIn("ada.test@libertyretail.com.au");
  const bee = await signIn("bee.test@libertyretail.com.au");
  const adaTicket = await submitAs(ada, { subject: "TEST Ada only" });
  const beeTicket = await submitAs(bee, { subject: "TEST Bee only" });
  const staffForAda = await tickets.createTicket(ADMIN, { queue: "signage", siteId: "s00000001", requestType: "Replacement", priority: "low", subject: "TEST staff-opened for Ada", description: "x", requesterEmail: "Ada.Test@LibertyRetail.com.au" });
  const adaList = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: ada })));
  const subjects = adaList.body.tickets.map((row) => row.subject);
  assert.ok(subjects.includes("TEST Ada only"));
  assert.ok(subjects.includes("TEST staff-opened for Ada"));
  assert.equal(subjects.includes("TEST Bee only"), false);
  assert.deepEqual(adaList.body.columns.map((row) => row.label), ["Submitted", "Needs more info", "In progress", "Done"]);
  for (const row of adaList.body.tickets) assert.equal(JSON.stringify(row).includes("requesterEmail"), false);
  const boardFeed = await read(await supportFn(req("GET", "/api/support/board", { cookie: ada })));
  assert.deepEqual(boardFeed.body.tickets.map((row) => row.id).sort(), adaList.body.tickets.map((row) => row.id).sort());
  assert.equal((await read(await supportFn(req("GET", "/api/support/tickets/" + beeTicket.body.id, { cookie: ada })))).status, 404);
  assert.equal((await read(await supportFn(req("POST", "/api/support/tickets/" + beeTicket.body.id + "/comment", { cookie: ada, body: { text: "not mine" } })))).status, 404);
  assert.equal((await read(await supportFn(req("GET", "/api/support/tickets/" + adaTicket.body.id, { cookie: bee })))).status, 404);
  assert.ok(staffForAda.body.ticket.id);
});

test("ticket view shows column, history, public replies and own attachments, never internal notes; comments and files still work", async () => {
  const ada = await signIn("ada.test@libertyretail.com.au");
  const created = await submitAs(ada, { subject: "TEST detail" });
  const id = created.body.id;
  await tickets.addInternalNote(ADMIN, id, { text: "Hidden supplier note" });
  await tickets.moveTicket(ADMIN, id, { column: "needs-info", reply: "Which screen?" });
  const view = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: ada })));
  assert.equal(view.status, 200);
  assert.equal(view.body.ticket.columnLabel, "Needs more info");
  assert.deepEqual(view.body.ticket.replies.map((row) => [row.from, row.text]), [["Express Help", "Which screen?"]]);
  const payload = JSON.stringify(view.body);
  for (const hidden of ["Hidden supplier note", "internal", JOSHUA, "trackHash", "requesterPhone", "assignee"]) assert.equal(payload.includes(hidden), false, hidden);
  const comment = await read(await supportFn(req("POST", "/api/support/tickets/" + id + "/comment", { cookie: ada, body: { text: "Screen 2" } })));
  assert.equal(comment.status, 200);
  assert.equal(comment.body.ticket.replies.at(-1).from, "You");
  const upload = await read(await supportFn(req("POST", "/api/support/tickets/" + id + "/file", { cookie: ada, body: { name: "x.jpg", data: photoBytes().toString("base64") } })));
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const fileId = upload.body.ticket.files[0].id;
  const own = await read(await supportFn(req("GET", "/api/support/tickets/" + id + "/files/" + fileId, { cookie: ada })));
  assert.equal(own.status, 200);
  const bee = await signIn("bee.test@libertyretail.com.au");
  assert.equal((await read(await supportFn(req("GET", "/api/support/tickets/" + id + "/files/" + fileId, { cookie: bee })))).status, 404);
});

test("email-in tickets show for the sender after sign-in with the same address", async () => {
  const emailTicket = await tickets.ingestEmailTicket({ queue: "signage", requesterEmail: "Cee.Test@LibertyRetail.com.au", subject: "TEST emailed in", description: "Body", siteId: "other", siteOther: "Email" });
  assert.equal(emailTicket.status, 200);
  const cee = await signIn("cee.test@libertyretail.com.au");
  const listed = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: cee })));
  assert.deepEqual(listed.body.tickets.map((row) => row.subject), ["TEST emailed in"]);
});

test("private tracking links keep working without a session", async () => {
  const ada = await signIn("ada.test@libertyretail.com.au");
  const created = await submitAs(ada, { subject: "TEST tracking" });
  const [, number, token] = created.body.trackPath.match(/#(\d+)\.(.+)$/);
  const view = await read(await supportFn(req("POST", "/api/support/track", { body: { number: Number(number), token }, ip: freshIp() })));
  assert.equal(view.status, 200);
  assert.equal(view.body.ticket.subject, "TEST tracking");
  const wrong = await read(await supportFn(req("POST", "/api/support/track", { body: { number: Number(number), token: token.slice(0, -2) + "zz" }, ip: freshIp() })));
  assert.equal(wrong.status, 404);
});

test("a requester session or the Head office password cannot open admin, staff or visitor APIs", async () => {
  const support = await signIn(JOSHUA);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  for (const cookie of [support, head]) {
    const apis = await Promise.all([
      read(await ticketFn(req("GET", "/api/tickets", { cookie }))),
      read(await ticketFn(req("GET", "/api/tickets/access", { cookie }))),
      read(await ticketFn(req("GET", "/api/tickets/settings", { cookie }))),
      read(await sitesFn(req("GET", "/api/sites", { cookie }))),
      read(await codesFn(req("GET", "/api/codes", { cookie }))),
      read(await posFn(req("GET", "/api/pos-drafts", { cookie }))),
      read(await visitAdminFn(req("GET", "/api/visitor-log/visits", { cookie }))),
      read(await settingsFn(req("GET", "/api/settings", { cookie }))),
    ]);
    for (const res of apis) {
      if (cookie === head && res.status === 200) continue; // Head office keeps its normal non-ticket admin pages.
      assert.equal(res.status === 401 || res.status === 403, true, JSON.stringify(res.body));
    }
  }
  const headTickets = await read(await ticketFn(req("GET", "/api/tickets", { cookie: head })));
  assert.equal(headTickets.status, 403);
  const headSupport = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: head })));
  assert.equal(headSupport.status, 401);
});

test("support code requests are rate limited", async () => {
  let limited = 0;
  for (let i = 0; i < 4; i++) {
    const res = await read(await supportFn(req("POST", "/api/support/start", { body: { email: "rate.limit@libertyretail.com.au" }, ip: clientIp("rate.limit@libertyretail.com.au") })));
    if (res.status === 429) limited += 1;
    else assert.equal(res.status, 200);
  }
  assert.equal(limited >= 1, true);
});

test("the support page signs in, shows a board/list of own tickets, and puts the tracking link second", () => {
  const page = fs.readFileSync(new URL("../public/support/index.html", import.meta.url), "utf8");
  assert.match(page, /Liberty Oil Convenience/);
  assert.match(page, /\/api\/support\/start/);
  assert.match(page, /readonly aria-readonly="true"/);
  assert.match(page, /Go to my tickets/);
  assert.match(page, /<details[^>]*><summary>Private tracking link/);
  assert.match(page, /name="website"/);
  assert.equal(page.toLowerCase().includes("internal"), false);
  const settings = tickets.normaliseSettings({});
  assert.equal(settings.notifyGlobal, false);
});
