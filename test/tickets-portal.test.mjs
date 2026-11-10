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

const publicLib = await import("../netlify/lib/support-public.mjs");
let fakeNow = Date.parse("2026-11-10T02:00:00.000Z");
publicLib.setPublicTestHooks({ now: () => fakeNow });
function photoBytes() {
  const encoded = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80);
  const comment = Buffer.from("GPSLatitude secret-exif", "ascii");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), comment]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([encoded.data.subarray(0, 2), app1, encoded.data.subarray(2)]);
}

await seedSites();
await seedSettings();


let ipSeq = 0;
function freshIp() { ipSeq += 1; return "2001:db8:aaaa::" + ipSeq.toString(16); }

async function getForm(ip) {
  const res = await read(await supportFn(req("GET", "/api/support/form", { ip })));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

function validBody(form, overrides = {}) {
  return {
    formToken: form.formToken, website: "",
    name: "Test Person", email: "Test.Person@LibertyRetail.com.au", phone: "0412 345 678",
    siteId: "s00000001", siteOther: "", queue: "screens", requestType: "Fault or repair", priority: "high",
    neededBy: "", subject: "TEST example screen", description: "Synthetic test description.", files: [],
    ...overrides,
  };
}

async function submit(body, ip) {
  return read(await supportFn(req("POST", "/api/support/submit", { body, ip })));
}

async function submitAfterWait(overrides = {}, ip = freshIp()) {
  const form = await getForm(ip);
  fakeNow += 5000;
  return submit(validBody(form, overrides), ip);
}

test("the public form needs no sign-in and lists sites without regions", async () => {
  const form = await getForm(freshIp());
  assert.equal(form.domain, "libertyretail.com.au");
  assert.deepEqual(form.sites.map((row) => Object.keys(row).sort()), [["id", "name"], ["id", "name"]]);
  assert.ok(form.types.screens.includes("Fault or repair"));
  assert.match(form.formToken, /^\d+\.[A-Za-z0-9_-]{32}$/);
});

test("anyone can submit; a 256-bit tracking link and number come back; staff see submitter details", async () => {
  mail.length = 0;
  const created = await submitAfterWait();
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(typeof created.body.number, "number");
  assert.equal(Buffer.from(created.body.token, "base64url").length, 32);
  assert.equal(created.body.trackPath, "/support/track#" + created.body.number + "." + created.body.token);
  assert.equal(mail.length, 0);
  const index = await lib.ticketStore().get("track/" + created.body.number, { type: "json" });
  const stored = await lib.ticketStore().get("ticket/" + index.id, { type: "json" });
  assert.equal(stored.requesterEmail, "test.person@libertyretail.com.au");
  assert.equal(stored.requesterName, "Test Person");
  assert.equal(stored.requesterPhone, "0412 345 678");
  assert.equal(stored.source, "web-form");
  assert.equal(JSON.stringify(stored).includes(created.body.token), false, "token is stored hashed");
  assert.match(stored.trackHash, /^[a-f0-9]{64}$/);
  const admin = { kind: "verified-identity", provider: "otp", email: JOSHUA };
  const staffView = await tickets.readTicket(admin, index.id);
  assert.equal(staffView.body.ticket.requesterName, "Test Person");
  assert.equal(staffView.body.ticket.requesterPhone, "0412 345 678");
  assert.equal(staffView.body.ticket.siteFreeText, false);
  assert.equal(staffView.body.ticket.siteLabel, "Example North");

  const other = await submitAfterWait({ siteId: "other", siteOther: "TEST Unlisted Site, Exampleville", queue: "signage", requestType: "Replacement" });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const otherIndex = await lib.ticketStore().get("track/" + other.body.number, { type: "json" });
  const otherView = await tickets.readTicket(admin, otherIndex.id);
  assert.equal(otherView.body.ticket.siteFreeText, true);
  assert.equal(otherView.body.ticket.queue, "signage");
  assert.equal(otherView.body.ticket.siteLabel, "TEST Unlisted Site, Exampleville");
});

test("email domain, phone, required fields and queue are validated server-side", async () => {
  for (const email of ["user@example.com", "user@shop.libertyretail.com.au", "user@libertyretail.com.au.evil.com", "user@evil-libertyretail.com.au", "not-an-email"]) {
    const res = await submitAfterWait({ email });
    assert.equal(res.status, 400, email);
    assert.match(res.body.error, /libertyretail\.com\.au/);
  }
  for (const phone of ["", "12", "hello", "0412 345", "+1 415 555 0100", "0912345678"]) {
    const res = await submitAfterWait({ phone });
    assert.equal(res.status, 400, phone);
  }
  for (const phone of ["0412345678", "+61 412 345 678", "(03) 9123 4567", "+61 (0)3 9123 4567", "1300 123 456", "131 450", "9123 4567"]) {
    assert.ok(publicLib.phoneOk(phone), phone);
  }
  assert.equal((await submitAfterWait({ name: "" })).status, 400);
  assert.equal((await submitAfterWait({ queue: "plumbing" })).status, 400);
  assert.equal((await submitAfterWait({ requestType: "Replacement" })).status, 400, "type must belong to the queue");
  assert.equal((await submitAfterWait({ priority: "" })).status, 400);
  assert.equal((await submitAfterWait({ subject: "" })).status, 400);
  assert.equal((await submitAfterWait({ siteId: "" })).status, 400);
  assert.equal((await submitAfterWait({ siteId: "other", siteOther: "" })).status, 400);
});

test("honeypot, too-fast, forged or expired form tokens, and oversize payloads are rejected", async () => {
  const before = (await lib.ticketStore().list({ prefix: "ticket/" })).blobs.length;
  assert.equal((await submitAfterWait({ website: "http://spam.example" })).status, 400);
  const ip = freshIp();
  const form = await getForm(ip);
  fakeNow += 500;
  const quick = await submit(validBody(form), ip);
  assert.equal(quick.status, 400);
  assert.match(quick.body.error, /quick/i);
  assert.equal((await submitAfterWait({ formToken: "1700000000000.forgedforgedforgedforgedforgedforg" })).status, 400);
  const old = await getForm(freshIp());
  fakeNow += 25 * 3600 * 1000;
  assert.equal((await submit(validBody(old), freshIp())).status, 400);
  const big = await read(await supportFn(req("POST", "/api/support/submit", { body: { pad: "x".repeat(publicLib.SUBMIT_MAX_BYTES + 10) }, ip: freshIp() })));
  assert.equal(big.status, 413);
  const after = (await lib.ticketStore().list({ prefix: "ticket/" })).blobs.length;
  assert.equal(after, before);
});

test("submissions are rate limited per hashed client key and raw addresses are never stored", async () => {
  const ip = "2001:db8:ffff::77";
  let limited = 0;
  for (let i = 0; i < 7; i++) {
    const res = await submitAfterWait({}, ip);
    if (res.status === 429) limited += 1;
    else assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  assert.equal(limited >= 1, true);
  const { blobs } = await lib.rateStore().list({ prefix: "support/" });
  assert.ok(blobs.length > 0);
  assert.equal(blobs.some((row) => row.key.includes(ip) || row.key.includes("2001:db8")), false);
  const key = publicLib.clientKey(req("GET", "/", { ip }));
  assert.match(key, /^[a-f0-9]{20}$/);
});

test("the tracking link shows read-only status and public replies only", async () => {
  const created = await submitAfterWait({ subject: "TEST tracking", description: "Track me." });
  const { number, token } = created.body;
  const index = await lib.ticketStore().get("track/" + number, { type: "json" });
  const admin = { kind: "verified-identity", provider: "otp", email: JOSHUA };
  await tickets.addInternalNote(admin, index.id, { text: "Hidden supplier note" });
  await tickets.addPublicReply(admin, index.id, { text: "A technician is booked." });
  await tickets.setStatus(admin, index.id, { status: "scheduled" });
  await tickets.assignTicket(admin, index.id, { assignee: JOSHUA });
  const view = await read(await supportFn(req("POST", "/api/support/track", { body: { number, token }, ip: freshIp() })));
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.headers.get("cache-control"), "private, no-store");
  assert.equal(view.headers.get("referrer-policy"), "no-referrer");
  assert.match(view.headers.get("x-robots-tag"), /noindex/);
  const payload = JSON.stringify(view.body);
  assert.equal(view.body.ticket.status, "Scheduled");
  assert.equal(view.body.ticket.replies.length, 1);
  assert.deepEqual(view.body.ticket.replies.map((row) => row.from), ["Express Help"]);
  for (const hidden of ["Hidden supplier note", "internal", JOSHUA, "assignee", "trackHash", "requesterPhone", "requesterEmail", "closeOut", index.id]) {
    assert.equal(payload.includes(hidden), false, hidden);
  }
  const wrong = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
  for (const body of [{ number, token: wrong }, { number: number + 1, token }, { number, token: "short" }, { number: "x", token }, {}]) {
    const res = await read(await supportFn(req("POST", "/api/support/track", { body, ip: freshIp() })));
    assert.equal(res.status, 404, JSON.stringify(body));
  }
  const write = await read(await supportFn(req("POST", "/api/support/tickets/" + index.id + "/comment", { body: { text: "x" }, ip: freshIp() })));
  assert.equal(write.status, 404);
});

test("retired requester sign-in and ticket-list endpoints grant nothing, even with an old session", async () => {
  const head = "qr_support=legacy-session-value";
  for (const [method, url] of [
    ["POST", "/api/support/start"], ["POST", "/api/support/verify"], ["GET", "/api/support/session"],
    ["GET", "/api/support/tickets"], ["POST", "/api/support/tickets"], ["GET", "/api/support/tickets/t0000000000000001"],
    ["GET", "/api/support/tickets/t0000000000000001/files/f0000000000000001"], ["POST", "/api/support/tickets/t0000000000000001/comment"],
  ]) {
    const res = await read(await supportFn(req(method, url, { cookie: head, body: method === "POST" ? { email: "x@libertyretail.com.au" } : undefined })));
    assert.equal(res.status, 404, method + " " + url);
    assert.equal(JSON.stringify(res.body).includes("ticket\""), false);
  }
  assert.equal(typeof tickets.listRequesterTickets, "undefined");
  assert.equal(typeof tickets.readRequesterTicket, "undefined");
});

test("a support-style cookie cannot open admin or staff APIs", async () => {
  const support = "qr_support=legacy-session-value";
  const apis = await Promise.all([
    read(await ticketFn(req("GET", "/api/tickets", { cookie: support }))),
    read(await ticketFn(req("GET", "/api/tickets/access", { cookie: support }))),
    read(await ticketFn(req("GET", "/api/tickets/settings", { cookie: support }))),
    read(await sitesFn(req("GET", "/api/sites", { cookie: support }))),
    read(await codesFn(req("GET", "/api/codes", { cookie: support }))),
    read(await posFn(req("GET", "/api/pos-drafts", { cookie: support }))),
    read(await visitAdminFn(req("GET", "/api/visitor-log/visits", { cookie: support }))),
    read(await settingsFn(req("GET", "/api/settings", { cookie: support }))),
  ]);
  for (const res of apis) assert.equal(res.status === 401 || res.status === 403, true, JSON.stringify(res.body));
});

test("the shared Head office password is not a support or ticket staff session", async () => {
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  const support = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: head })));
  assert.equal(support.status, 404);
  const staff = await read(await ticketFn(req("GET", "/api/tickets", { cookie: head })));
  assert.equal(staff.status, 403);
  const session = await read(await ticketFn(req("GET", "/api/tickets/access", { cookie: head })));
  assert.equal(session.status, 403);
});

test("the support page is branded, 390px, and does not mention staff notes", () => {
  const page = fs.readFileSync(new URL("../public/support/index.html", import.meta.url), "utf8");
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(page, /Liberty Oil Convenience/);
  assert.match(page, /min\(390px/);
  assert.equal(page.toLowerCase().includes("internal"), false);
  assert.match(page, /Save this link now/);
  assert.match(page, /not emailed/);
  assert.match(page, /name="website"/);
  assert.match(page, /\/api\/support\/submit/);
  assert.match(page, /\/api\/support\/track/);
  assert.match(page, /name="referrer" content="no-referrer"/);
  assert.equal(page.includes("/api/support/start"), false);
  assert.equal(page.includes("My tickets"), false);
  assert.match(toml, /from = "\/support"/);
  assert.match(toml, /to = "\/support\/index.html"/);
  const settings = tickets.normaliseSettings({});
  assert.equal(settings.notify.screens, false);
  assert.equal(settings.notify.signage, false);
  assert.equal(settings.notifyGlobal, false);
});
