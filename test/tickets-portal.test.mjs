import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;

const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const tickets = await import("../netlify/lib/tickets.mjs");
const supportAuth = await import("../netlify/lib/support-auth.mjs");
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
tickets.setTicketTestHooks({ now: () => Date.parse("2026-11-10T02:00:00.000Z") });

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

async function seedSites() {
  await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
  await lib.sitesStore().setJSON("s00000002", { id: "s00000002", name: "Example South", operationalRegion: "South" });
}

async function seedSettings(overrides = {}) {
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    requesters: [
      { email: "ada@example.com", sites: ["s00000001"] },
      { email: "bee@example.com", sites: ["s00000002"] },
      { email: "cee@example.com", sites: [], area: "North" },
      { email: "dee@example.com" },
    ],
    domains: [{ domain: "libertyretail.com.au", sites: [], area: "" }],
    visibility: "own-and-sites",
    notify: { screens: false, signage: false },
    notifyGlobal: false,
    ...overrides,
  }));
}

const sessions = new Map();
async function signIn(email) {
  if (sessions.has(email)) return sessions.get(email);
  const before = mail.length;
  const started = await read(await supportFn(req("POST", "/api/support/start", { body: { email }, ip: clientIp(email) })));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const sent = mail.slice(before).at(-1);
  assert.ok(sent, "expected a support code email");
  const code = sent.text.match(/code is (\d{8})/)[1];
  const verified = await supportFn(req("POST", "/api/support/verify", { body: { email, code }, ip: clientIp(email) }));
  assert.equal(verified.status, 200);
  assert.equal(cookieNamed(verified, "qr_otp"), "");
  const cookie = cookieNamed(verified, "qr_support");
  assert.ok(cookie.startsWith("qr_support="));
  sessions.set(email, cookie);
  return cookie;
}

function photoBytes() {
  const encoded = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80);
  const comment = Buffer.from("GPSLatitude secret-exif", "ascii");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), comment]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([encoded.data.subarray(0, 2), app1, encoded.data.subarray(2)]);
}

await seedSites();
await seedSettings();

test("unknown and lookalike addresses get a neutral rejection and no email", async () => {
  const before = mail.length;
  for (const email of [
    "nobody@example.com",
    "user@shop.libertyretail.com.au",
    "user@sub.libertyretail.com.au",
    "user@libertyretail.com.au.evil.com",
    "user@evil-libertyretail.com.au",
    "user@libertyreta1l.com.au",
  ]) {
    const started = await read(await supportFn(req("POST", "/api/support/start", { body: { email }, ip: clientIp(email) })));
    assert.equal(started.status, 200, email);
    assert.equal(started.body.ok, true);
    assert.match(started.body.message, /if this address can open the support portal/i);
  }
  const allowed = await read(await supportFn(req("POST", "/api/support/start", { body: { email: "Store.Manager@LibertyRetail.com.au" }, ip: clientIp("Store.Manager@LibertyRetail.com.au") })));
  assert.equal(allowed.status, 200);
  assert.equal(mail.length, before + 1);
  assert.match(mail.at(-1).text, /code is \d{8}/);
  assert.equal(mail.at(-1).subject, "Express Help sign-in code");
});

test("requester A cannot see requester B tickets, and unmapped users see only their own", async () => {
  const ada = await signIn("ada@example.com");
  const created = await read(await supportFn(req("POST", "/api/support/tickets", { cookie: ada, body: {
    queue: "screens", requestType: "Fault or repair", siteId: "s00000001", priority: "high", neededBy: "2026-11-01",
    subject: "Ada screen", description: "Ada's example screen is blank.",
  } })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.ticket.overdue, true);
  assert.equal(created.body.ticket.access, "own");
  const id = created.body.ticket.id;

  const bee = await signIn("bee@example.com");
  const hidden = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: bee })));
  assert.equal(hidden.status, 404);
  const beeList = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: bee })));
  assert.equal((beeList.body.tickets || []).some((row) => row.id === id), false);

  const dee = await signIn("dee@example.com");
  const ownOnly = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: dee })));
  assert.equal(ownOnly.status, 404);
  const deeCreated = await read(await supportFn(req("POST", "/api/support/tickets", { cookie: dee, body: {
    queue: "signage", requestType: "Replacement", siteId: "s00000002", priority: "normal",
    subject: "Dee sign", description: "Dee can still submit for a site with no mapping.",
  } })));
  assert.equal(deeCreated.status, 200, JSON.stringify(deeCreated.body));
  const deeList = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: dee })));
  assert.deepEqual(deeList.body.tickets.map((row) => row.id), [deeCreated.body.ticket.id]);
});

test("site and area mappings are read only, and own-only visibility hides them", async () => {
  const ada = await signIn("ada@example.com");
  const listed = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: ada })));
  const own = listed.body.tickets.find((row) => row.subject === "Ada screen");
  assert.ok(own);
  const cee = await signIn("cee@example.com");
  const shared = await read(await supportFn(req("GET", "/api/support/tickets/" + own.id, { cookie: cee })));
  assert.equal(shared.status, 200);
  assert.equal(shared.body.ticket.access, "read");
  const comment = await read(await supportFn(req("POST", "/api/support/tickets/" + own.id + "/comment", { cookie: cee, body: { text: "I should not write this" } })));
  assert.equal(comment.status, 403);
  const file = await read(await supportFn(req("POST", "/api/support/tickets/" + own.id + "/file", { cookie: cee, body: { name: "x.jpg", data: photoBytes().toString("base64") } })));
  assert.equal(file.status, 403);

  const current = tickets.normaliseSettings(await lib.ticketStore().get("settings", { type: "json" }));
  await seedSettings({ ...current, visibility: "own-only" });
  const hidden = await read(await supportFn(req("GET", "/api/support/tickets/" + own.id, { cookie: cee })));
  assert.equal(hidden.status, 404);
  await seedSettings({ ...current, visibility: "own-and-sites" });
});

