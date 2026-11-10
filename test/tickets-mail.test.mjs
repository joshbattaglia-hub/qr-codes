import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;
delete process.env.TICKET_MAIL;
delete process.env.TICKET_INBOUND_SECRET;
delete process.env.RESEND_WEBHOOK_SECRET;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const tickets = await import("../netlify/lib/tickets.mjs");
const mailLib = await import("../netlify/lib/mail.mjs");
const inbound = await import("../netlify/lib/ticket-mail.mjs");
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const supportFn = (await import("../netlify/functions/support.mjs")).default;
const sent = [];
mailLib.setMailTransport(async (message) => { sent.push(message); return { status: "sent", id: "local-mock" }; });
tickets.setTicketTestHooks({ now: () => Date.parse("2026-11-10T02:00:00.000Z") });

const admin = { kind: "verified-identity", provider: "otp", email: tickets.TICKET_ADMIN_EMAIL };
const SECRET = "inbound-secret-token-16";

function req(method, url, { cookie = "", body, raw, headers = {} } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  if (body !== undefined || raw !== undefined) h.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, {
    method,
    headers: h,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json() };
  return { status: res.status, body: await res.text() };
}

function authHeaders() {
  return [
    { Name: "Received-SPF", Value: "Pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4" },
    { Name: "X-Spam-Tests", Value: "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS" },
  ];
}

function postmarkPayload({ from, to, subject, text, hash = "", headers, stripped }) {
  return {
    FromFull: { Email: from },
    From: from,
    ToFull: [{ Email: to, MailboxHash: hash }],
    OriginalRecipient: to,
    MailboxHash: hash,
    Subject: subject,
    TextBody: text,
    StrippedTextReply: stripped || "",
    Headers: headers || authHeaders(),
    Attachments: [],
  };
}

async function seed() {
  await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    requesters: [{ email: "ada@example.com", sites: ["s00000001"] }],
    domains: [{ domain: "libertyretail.com.au", sites: [], area: "" }],
    notify: { screens: false, signage: false },
    notifyGlobal: false,
    inbound: { enabled: false, addresses: { screens: "", signage: "" } },
  }));
}

await seed();

test("outbound ticket mail stays off by default and the global kill switch holds", async () => {
  sent.length = 0;
  const created = await tickets.createTicket(admin, {
    queue: "screens", siteId: "s00000001", requestType: "Fault or repair", priority: "normal",
    subject: "Example screen", description: "An example fault.", requesterEmail: "ada@example.com",
  });
  assert.equal(created.status, 200);
  const id = created.body.ticket.id;
  const off = await inbound.notifyTicket(created.body.ticket, "status");
  assert.equal(off.status, "off");
  assert.equal(sent.length, 0);

  const current = tickets.normaliseSettings(await lib.ticketStore().get("settings", { type: "json" }));
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({ ...current, notify: { screens: true, signage: false }, notifyGlobal: false }));
  const stillOff = await inbound.notifyTicket(created.body.ticket, "status");
  assert.equal(stillOff.status, "off");
  assert.equal(sent.length, 0);

  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({ ...current, notify: { screens: true, signage: false }, notifyGlobal: true }));
  process.env.TICKET_MAIL = "off";
  const killed = await inbound.notifyTicket({ ...created.body.ticket, updatedAt: "2026-11-10T02:00:00.000Z" }, "status");
  assert.equal(killed.status, "killed");
  assert.equal(sent.length, 0);
  delete process.env.TICKET_MAIL;

  const statusRes = await ticketFn(req("POST", "/api/tickets/" + id + "/status", { body: { status: "in-progress" } }));
  // no session -> 401, no mail
  const unauth = await read(statusRes);
  assert.equal(unauth.status, 401);
  assert.equal(sent.length, 0);

  const changed = await tickets.setStatus(admin, id, { status: "in-progress" });
  const mailed = await inbound.notifyTicket(changed.body.ticket, "status");
  assert.equal(mailed.status, "sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /\[T-\d+\]/);
  assert.equal(sent[0].text.includes("Internal"), false);
  sent.length = 0;
});

