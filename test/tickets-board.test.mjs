import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.TICKET_TRACK_KEY = "synthetic-track-key-for-tests-only-0123456789";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.TICKET_MAIL;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const tickets = await import("../netlify/lib/tickets.mjs");
const track = await import("../netlify/lib/ticket-track.mjs");
const mailLib = await import("../netlify/lib/mail.mjs");
const inbound = await import("../netlify/lib/ticket-mail.mjs");
const publicLib = await import("../netlify/lib/support-public.mjs");
const supportFn = (await import("../netlify/functions/support.mjs")).default;
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;

const sent = [];
mailLib.setMailTransport(async (message) => { sent.push(message); return { status: "sent", id: "fake-mail" }; });
let fakeNow = Date.parse("2026-11-11T00:00:00.000Z");
tickets.setTicketTestHooks({ now: () => fakeNow });
publicLib.setPublicTestHooks({ now: () => fakeNow });

const ADMIN = { kind: "verified-identity", provider: "otp", email: tickets.TICKET_ADMIN_EMAIL };
const SIGNAGE_STAFF = { kind: "verified-identity", provider: "otp", email: "signage.staff@example.com" };
const OUTSIDER = { kind: "verified-identity", provider: "otp", email: "someone@libertyretail.com.au" };

let ipSeq = 0;
function req(method, url, { body, cookie = "", ip } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-nf-client-connection-ip", ip || "2001:db8:bbbb::" + (++ipSeq).toString(16));
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  return { status: res.status, body: await res.json(), headers: res.headers };
}

await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
  staff: { screens: [tickets.TICKET_ADMIN_EMAIL], signage: [tickets.TICKET_ADMIN_EMAIL, "signage.staff@example.com"] },
  notify: { screens: false, signage: false }, notifyGlobal: false,
}));

