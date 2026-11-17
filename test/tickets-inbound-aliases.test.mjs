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

const OLD = "0000example0000hash";
const settingsWithAliases = () => tickets.normaliseSettings({
  requesters: [{ email: "ada@example.com", sites: ["s00000001"] }],
  domains: [{ domain: "libertyretail.com.au", sites: [], area: "" }],
  notify: { screens: true, signage: true }, notifyGlobal: true,
  inbound: {
    enabled: true,
    addresses: { screens: "screens@support.example.test", signage: "signage@support.example.test" },
    aliases: { screens: [OLD + "+screens@inbound.postmarkapp.com", "screens@support.example.test"], signage: OLD + "+signage@inbound.postmarkapp.com, bad-value" },
  },
});

test("inbound aliases: normalised, primary not duplicated, capped, stored with settings", () => {
  const s = settingsWithAliases();
  assert.deepEqual(s.inbound.aliases, { screens: [OLD + "+screens@inbound.postmarkapp.com"], signage: [OLD + "+signage@inbound.postmarkapp.com"] });
  assert.deepEqual(tickets.normaliseSettings({}).inbound.aliases, { screens: [], signage: [] });
  const many = tickets.normaliseSettings({ inbound: { addresses: { screens: "a@x.test" }, aliases: { screens: ["b@x.test", "c@x.test", "d@x.test", "e@x.test", "f@x.test", "g@x.test"] } } });
  assert.equal(many.inbound.aliases.screens.length, 5);
});

test("routing: new subdomain addresses, old plus addresses as aliases, and +t threading tags on both domains", () => {
  const s = settingsWithAliases();
  const route = (to) => inbound.routeRecipients(s, [to]);
  assert.deepEqual(route("signage@support.example.test"), { queue: "signage", known: true });
  assert.deepEqual(route("Screens@Support.Example.Test"), { queue: "screens", known: true });
  assert.equal(route(OLD + "+signage@inbound.postmarkapp.com").queue, "signage");
  assert.equal(route(OLD + "+screens@inbound.postmarkapp.com").queue, "screens");
  assert.equal(route("signage+t1005@support.example.test").queue, "signage");
  assert.equal(route("screens+t1001@support.example.test").queue, "screens");
  assert.deepEqual(route(OLD + "+t1005@inbound.postmarkapp.com"), { queue: "", known: true }, "old-domain +t is known; the ticket number picks the thread");
  assert.deepEqual(route("nobody@support.example.test"), { queue: "", known: false });
  // Old settings without aliases still behave as before.
  const legacy = { inbound: { addresses: { screens: OLD + "+screens@inbound.postmarkapp.com", signage: OLD + "+signage@inbound.postmarkapp.com" } } };
  assert.equal(inbound.routeRecipients(legacy, [OLD + "+signage@inbound.postmarkapp.com"]).queue, "signage");
});

test("end to end: new address creates, old alias creates, replies thread on both domains, reply-to uses the new address", async () => {
  sent.length = 0;
  process.env.TICKET_INBOUND_SECRET = SECRET;
  await lib.ticketStore().setJSON("settings", settingsWithAliases());
  const post = (payload) => supportFn(req("POST", "/api/support/inbound/postmark?token=" + SECRET, { body: payload })).then(read);
  const created = await post(postmarkPayload({ from: "tester@libertyretail.com.au", to: "signage@support.example.test", subject: "TEST signage inbound", text: "Synthetic body." }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.threaded, false);
  const t = await lib.ticketStore().get("ticket/" + created.body.ticketId, { type: "json" });
  assert.equal(t.queue, "signage");

  const old = await post(postmarkPayload({ from: "tester@libertyretail.com.au", to: OLD + "+screens@inbound.postmarkapp.com", hash: "screens", subject: "Old address", text: "Still works." }));
  assert.equal((await lib.ticketStore().get("ticket/" + old.body.ticketId, { type: "json" })).queue, "screens");

  const replyNew = await post(postmarkPayload({ from: "tester@libertyretail.com.au", to: `signage+t${t.number}@support.example.test`, hash: `t${t.number}`, subject: "Re: TEST signage inbound", text: "Reply new", stripped: "Reply new" }));
  assert.equal(replyNew.body.threaded, true);
  assert.equal(replyNew.body.ticketId, t.id);
  const replyOld = await post(postmarkPayload({ from: "tester@libertyretail.com.au", to: `${OLD}+t${t.number}@inbound.postmarkapp.com`, hash: `t${t.number}`, subject: "Re: something", text: "Reply old", stripped: "Reply old" }));
  assert.equal(replyOld.body.threaded, true);
  assert.equal(replyOld.body.ticketId, t.id);

  const mailed = await inbound.notifyTicket({ ...t, updatedAt: "2026-11-10T03:00:00.000Z" }, "status");
  assert.equal(mailed.status, "sent");
  assert.equal(sent.at(-1).replyTo, `signage+t${t.number}@support.example.test`);
  assert.match(sent.at(-1).subject, new RegExp("\\[T-" + t.number + "\\]"));
});