test("inbound stays closed without the secret, addresses and toggle", async () => {
  delete process.env.TICKET_INBOUND_SECRET;
  const closed = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=nope", {
    body: postmarkPayload({ from: "ada@example.com", to: "screens@example.com", subject: "Hi", text: "Hello" }),
  })));
  assert.equal(closed.status, 404);
  process.env.TICKET_INBOUND_SECRET = SECRET;
  const current = tickets.normaliseSettings(await lib.ticketStore().get("settings", { type: "json" }));
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    ...current,
    inbound: { enabled: true, addresses: { screens: "", signage: "" } },
  }));
  const noAddress = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({ from: "ada@example.com", to: "screens@example.com", subject: "Hi", text: "Hello" }),
  })));
  assert.equal(noAddress.status, 404);
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    ...current,
    inbound: { enabled: false, addresses: { screens: "screens@example.com", signage: "signage@example.com" } },
  }));
  const disabled = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({ from: "ada@example.com", to: "screens@example.com", subject: "Hi", text: "Hello" }),
  })));
  assert.equal(disabled.status, 404);
});

test("inbound auth rejects missing, wrong and unauthenticated requests, then accepts a token", async () => {
  const current = tickets.normaliseSettings(await lib.ticketStore().get("settings", { type: "json" }));
  process.env.TICKET_INBOUND_SECRET = SECRET;
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    ...current,
    inbound: { enabled: true, addresses: { screens: "screens@example.com", signage: "signage@example.com" } },
  }));
  const payload = postmarkPayload({ from: "ada@example.com", to: "screens@example.com", subject: "New request", text: "Please install a screen.", stripped: "Please install a screen." });
  const missing = await read(await supportFn(req("POST", "/api/support/inbound/postmark", { body: payload })));
  assert.equal(missing.status, 401);
  const wrong = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=wrong-secret-token", { body: payload })));
  assert.equal(wrong.status, 401);
  const basic = "Basic " + Buffer.from("ticket:" + SECRET).toString("base64");
  const accepted = await read(await supportFn(req("POST", "/api/support/inbound/postmark", { body: payload, headers: { authorization: basic } })));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.ok, true);
  assert.equal(accepted.body.threaded, false);
  assert.equal(sent.length, 0);
});

test("lookalike and failing authentication go to quarantine with no ticket and no reply", async () => {
  sent.length = 0;
  process.env.TICKET_INBOUND_SECRET = SECRET;
  const before = (await lib.ticketStore().list({ prefix: "ticket/" })).blobs.length;
  const lookalike = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "user@evil-libertyretail.com.au",
      to: "screens@example.com",
      subject: "Lookalike",
      text: "Should not open a ticket.",
      stripped: "Should not open a ticket.",
    }),
  })));
  assert.equal(lookalike.status, 200);
  assert.equal(lookalike.body.quarantined, true);
  assert.equal(lookalike.body.reason, "sender");

  const subdomain = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "user@shop.libertyretail.com.au",
      to: "screens@example.com",
      subject: "Subdomain",
      text: "No",
      stripped: "No",
    }),
  })));
  assert.equal(subdomain.body.quarantined, true);

  const failedAuth = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "ada@example.com",
      to: "screens@example.com",
      subject: "Spoofed",
      text: "Fail auth",
      stripped: "Fail auth",
      headers: [
        { Name: "Received-SPF", Value: "Fail (sender SPF not authorized)" },
        { Name: "X-Spam-Tests", Value: "SPF_FAIL" },
      ],
    }),
  })));
  assert.equal(failedAuth.body.quarantined, true);
  assert.equal(failedAuth.body.reason, "auth-failed");
  const after = (await lib.ticketStore().list({ prefix: "ticket/" })).blobs.length;
  assert.equal(after, before);
  assert.equal(sent.length, 0);

  const listed = await inbound.listQuarantine(admin);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.quarantine.some((row) => row.reason === "auth-failed"), true);
  const denied = await inbound.listQuarantine({ kind: "verified-identity", provider: "otp", email: "screens.staff@libertyretail.com.au" });
  assert.equal(denied.status, 403);
});