test("requesters never receive internal notes in the API payload", async () => {
  const actor = { kind: "verified-identity", provider: "otp", email: JOSHUA };
  const created = await tickets.createTicket(actor, {
    queue: "screens", siteId: "s00000001", requestType: "Fault or repair", priority: "normal",
    subject: "Staff opened", description: "Opened for Ada.", requesterEmail: "ada@example.com",
  });
  const id = created.body.ticket.id;
  await tickets.addInternalNote(actor, id, { text: "Hidden supplier note" });
  await tickets.addPublicReply(actor, id, { text: "We are sending a technician." });
  const ada = await signIn("ada@example.com");
  const view = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: ada })));
  assert.equal(view.status, 200);
  const payload = JSON.stringify(view.body);
  assert.equal(payload.includes("Hidden supplier note"), false);
  assert.equal(payload.includes("internal"), false);
  assert.equal(view.body.ticket.messages.some((row) => row.kind === "internal"), false);
  assert.equal(view.body.ticket.messages.some((row) => row.text === "We are sending a technician."), true);
  assert.equal(view.body.ticket.closeOut, null);
  const listed = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: ada })));
  assert.equal(JSON.stringify(listed.body).includes("Hidden supplier note"), false);
});

test("attachments stay private and need a support session", async () => {
  const ada = await signIn("ada@example.com");
  const created = await read(await supportFn(req("POST", "/api/support/tickets", { cookie: ada, body: {
    queue: "screens", requestType: "Other", siteId: "s00000001", priority: "low",
    subject: "Photo ticket", description: "Includes a photo.",
  } })));
  const id = created.body.ticket.id;
  const uploaded = await read(await supportFn(req("POST", "/api/support/tickets/" + id + "/file", { cookie: ada, body: { name: "id.jpg", data: photoBytes().toString("base64") } })));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const fileId = uploaded.body.ticket.files[0].id;
  const anon = await read(await supportFn(req("GET", "/api/support/tickets/" + id + "/files/" + fileId)));
  assert.equal(anon.status, 401);
  const bee = await signIn("bee@example.com");
  const other = await read(await supportFn(req("GET", "/api/support/tickets/" + id + "/files/" + fileId, { cookie: bee })));
  assert.equal(other.status, 404);
  const file = await read(await supportFn(req("GET", "/api/support/tickets/" + id + "/files/" + fileId, { cookie: ada })));
  assert.equal(file.status, 200);
  assert.equal(file.body.includes(Buffer.from("GPSLatitude")), false);
  assert.equal(String(file.headers.get("cache-control")).includes("private"), true);
});

test("a requester session cannot open admin or staff APIs", async () => {
  const support = await signIn(JOSHUA);
  const ticketApis = await Promise.all([
    read(await ticketFn(req("GET", "/api/tickets", { cookie: support }))),
    read(await ticketFn(req("GET", "/api/tickets/access", { cookie: support }))),
    read(await ticketFn(req("GET", "/api/tickets/settings", { cookie: support }))),
    read(await ticketFn(req("GET", "/api/tickets/summary", { cookie: support }))),
    read(await ticketFn(req("GET", "/api/tickets/sites", { cookie: support }))),
    read(await sitesFn(req("GET", "/api/sites", { cookie: support }))),
    read(await codesFn(req("GET", "/api/codes", { cookie: support }))),
    read(await posFn(req("GET", "/api/pos-drafts", { cookie: support }))),
    read(await visitAdminFn(req("GET", "/api/visitor-log/visits", { cookie: support }))),
    read(await settingsFn(req("GET", "/api/settings", { cookie: support }))),
  ]);
  for (const res of ticketApis) {
    assert.equal(res.status === 401 || res.status === 403, true, JSON.stringify(res.body));
  }
  const session = await read(await supportFn(req("GET", "/api/support/session", { cookie: support })));
  assert.equal(session.status, 200);
  assert.equal(session.body.email, JOSHUA);
});

test("the shared Head office password is not a support or ticket staff session", async () => {
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  const support = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: head })));
  assert.equal(support.status, 401);
  const staff = await read(await ticketFn(req("GET", "/api/tickets", { cookie: head })));
  assert.equal(staff.status, 403);
  const session = await read(await ticketFn(req("GET", "/api/tickets/access", { cookie: head })));
  assert.equal(session.status, 403);
});

test("support code requests are rate limited", async () => {
  let limited = 0;
  for (let i = 0; i < 4; i++) {
    const res = await read(await supportFn(req("POST", "/api/support/start", { body: { email: "rate.limit@example.com" }, ip: clientIp("rate.limit@example.com") })));
    if (res.status === 429) limited += 1;
    else assert.equal(res.status, 200);
  }
  assert.equal(limited >= 1, true);
});

test("the support page is branded, 390px, and does not mention staff notes", () => {
  const page = fs.readFileSync(new URL("../public/support/index.html", import.meta.url), "utf8");
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(page, /Liberty Oil Convenience/);
  assert.match(page, /min\(390px/);
  assert.equal(page.toLowerCase().includes("internal"), false);
  assert.match(toml, /from = "\/support"/);
  assert.match(toml, /to = "\/support\/index.html"/);
  const settings = tickets.normaliseSettings({});
  assert.equal(settings.notify.screens, false);
  assert.equal(settings.notify.signage, false);
  assert.equal(settings.notifyGlobal, false);
});
