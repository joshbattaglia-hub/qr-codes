import crypto from "node:crypto";
import { env, ticketStore } from "./lib.mjs";
import { deliver } from "./mail.mjs";
import { addPublicReply, createTicket, readSettings, requesterScope, TICKET_ADMIN_EMAIL } from "./tickets.mjs";

let receivedFetch = null;
export function setInboundFetch(fn) { receivedFetch = typeof fn === "function" ? fn : null; }

export async function notifyTicket(ticket, event, text = "") {
  if (env("TICKET_MAIL") === "off") return { status: "killed" };
  const settings = await readSettings();
  if (settings.notifyGlobal !== true || settings.notify?.[ticket.queue] !== true) return { status: "off" };
  const to = String(ticket.requesterEmail || "");
  if (!to) return { status: "off" };
  const subject = `[T-${ticket.number}] ${ticket.subject}`;
  const body = event === "status"
    ? `Status is now ${ticket.statusLabel || ticket.status}.`
    : "A public reply was added:\n" + String(text || "").slice(0, 4000);
  return deliver({ to, subject, text: body, idempotencyKey: `ticket-${ticket.id}-${ticket.updatedAt}-${event}` });
}

export function stripQuoted(text) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0, 4000);
}

export function postmarkMessage(payload) {
  const from = payload?.FromFull?.Email || payload?.From || "";
  const to = (payload?.ToFull || []).map((row) => row.Email).filter(Boolean);
  return {
    from,
    to: to.length ? to : String(payload?.OriginalRecipient || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ? [String(payload.OriginalRecipient).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)[0]] : [],
    subject: payload?.Subject || "",
    text: payload?.StrippedTextReply || stripQuoted(payload?.TextBody || ""),
    hash: payload?.MailboxHash || "",
    attachments: (payload?.Attachments || []).slice(0, 3).map((file) => ({ name: file.Name, contentType: file.ContentType, data: file.Content })),
  };
}

export function resendMessage(event, fetched = {}) {
  const data = event?.data || {};
  return {
    from: data.from || "",
    to: Array.isArray(data.to) ? data.to : [],
    subject: fetched.subject || data.subject || "",
    text: stripQuoted(fetched.text || ""),
    hash: fetched.hash || "",
    attachments: (fetched.attachments || []).slice(0, 3),
  };
}

export function verifySvix(raw, headers, secret) {
  const id = headers.get("svix-id") || "";
  const timestamp = headers.get("svix-timestamp") || "";
  const signature = headers.get("svix-signature") || "";
  if (!id || !timestamp || !signature || !secret.startsWith("whsec_")) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const key = Buffer.from(secret.slice(6), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return signature.split(" ").some((part) => {
    const value = part.startsWith("v1,") ? part.slice(3) : "";
    if (!value || value.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}

function tokenOk(url, headers) {
  const secret = env("TICKET_INBOUND_SECRET");
  const supplied = new URL(url).searchParams.get("token") || "";
  const basic = headers.get("authorization") || "";
  const password = basic.toLowerCase().startsWith("basic ") ? Buffer.from(basic.slice(6), "base64").toString("utf8").split(":").slice(1).join(":") : "";
  const candidate = supplied || password;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function ticketNumber(subject, hash) {
  const subjectHit = String(subject || "").match(/\[T-(\d+)\]/);
  if (subjectHit) return Number(subjectHit[1]);
  const hashHit = String(hash || "").match(/^t(\d+)$/i);
  return hashHit ? Number(hashHit[1]) : 0;
}

async function findByNumber(number) {
  const { blobs } = await ticketStore().list({ prefix: "ticket/" });
  const rows = await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })));
  return rows.find((row) => row && row.number === number) || null;
}

export async function receiveInbound(kind, raw, headers, url) {
  const secret = env("TICKET_INBOUND_SECRET");
  const settings = await readSettings();
  if (secret.length < 16 || settings.inbound?.enabled !== true) return { status: 404, error: "Not found" };
  if (!tokenOk(url, headers)) return { status: 401, error: "Not authorised" };
  if (kind === "resend" && !verifySvix(raw, headers, secret)) return { status: 401, error: "Not authorised" };
  let payload;
  try { payload = JSON.parse(raw); } catch { return { status: 400, error: "The message was not accepted." }; }
  let message = kind === "postmark" ? postmarkMessage(payload) : null;
  if (kind === "resend") {
    const fetched = receivedFetch ? await receivedFetch(payload?.data?.email_id) : null;
    if (!fetched) return { status: 503, error: "The message body is not available." };
    message = resendMessage(payload, fetched);
  }
  const from = String(message.from || "").trim().toLowerCase();
  const queue = Object.entries(settings.inbound.addresses || {}).find(([, address]) => address && message.to.map((item) => item.toLowerCase()).includes(address))?.[0] || "";
  const scope = requesterScope(settings, from);
  if (!scope || !queue) {
    const id = "q" + crypto.randomBytes(8).toString("hex");
    await ticketStore().setJSON("quarantine/" + id, { id, at: new Date().toISOString(), from, to: message.to, subject: message.subject, text: message.text, queue });
    return { status: 200, body: { ok: true, quarantined: true } };
  }
  const number = ticketNumber(message.subject, message.hash);
  const existing = number ? await findByNumber(number) : null;
  if (existing) {
    const actor = { kind: "verified-identity", provider: "otp", email: TICKET_ADMIN_EMAIL };
    await addPublicReply(actor, existing.id, { text: message.text || "(empty reply)" });
    return { status: 200, body: { ok: true, ticketId: existing.id } };
  }
  const actor = { kind: "verified-identity", provider: "otp", email: TICKET_ADMIN_EMAIL };
  const created = await createTicket(actor, {
    queue,
    siteId: scope.sites[0] || "other",
    siteOther: scope.sites[0] ? "" : "Email",
    requestType: settings.types[queue][settings.types[queue].length - 1],
    priority: "normal",
    subject: message.subject || "Email request",
    description: message.text || "(empty message)",
    requesterEmail: scope.email,
  });
  return { status: created.status, body: created.body || { error: created.error } };
}

export async function listQuarantine(actorEmailIsAdmin) {
  if (!actorEmailIsAdmin) return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  const { blobs } = await ticketStore().list({ prefix: "quarantine/" });
  const rows = (await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })))).filter(Boolean);
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { status: 200, body: { quarantine: rows } };
}

export async function discardQuarantine(id) {
  await ticketStore().delete("quarantine/" + id);
  return { status: 200, body: { ok: true } };
}

export async function approveQuarantine(id) {
  const row = await ticketStore().get("quarantine/" + id, { type: "json" });
  if (!row) return { status: 404, error: "That message is not available." };
  const settings = await readSettings();
  const queue = settings.types[row.queue] ? row.queue : "screens";
  const actor = { kind: "verified-identity", provider: "otp", email: TICKET_ADMIN_EMAIL };
  const created = await createTicket(actor, {
    queue,
    siteId: "other",
    siteOther: "Email",
    requestType: settings.types[queue].at(-1),
    priority: "normal",
    subject: row.subject || "Email request",
    description: row.text || "(empty message)",
    requesterEmail: row.from && row.from.includes("@") ? row.from : TICKET_ADMIN_EMAIL,
  });
  if (created.status !== 200) return created;
  await ticketStore().delete("quarantine/" + id);
  return created;
}