test("inbound threads replies by ticket token and plus-address hash", async () => {
  sent.length = 0;
  process.env.TICKET_INBOUND_SECRET = SECRET;
  const opened = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "ada@example.com",
      to: "screens@example.com",
      subject: "Need a repair",
      text: "The screen is blank.\n\n> quoted earlier text",
      stripped: "The screen is blank.",
    }),
  })));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const id = opened.body.ticketId;
  const ticket = await lib.ticketStore().get("ticket/" + id, { type: "json" });
  assert.equal(ticket.description, "The screen is blank.");
  assert.equal(ticket.description.includes("quoted earlier text"), false);

  const bySubject = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "ada@example.com",
      to: "screens@example.com",
      subject: `[T-${ticket.number}] Need a repair`,
      text: "Still blank",
      stripped: "Still blank",
    }),
  })));
  assert.equal(bySubject.body.threaded, true);
  assert.equal(bySubject.body.ticketId, id);

  const byHash = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "ada@example.com",
      to: `screens+t${ticket.number}@example.com`,
      hash: `t${ticket.number}`,
      subject: "Re: Need a repair",
      text: "A plus-address follow up",
      stripped: "A plus-address follow up",
    }),
  })));
  assert.equal(byHash.body.threaded, true);
  const stored = await lib.ticketStore().get("ticket/" + id, { type: "json" });
  assert.equal(stored.messages.some((row) => row.kind === "public" && row.text === "Still blank"), true);
  assert.equal(stored.messages.some((row) => row.text === "A plus-address follow up"), true);
  assert.equal(sent.length, 0);

  const other = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, {
    body: postmarkPayload({
      from: "other@libertyretail.com.au",
      to: "screens@example.com",
      subject: `[T-${ticket.number}] Hijack`,
      text: "Not my ticket",
      stripped: "Not my ticket",
    }),
  })));
  assert.equal(other.body.quarantined, true);
  assert.equal(other.body.reason, "thread");
});

test("the Resend adapter verifies optional Svix signatures and uses a body fetch hook", async () => {
  process.env.TICKET_INBOUND_SECRET = SECRET;
  const svix = "whsec_" + Buffer.from("inbound-signing-secret-32b!!").toString("base64");
  process.env.RESEND_WEBHOOK_SECRET = svix;
  inbound.setInboundTestHooks({ fetchEmail: async () => ({
    text: "From resend",
    subject: "Resend request",
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  }) });
  const raw = JSON.stringify({ type: "email.received", data: { email_id: "email_1", from: "ada@example.com", to: ["screens@example.com"], subject: "Resend request" } });
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", Buffer.from(svix.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
  const bad = await read(await supportFn(req("POST", "/api/support/inbound/resend?token=" + encodeURIComponent(SECRET), {
    raw,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": "v1,not-a-valid-signature-value-xxxx" },
  })));
  assert.equal(bad.status, 401);
  const ok = await read(await supportFn(req("POST", "/api/support/inbound/resend?token=" + encodeURIComponent(SECRET), {
    raw,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": "v1," + signature },
  })));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  delete process.env.RESEND_WEBHOOK_SECRET;
  inbound.setInboundTestHooks({});
});

test("settings copy names the secret but does not display a value, and quoted text is stripped", () => {
  const page = fs.readFileSync(new URL("../public/admin/tickets-ui.mjs", import.meta.url), "utf8");
  assert.match(page, /TICKET_INBOUND_SECRET/);
  assert.match(page, /inbound\.postmarkapp\.com/);
  assert.match(page, /This page never shows the secret/);
  assert.equal(page.includes(SECRET), false);
  assert.equal(inbound.stripQuoted("Hello\n> quoted\nOn Mon, Jane wrote:\nolder").includes("quoted"), false);
  assert.equal(inbound.stripQuoted("Hello\n> quoted\nOn Mon, Jane wrote:\nolder"), "Hello");
});

