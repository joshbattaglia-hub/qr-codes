import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.TICKET_MAIL;
delete process.env.TICKET_INBOUND_SECRET;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const tickets = await import("../netlify/lib/tickets.mjs");
const mailLib = await import("../netlify/lib/mail.mjs");
const inbound = await import("../netlify/lib/ticket-mail.mjs");
const sent = [];
mailLib.setMailTransport(async (message) => { sent.push(message); return { status: "sent", id: "local" }; });
tickets.setTicketTestHooks({ now: () => Date.parse("2026-11-10T02:00:00.000Z") });

const admin = { kind: "verified-identity", provider: "otp", email: tickets.TICKET_ADMIN_EMAIL };

function inboundRequest(path, payload, headers = {}) {
  return new Request("https://expresshelp.site" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

test("ticket mail stays off until both switches are on", async () => {
  await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    requesters: [{ email: "a@example.com", sites: ["s00000001"] }],
    inbound: { enabled: false, addresses: { screens: "screens@example.com", signage: "" } },
  }));
  const created = await tickets.createTicket(admin, {
    queue: "screens", siteId: "s00000001", requestType: "Other", priority: "normal", neededBy: "2026-12-01",
    subject: "Example request", description: "Example details.", requesterEmail: "a@example.com",
  });
  await tickets.addInternalNote(admin, created.body.ticket.id, { text: "Hidden from email" });
  const quiet = await inbound.notifyTicket(created.body.ticket, "status");
  assert.equal(quiet.status, "off");
  assert.equal(sent.length, 0);
  const settings = await tickets.readSettings();
  await lib.ticketStore().setJSON("settings", { ...settings, notifyGlobal: true, notify: { screens: true, signage: false } });
  const updated = await tickets.setStatus(admin, created.body.ticket.id, { status: "in-progress" });
  const sentStatus = await inbound.notifyTicket(updated.body.ticket, "status");
  assert.equal(sentStatus.status, "sent");
  assert.equal(sent.at(-1).to, "a@example.com");
  assert.equal(sent.at(-1).text.includes("Hidden from email"), false);
  assert.match(sent.at(-1).subject, /\[T-/);
  process.env.TICKET_MAIL = "off";
  const killed = await inbound.notifyTicket(updated.body.ticket, "reply", "Hello");
  assert.equal(killed.status, "killed");
  assert.equal(sent.length, 1);
  delete process.env.TICKET_MAIL;

  const supportFn = (await import("../netlify/functions/support.mjs")).default;
  const closed = await supportFn(inboundRequest("/api/support/inbound/postmark?token=secret-token-value", { From: "a@example.com", Subject: "Hi", TextBody: "Hello" }));
  assert.equal(closed.status, 404);
  process.env.TICKET_INBOUND_SECRET = "secret-token-value";
  await lib.ticketStore().setJSON("settings", { ...await tickets.readSettings(), inbound: { enabled: true, addresses: { screens: "screens@example.com", signage: "" } } });
  const unauthorised = await supportFn(inboundRequest("/api/support/inbound/postmark?token=wrong-token-value1", { From: "a@example.com" }));
  assert.equal(unauthorised.status, 401);
  const before = sent.length;
  const stranger = await supportFn(inboundRequest("/api/support/inbound/postmark?token=secret-token-value", {
    FromFull: { Email: "stranger@example.com" },
    ToFull: [{ Email: "screens@example.com" }],
    Subject: "Unknown sender",
    TextBody: "Please ignore\nOn Monday wrote:\n> old",
    StrippedTextReply: "Please ignore",
  }));
  const strangerBody = await stranger.json();
  assert.equal(stranger.status, 200);
  assert.equal(strangerBody.quarantined, true);
  assert.equal(sent.length, before);
  const known = await supportFn(inboundRequest("/api/support/inbound/postmark?token=secret-token-value", {
    FromFull: { Email: "a@example.com" },
    ToFull: [{ Email: "screens@example.com" }],
    Subject: "New example",
    TextBody: "Line one\n> quoted",
    StrippedTextReply: "Line one",
  }));
  const knownBody = await known.json();
  assert.equal(known.status, 200, JSON.stringify(knownBody));
  assert.equal(knownBody.ticket.description, "Line one");
  const reply = await supportFn(inboundRequest("/api/support/inbound/postmark?token=secret-token-value", {
    FromFull: { Email: "a@example.com" },
    ToFull: [{ Email: "screens@example.com" }],
    Subject: `[T-${knownBody.ticket.number}] New example`,
    StrippedTextReply: "A follow up",
  }));
  assert.equal(reply.status, 200);
  const stored = await lib.ticketStore().get("ticket/" + knownBody.ticket.id, { type: "json" });
  assert.equal(stored.messages.some((row) => row.text === "A follow up" && row.kind === "public"), true);
  assert.equal(sent.length, before);
  const secret = "whsec_" + Buffer.from("inbound-signing-secret-32b!!").toString("base64");
  const raw = JSON.stringify({ type: "email.received", data: { email_id: "email_1", from: "a@example.com", to: ["screens@example.com"], subject: "Resend" } });
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
  inbound.setInboundFetch(async () => ({ text: "From resend", subject: "Resend" }));
  process.env.TICKET_INBOUND_SECRET = secret;
  const resend = await supportFn(new Request("https://expresshelp.site/api/support/inbound/resend?token=" + encodeURIComponent(secret), {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": "v1," + signature },
    body: raw,
  }));
  assert.equal(resend.status, 200, await resend.clone().text());
});