async function make(queue = "screens", overrides = {}) {
  const created = await tickets.createTicket(ADMIN, {
    queue, siteId: "s00000001", requestType: queue === "screens" ? "Fault or repair" : "Replacement", priority: "normal",
    subject: "TEST secret subject", description: "TEST private description", requesterEmail: "requester@example.com", ...overrides,
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  return created.body.ticket;
}

test("status to column mapping keeps old statuses readable", () => {
  assert.deepEqual(
    ["new", "awaiting", "in-progress", "scheduled", "done", "closed", "unknown"].map(tickets.columnFor),
    ["submitted", "needs-info", "in-progress", "in-progress", "done", "done", "submitted"],
  );
  assert.deepEqual(tickets.BOARD_COLUMNS.map((row) => row.label), ["Submitted", "Needs more info", "In progress", "Done"]);
  const shown = tickets.presentTicket({ id: "t0000000000000001", status: "scheduled", statusHistory: [] }, { staff: true });
  assert.equal(shown.column, "in-progress");
  assert.equal(shown.columnLabel, "In progress");
  assert.equal(shown.statusLabel, "Scheduled");
});

test("board moves record actor, time, from and to; Needs more info requires a public reply", async () => {
  const ticket = await make();
  const noReply = await tickets.moveTicket(ADMIN, ticket.id, { column: "needs-info" });
  assert.equal(noReply.status, 400);
  assert.match(noReply.error, /public reply/);
  fakeNow += 60000;
  const asked = await tickets.moveTicket(ADMIN, ticket.id, { column: "needs-info", reply: "Which screen is blank?" });
  assert.equal(asked.status, 200, JSON.stringify(asked));
  assert.equal(asked.body.ticket.status, "awaiting");
  assert.equal(asked.body.ticket.column, "needs-info");
  assert.equal(asked.body.ticket.messages.at(-1).kind, "public");
  assert.equal(asked.body.ticket.messages.at(-1).text, "Which screen is blank?");
  const last = asked.body.ticket.statusHistory.at(-1);
  assert.deepEqual({ from: last.from, to: last.to, fromColumn: last.fromColumn, toColumn: last.toColumn, actor: last.actor, at: last.at },
    { from: "new", to: "awaiting", fromColumn: "submitted", toColumn: "needs-info", actor: tickets.TICKET_ADMIN_EMAIL, at: new Date(fakeNow).toISOString() });
  const same = await tickets.moveTicket(ADMIN, ticket.id, { column: "needs-info", reply: "again" });
  assert.equal(same.status, 400);
  await tickets.moveTicket(ADMIN, ticket.id, { column: "in-progress" });
  const done = await tickets.moveTicket(ADMIN, ticket.id, { column: "done" });
  assert.equal(done.body.ticket.status, "done");
  assert.deepEqual(done.body.ticket.statusHistory.map((row) => row.to), ["new", "awaiting", "in-progress", "done"]);
  const audit = await tickets.listAudit(ADMIN);
  const moves = audit.body.audit.filter((row) => row.ticketId === ticket.id && row.action === "move");
  assert.equal(moves.length, 3);
  assert.ok(moves.some((row) => row.detail.startsWith("submitted -> needs-info")));
  assert.equal(moves.every((row) => row.actor === tickets.TICKET_ADMIN_EMAIL), true);
  assert.equal((await tickets.moveTicket(ADMIN, ticket.id, { column: "nowhere" })).status, 400);
});

test("move permissions follow the staff gate", async () => {
  const screens = await make("screens");
  const signage = await make("signage");
  assert.equal((await tickets.moveTicket(OUTSIDER, screens.id, { column: "in-progress" })).status, 403);
  assert.equal((await tickets.moveTicket(SIGNAGE_STAFF, screens.id, { column: "in-progress" })).status, 404);
  assert.equal((await tickets.moveTicket(SIGNAGE_STAFF, signage.id, { column: "in-progress" })).status, 200);
  const anon = await read(await ticketFn(req("POST", "/api/tickets/" + screens.id + "/move", { body: { column: "done" } })));
  assert.equal(anon.status, 401);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = (headLogin.headers.getSetCookie?.() || []).find((row) => row.startsWith("qr_admin=") && !row.startsWith("qr_admin=;"))?.split(";")[0] || "";
  const headMove = await read(await ticketFn(req("POST", "/api/tickets/" + screens.id + "/move", { body: { column: "done" }, cookie: head })));
  assert.equal(headMove.status, 403);
  const stored = await lib.ticketStore().get("ticket/" + screens.id, { type: "json" });
  assert.equal(stored.status, "new");
});

test("staff list filters by queue (including all), site, request type and column", async () => {
  const rows = (query) => tickets.listTickets(ADMIN, new URLSearchParams(query)).then((res) => res.body.tickets);
  const all = await rows({ queue: "all" });
  assert.ok(all.some((row) => row.queue === "screens") && all.some((row) => row.queue === "signage"));
  assert.equal((await rows({ queue: "all", type: "Replacement" })).every((row) => row.requestType === "Replacement"), true);
  assert.equal((await rows({ queue: "all", site: "s00000001" })).length, all.length);
  assert.equal((await rows({ queue: "all", site: "other" })).length, 0);
  assert.equal((await rows({ queue: "all", column: "done" })).every((row) => row.column === "done"), true);
});

test("notification emails include a working private tracking link; old links stay valid; email-in tickets get one", async () => {
  sent.length = 0;
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    ...(await tickets.readSettings()), notify: { screens: true, signage: true }, notifyGlobal: true,
  }));
  const trackOk = async (path) => {
    const [, number, token] = path.match(/#(\d+)\.([A-Za-z0-9_-]+)$/);
    return read(await supportFn(req("POST", "/api/support/track", { body: { number: Number(number), token } })));
  };

  // Staff-created ticket: link is recoverable and matches what the email says.
  const staffTicket = await make();
  const moved = await read(await (async () => {
    const res = await tickets.moveTicket(ADMIN, staffTicket.id, { column: "needs-info", reply: "Please send a photo." });
    await inbound.notifyTicket(res.body.ticket, "status", "Please send a photo.");
    return new Response(JSON.stringify(res.body));
  })());
  assert.ok(moved.body.ticket);
  const statusMail = sent.at(-1);
  assert.match(statusMail.text, /is now Needs more info/);
  assert.match(statusMail.text, /Please send a photo\./);
  const link = statusMail.text.match(/https:\/\/expresshelp\.site(\/support\/track#\d+\.[A-Za-z0-9_-]{43})/);
  assert.ok(link, statusMail.text);
  assert.equal((await trackOk(link[1])).status, 200);
  await inbound.notifyTicket(moved.body.ticket, "reply", "A public reply");
  assert.ok(sent.at(-1).text.includes(link[1]), "same link each time");

  // Pre-change ticket with a random token hash and no index: old link stays valid, new link minted on first mail.
  const legacyId = "t" + "a".repeat(16);
  const legacyToken = "L".repeat(43);
  await lib.ticketStore().setJSON("ticket/" + legacyId, {
    id: legacyId, number: 990001, queue: "screens", siteId: "s00000001", siteLabel: "Example North", requestType: "Other", priority: "normal",
    subject: "TEST legacy", description: "Legacy", requesterEmail: "legacy@example.com", trackHash: track.hashTrackToken(legacyToken),
    status: "new", statusHistory: [], messages: [], files: [], createdAt: new Date(fakeNow).toISOString(), updatedAt: new Date(fakeNow).toISOString(),
  });
  await lib.ticketStore().setJSON("track/990001", { id: legacyId });
  assert.equal((await trackOk("/support/track#990001." + legacyToken)).status, 200);
  await inbound.notifyTicket(tickets.presentTicket(await lib.ticketStore().get("ticket/" + legacyId, { type: "json" }), { staff: true }), "status");
  const legacyLink = sent.at(-1).text.match(/(\/support\/track#990001\.[A-Za-z0-9_-]{43})/);
  assert.ok(legacyLink);
  assert.equal((await trackOk(legacyLink[1])).status, 200);
  assert.equal((await trackOk("/support/track#990001." + legacyToken)).status, 200, "old link still valid");

  // Email-in ticket gets a link from creation.
  const emailTicket = await tickets.ingestEmailTicket({ queue: "signage", requesterEmail: "mailer@libertyretail.com.au", subject: "TEST email-in", description: "Body", siteId: "other", siteOther: "Email" });
  assert.equal(emailTicket.status, 200);
  await inbound.notifyTicket(emailTicket.body.ticket, "reply", "Thanks");
  const emailLink = sent.at(-1).text.match(/(\/support\/track#\d+\.[A-Za-z0-9_-]{43})/);
  assert.ok(emailLink);
  assert.equal((await trackOk(emailLink[1])).status, 200);

  // A wrong token still fails, and turning notifications off sends nothing.
  assert.equal((await trackOk(emailLink[1].slice(0, -3) + "zzz")).status, 404);
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({ ...(await tickets.readSettings()), notifyGlobal: false }));
  const before = sent.length;
  await inbound.notifyTicket(emailTicket.body.ticket, "reply", "Off");
  assert.equal(sent.length, before);
  assert.equal(JSON.stringify(sent).includes(process.env.TICKET_TRACK_KEY), false);
});

test("tokens are derived from the key, stored only as hashes, and fall back to HKDF when the key is unset", () => {
  const id = "t" + "b".repeat(16);
  const a = track.derivedTrackToken(id);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.equal(track.derivedTrackToken(id), a);
  assert.equal(track.newTicketTracking(id).trackHash, track.hashTrackToken(a));
  const saved = process.env.TICKET_TRACK_KEY;
  delete process.env.TICKET_TRACK_KEY;
  const fallback = track.derivedTrackToken(id);
  assert.notEqual(fallback, a);
  assert.equal(track.derivedTrackToken(id), fallback);
  process.env.TICKET_TRACK_KEY = saved;
});

test("staff board UI is wired and the anonymous board feed is gone", async () => {
  const anon = await supportFn(req("GET", "/api/support/board"));
  assert.equal(anon.status, 401);
  const ui = fs.readFileSync(new URL("../public/admin/tickets-ui.mjs", import.meta.url), "utf8");
  for (const needle of ["Needs more info", 'draggable="true"', "data-act=\"ticket-move\"", "ticket-needs-info-dialog", 'data-view="list"', "ticket-site-filter", "ticket-type-filter"]) {
    assert.ok(ui.includes(needle), needle);
  }
});