test("plus-addressed queues on one Postmark inbound address route to the right queue", async () => {
  sent.length = 0;
  process.env.TICKET_INBOUND_SECRET = SECRET;
  const base = "0000example0000hash@inbound.postmarkapp.com";
  const current = tickets.normaliseSettings(await lib.ticketStore().get("settings", { type: "json" }));
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    ...current,
    inbound: { enabled: true, addresses: { screens: "0000example0000hash+screens@inbound.postmarkapp.com", signage: "0000example0000hash+signage@inbound.postmarkapp.com" } },
  }));
  const post = (payload) => supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, { body: payload })).then(read);
  const signage = await post(postmarkPayload({
    from: "Requester@LibertyRetail.com.au", to: "0000Example0000hash+Signage@inbound.postmarkapp.com", hash: "Signage",
    subject: "New sign", text: "Please print a sign.",
  }));
  assert.equal(signage.status, 200, JSON.stringify(signage.body));
  assert.equal(signage.body.threaded, false);
  const signageTicket = await lib.ticketStore().get("ticket/" + signage.body.ticketId, { type: "json" });
  assert.equal(signageTicket.queue, "signage");
  assert.equal(signageTicket.requesterEmail, "requester@libertyretail.com.au");
  assert.equal(signageTicket.description, "Please print a sign.");

  const screens = await post(postmarkPayload({
    from: "requester@libertyretail.com.au", to: "0000example0000hash+screens@inbound.postmarkapp.com", hash: "screens",
    subject: "Screen fault", text: "",
  }));
  const screensTicket = await lib.ticketStore().get("ticket/" + screens.body.ticketId, { type: "json" });
  assert.equal(screensTicket.queue, "screens");

  // Outlook HTML-only body falls back to text.
  const htmlOnly = await post({ ...postmarkPayload({ from: "requester@libertyretail.com.au", to: "0000example0000hash+screens@inbound.postmarkapp.com", hash: "screens", subject: "Html", text: "" }), HtmlBody: "<p>Hello <b>there</b></p>" });
  const htmlTicket = await lib.ticketStore().get("ticket/" + htmlOnly.body.ticketId, { type: "json" });
  assert.equal(htmlTicket.description, "Hello there");

  // Reply-to style base+tNNNN threads into the signage ticket.
  const reply = await post(postmarkPayload({
    from: "requester@libertyretail.com.au", to: `0000example0000hash+t${signageTicket.number}@inbound.postmarkapp.com`, hash: `t${signageTicket.number}`,
    subject: "Re: New sign", text: "Follow up", stripped: "Follow up",
  }));
  assert.equal(reply.body.threaded, true);
  assert.equal(reply.body.ticketId, signageTicket.id);

  // Bare base address cannot pick a queue and goes to review, not silently dropped.
  const bare = await post(postmarkPayload({ from: "requester@libertyretail.com.au", to: base, subject: "Which queue", text: "?" }));
  assert.equal(bare.body.quarantined, true);
  assert.equal(bare.body.reason, "queue");

  // Cc to the queue address is matched too.
  const cc = await post({ ...postmarkPayload({ from: "requester@libertyretail.com.au", to: "someone@example.com", subject: "Cc", text: "cc body" }), OriginalRecipient: "", CcFull: [{ Email: "0000example0000hash+signage@inbound.postmarkapp.com", MailboxHash: "signage" }] });
  const ccTicket = await lib.ticketStore().get("ticket/" + cc.body.ticketId, { type: "json" });
  assert.equal(ccTicket.queue, "signage");
  assert.equal(sent.length, 0);
});

test("routeRecipients handles plain and mixed queue addresses", () => {
  const settings = (screens, signage) => ({ inbound: { addresses: { screens, signage } } });
  assert.equal(inbound.routeRecipients(settings("screens@example.com", "signage@example.com"), ["screens+t1001@example.com"]).queue, "screens");
  assert.equal(inbound.routeRecipients(settings("screens@example.com", "signage@example.com"), ["SIGNAGE@example.com"]).queue, "signage");
  assert.deepEqual(inbound.routeRecipients(settings("screens@example.com", "signage@example.com"), ["nobody@example.com"]), { queue: "", known: false });
  assert.equal(inbound.routeRecipients(settings("hash@inbound.postmarkapp.com", "hash+signage@inbound.postmarkapp.com"), ["hash+signage@inbound.postmarkapp.com"]).queue, "signage");
  assert.equal(inbound.routeRecipients(settings("hash@inbound.postmarkapp.com", "hash+signage@inbound.postmarkapp.com"), ["hash@inbound.postmarkapp.com"]).queue, "screens");
  assert.equal(inbound.routeRecipients(settings("hash+screens@inbound.postmarkapp.com", "hash+signage@inbound.postmarkapp.com"), ["hash+t1001@inbound.postmarkapp.com"]).known, true);
});

test("Microsoft 365 style headers pass, and failures log outcome without addresses or tokens", async () => {
  const m365 = inbound.evaluateAuth("postmark", { Headers: [
    { Name: "Received-SPF", Value: "Pass (sender SPF authorized) identity=mailfrom" },
    { Name: "X-Spam-Tests", Value: "DKIM_SIGNED,DKIM_VALID,SPF_HELO_PASS,SPF_PASS" },
    { Name: "Authentication-Results", Value: "spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com" },
    { Name: "Authentication-Results", Value: "dmarc=bestguesspass action=none header.from=example.com" },
  ] });
  assert.equal(m365.ok, true);
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const res = await read(await supportFn(req("POST", "/api/support/inbound/postmark?token=wrong-token-value-xx", { body: {} })));
    assert.equal(res.status, 401);
  } finally { console.log = original; }
  const logged = lines.find((line) => line.includes("ticket-inbound"));
  assert.ok(logged);
  assert.deepEqual(JSON.parse(logged), { event: "ticket-inbound", kind: "postmark", status: 401, outcome: "rejected", reason: "token" });
  assert.equal(lines.join("\n").includes(SECRET), false);
  assert.equal(lines.join("\n").includes("wrong-token-value-xx"), false);
});
