import crypto from "node:crypto";
import { env, ticketStore } from "./lib.mjs";
import { deliver } from "./mail.mjs";
import {
  acceptTicketFile, domainAllowed, emailOf, findTicketByNumber, ingestEmailReply, ingestEmailTicket,
  readSettings, requesterScope, ticketAccess,
} from "./tickets.mjs";

let receivedFetch = null;
let clock = () => Date.now();
export function setInboundTestHooks({ fetchEmail = null, now = null } = {}) {
  receivedFetch = typeof fetchEmail === "function" ? fetchEmail : null;
  clock = typeof now === "function" ? now : () => Date.now();
}

function publicUrl() {
  return (env("PUBLIC_URL") || "https://expresshelp.site").replace(/\/+$/, "");
}

export function inboundWebhookUrls() {
  const base = publicUrl();
  return {
    postmark: base + "/api/support/inbound/postmark?token=",
    resend: base + "/api/support/inbound/resend?token=",
  };
}

export function inboundReady(settings = null) {
  const secret = env("TICKET_INBOUND_SECRET");
  if (secret.length < 16) return false;
  if (settings?.inbound?.enabled !== true) return false;
  const addresses = settings.inbound?.addresses || {};
  return Boolean(addresses.screens || addresses.signage);
}

export function outboundAllowed(settings, queue) {
  if (env("TICKET_MAIL") === "off") return false;
  if (settings?.notifyGlobal !== true) return false;
  if (settings?.notify?.[queue] !== true) return false;
  return true;
}

export async function notifyTicket(ticket, event, text = "") {
  if (!ticket?.requesterEmail) return { status: "off" };
  const settings = await readSettings();
  if (!outboundAllowed(settings, ticket.queue)) return { status: env("TICKET_MAIL") === "off" ? "killed" : "off" };
  const number = ticket.number;
  const subject = `[T-${number}] ${ticket.subject}`;
  const statusLine = ticket.statusLabel || ticket.status;
  const body = event === "status"
    ? `Your Express Help ticket T-${number} is now ${statusLine}.\n\nReply to this email or keep [T-${number}] in the subject.`
    : `A public reply was added to your Express Help ticket T-${number}:\n\n${String(text || "").slice(0, 4000)}\n\nReply to this email or keep [T-${number}] in the subject.`;
  const inbound = settings.inbound?.addresses?.[ticket.queue] || "";
  let replyTo = "";
  if (inbound.includes("@")) {
    const [local, domain] = inbound.split("@");
    const base = local.split("+")[0];
    replyTo = `${base}+t${number}@${domain}`;
  }
  return deliver({
    to: ticket.requesterEmail,
    subject,
    text: body,
    replyTo: replyTo || undefined,
    idempotencyKey: `ticket-${ticket.id}-${ticket.updatedAt}-${event}`,
  });
}

export function stripQuoted(text) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/i.test(line)) break;
    if (/^-----Original Message-----/i.test(line)) break;
    if (/^From:\s.+\n?Sent:\s/i.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0, 4000);
}

function headerMap(headers) {
  const out = {};
  for (const row of Array.isArray(headers) ? headers : []) {
    const name = String(row?.Name || row?.name || "").trim().toLowerCase();
    if (!name) continue;
    const value = String(row?.Value ?? row?.value ?? "");
    out[name] = out[name] ? out[name] + "; " + value : value;
  }
  if (headers && !Array.isArray(headers) && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) out[String(name).toLowerCase()] = String(value ?? "");
  }
  return out;
}

function resultPass(value) {
  return /^\s*pass\b/i.test(String(value || ""));
}

export function evaluateAuth(kind, payload, fetched = {}) {
  if (kind === "resend") {
    const auth = fetched?.authentication || payload?.data?.authentication || null;
    if (!auth || typeof auth !== "object") return { ok: false, reason: "auth-missing", spf: "", dkim: "", dmarc: "" };
    const spf = String(auth.spf || "");
    const dkim = String(auth.dkim || "");
    const dmarc = String(auth.dmarc || "");
    const dmarcOk = !dmarc || dmarc === "pass" || dmarc === "gray";
    const ok = spf === "pass" && dkim === "pass" && dmarcOk;
    return { ok, reason: ok ? "" : "auth-failed", spf, dkim, dmarc };
  }
  const headers = headerMap(payload?.Headers || payload?.headers || fetched?.headers);
  const tests = headers["x-spam-tests"] || "";
  const receivedSpf = headers["received-spf"] || "";
  const authResults = headers["authentication-results"] || "";
  const spf = resultPass(receivedSpf) || /\bSPF_PASS\b/.test(tests) || /(?:^|[\s;])spf=pass\b/i.test(authResults)
    ? "pass"
    : (receivedSpf || (/\bSPF_/.test(tests) ? "fail" : (/spf=/i.test(authResults) ? "fail" : "")));
  const dkim = /\bDKIM_VALID\b/.test(tests) || /(?:^|[\s;])dkim=pass\b/i.test(authResults)
    ? "pass"
    : ((/\bDKIM_/.test(tests) || /dkim=/i.test(authResults)) ? "fail" : "");
  let dmarc = "";
  const dmarcHit = authResults.match(/dmarc\s*=\s*([a-z]+)/i);
  if (dmarcHit) dmarc = dmarcHit[1].toLowerCase();
  const dmarcOk = !dmarc || dmarc === "pass" || dmarc === "bestguesspass";
  const ok = spf === "pass" && dkim === "pass" && dmarcOk;
  return { ok, reason: ok ? "" : "auth-failed", spf, dkim, dmarc };
}

export function baseEmail(value) {
  const email = emailOf(value);
  if (!email) return "";
  const [local, domain] = email.split("@");
  return `${local.split("+")[0]}@${domain}`;
}

export function plusHash(value) {
  const email = emailOf(value);
  if (!email) return "";
  const local = email.split("@")[0];
  const idx = local.indexOf("+");
  return idx >= 0 ? local.slice(idx + 1) : "";
}

export function ticketToken(subject, hash) {
  const subjectHit = String(subject || "").match(/\[T-(\d+)\]/i);
  if (subjectHit) return Number(subjectHit[1]);
  const hashHit = String(hash || "").match(/^t(\d+)$/i);
  return hashHit ? Number(hashHit[1]) : 0;
}

export function routeRecipients(settings, recipients) {
  const addresses = settings?.inbound?.addresses || {};
  const configured = {};
  for (const queue of ["screens", "signage"]) {
    const full = emailOf(addresses[queue] || "");
    if (full) configured[queue] = { full, base: baseEmail(full) };
  }
  const list = [...new Set((recipients || []).map(emailOf).filter(Boolean))];
  for (const address of list) {
    for (const [queue, row] of Object.entries(configured)) {
      if (row.full === address) return { queue, known: true };
    }
  }
  let known = false;
  for (const address of list) {
    const base = baseEmail(address);
    const hits = Object.entries(configured).filter(([, row]) => row.base === base);
    if (!hits.length) continue;
    known = true;
    const plain = hits.filter(([, row]) => row.full === row.base);
    if (hits.length === 1 && (plain.length === 1 || !plusHash(address))) return { queue: hits[0][0], known };
    if (plain.length === 1 && !/^t\d+$/i.test(plusHash(address))) return { queue: plain[0][0], known };
  }
  return { queue: "", known };
}

function queueForRecipients(settings, recipients) {
  return routeRecipients(settings, recipients).queue;
}

function addressList(rows) {
  return Array.isArray(rows) ? rows.map((row) => row?.Email || row?.email || "").filter(Boolean) : [];
}

function htmlText(html) {
  return String(html || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();
}

export function postmarkMessage(payload) {
  const from = payload?.FromFull?.Email || payload?.From || "";
  const toFull = [
    ...(payload?.OriginalRecipient ? [String(payload.OriginalRecipient)] : []),
    ...addressList(payload?.ToFull),
    ...addressList(payload?.CcFull),
    ...addressList(payload?.BccFull),
  ];
  const hash = payload?.MailboxHash || toFull.map(plusHash).find(Boolean) || "";
  return {
    from,
    to: toFull,
    subject: payload?.Subject || "",
    text: payload?.StrippedTextReply || stripQuoted(payload?.TextBody || "") || stripQuoted(htmlText(payload?.HtmlBody || "")),
    hash,
    attachments: (payload?.Attachments || []).map((file) => ({
      name: file.Name || file.name || "attachment",
      contentType: file.ContentType || file.contentType || "",
      data: file.Content || file.content || file.data || "",
    })),
  };
}

export function resendMessage(event, fetched = {}) {
  const data = event?.data || {};
  const to = Array.isArray(data.to) ? data.to : [];
  const hash = fetched.hash || to.map(plusHash).find(Boolean) || "";
  return {
    from: data.from || fetched.from || "",
    to,
    subject: fetched.subject || data.subject || "",
    text: fetched.text ? stripQuoted(fetched.text) : stripQuoted(htmlText(fetched.html || "")),
    hash,
    attachments: fetched.attachments || [],
  };
}

function sameSecret(candidate, secret) {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(String(secret || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function inboundTokenOk(url, headers) {
  const secret = env("TICKET_INBOUND_SECRET");
  if (secret.length < 16) return false;
  let token = "";
  try { token = new URL(url).searchParams.get("token") || ""; } catch { token = ""; }
  const basic = headers.get("authorization") || "";
  let password = "";
  if (basic.toLowerCase().startsWith("basic ")) {
    try { password = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":").slice(1).join(":"); }
    catch { password = ""; }
  }
  return sameSecret(token, secret) || sameSecret(password, secret);
}

export function verifySvix(raw, headers, secret) {
  const id = headers.get("svix-id") || "";
  const timestamp = headers.get("svix-timestamp") || "";
  const signature = headers.get("svix-signature") || "";
  if (!id || !timestamp || !signature || !String(secret || "").startsWith("whsec_")) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  let key;
  try { key = Buffer.from(secret.slice(6), "base64"); } catch { return false; }
  if (!key.length) return false;
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return String(signature).split(" ").some((part) => {
    const value = part.startsWith("v1,") ? part.slice(3) : "";
    if (!value) return false;
    const left = Buffer.from(value);
    const right = Buffer.from(expected);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  });
}

async function fetchResendEmail(emailId) {
  if (receivedFetch) return receivedFetch(emailId);
  const key = env("RESEND_API_KEY");
  if (!key || !emailId) return null;
  const res = await fetch("https://api.resend.com/emails/receiving/" + encodeURIComponent(emailId), {
    headers: { authorization: "Bearer " + key },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function acceptAttachments(rows) {
  const out = [];
  for (const row of (rows || []).slice(0, 8)) {
    let bytes;
    try { bytes = Buffer.from(String(row.data || ""), "base64"); } catch { continue; }
    const file = await acceptTicketFile(bytes, row.name);
    if (file.error) continue;
    out.push(file);
  }
  return out;
}

async function quarantine(row) {
  const id = "q" + crypto.randomBytes(8).toString("hex");
  const saved = {
    id,
    at: new Date(clock()).toISOString(),
    from: row.from || "",
    to: row.to || [],
    subject: String(row.subject || "").slice(0, 140),
    text: String(row.text || "").slice(0, 4000),
    queue: row.queue || "",
    reason: row.reason || "rejected",
  };
  await ticketStore().setJSON("quarantine/" + id, saved);
  return { status: 200, body: { ok: true, quarantined: true, reason: saved.reason } };
}

function logInbound(kind, status, outcome, reason = "") {
  // Outcome only: never the token, addresses, subject or body.
  console.log(JSON.stringify({ event: "ticket-inbound", kind, status, outcome, reason }));
}

export async function receiveInbound(kind, raw, headers, url) {
  try {
    const result = await handleInbound(kind, raw, headers, url);
    const outcome = result.body?.quarantined ? "quarantined" : (result.body?.threaded ? "threaded" : (result.status === 200 ? "created" : "rejected"));
    logInbound(kind, result.status, outcome, result.body?.reason || result.logReason || "");
    delete result.logReason;
    return result;
  } catch (error) {
    logInbound(kind, 500, "error", String(error?.name || "Error"));
    return { status: 500, error: "The message could not be processed." };
  }
}

async function handleInbound(kind, raw, headers, url) {
  const settings = await readSettings();
  if (!inboundReady(settings)) {
    const reason = env("TICKET_INBOUND_SECRET").length < 16 ? "secret-missing" : (settings?.inbound?.enabled !== true ? "disabled" : "no-address");
    return { status: 404, error: "Not found", logReason: reason };
  }
  if (!inboundTokenOk(url, headers)) return { status: 401, error: "Not authorised", logReason: "token" };
  const svixSecret = env("RESEND_WEBHOOK_SECRET");
  if (kind === "resend" && svixSecret && !verifySvix(raw, headers, svixSecret)) return { status: 401, error: "Not authorised", logReason: "signature" };
  let payload;
  try { payload = JSON.parse(raw); } catch { return { status: 400, error: "The message was not accepted.", logReason: "json" }; }
  let fetched = {};
  if (kind === "resend") {
    fetched = await fetchResendEmail(payload?.data?.email_id);
    if (!fetched) return { status: 503, error: "The message body is not available.", logReason: "fetch" };
  }
  const message = kind === "postmark" ? postmarkMessage(payload) : resendMessage(payload, fetched);
  const from = emailOf(message.from);
  const route = routeRecipients(settings, message.to);
  let queue = route.queue;
  const scope = requesterScope(settings, from);
  const auth = evaluateAuth(kind, payload, fetched);
  if (!from || !scope) return quarantine({ ...message, queue, reason: "sender" });
  if (!auth.ok) return quarantine({ ...message, queue, reason: auth.reason || "auth-failed" });
  if (!route.known) return quarantine({ ...message, queue, reason: "queue" });
  const number = ticketToken(message.subject, message.hash);
  const existing = number ? await findTicketByNumber(number) : null;
  if (existing) {
    if (existing.requesterEmail !== from) return quarantine({ ...message, queue: existing.queue || queue, reason: "thread" });
    const files = await acceptAttachments(message.attachments);
    const result = await ingestEmailReply(existing.id, from, message.text || "", files);
    if (result.status !== 200) return quarantine({ ...message, queue: existing.queue || queue, reason: "thread" });
    return { status: 200, body: { ok: true, ticketId: existing.id, threaded: true } };
  }
  if (!queue) return quarantine({ ...message, queue, reason: "queue" });
  const files = await acceptAttachments(message.attachments);
  const created = await ingestEmailTicket({
    queue,
    requesterEmail: from,
    subject: message.subject,
    description: message.text,
    siteId: scope.sites[0] || "other",
    siteOther: scope.sites[0] ? "" : "Email",
    files,
  });
  if (created.status !== 200) return quarantine({ ...message, queue, reason: "create-failed" });
  return { status: 200, body: { ok: true, ticketId: created.body.ticket.id, threaded: false } };
}

export async function listQuarantine(actor) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  const { blobs } = await ticketStore().list({ prefix: "quarantine/" });
  const rows = (await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })))).filter(Boolean);
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { status: 200, body: { quarantine: rows.slice(0, 200) } };
}

export async function discardQuarantine(actor, id) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  if (!/^q[a-f0-9]{16}$/.test(id || "")) return { status: 404, error: "That message is not available." };
  await ticketStore().delete("quarantine/" + id);
  return { status: 200, body: { ok: true } };
}

export async function approveQuarantine(actor, id) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  if (!/^q[a-f0-9]{16}$/.test(id || "")) return { status: 404, error: "That message is not available." };
  const row = await ticketStore().get("quarantine/" + id, { type: "json" });
  if (!row) return { status: 404, error: "That message is not available." };
  const settings = await readSettings();
  const queue = settings.types[row.queue] ? row.queue : "screens";
  const created = await ingestEmailTicket({
    queue,
    requesterEmail: emailOf(row.from) || access.email,
    subject: row.subject || "Email request",
    description: row.text || "(empty message)",
    siteId: "other",
    siteOther: "Email",
  });
  if (created.status !== 200) return created;
  await ticketStore().delete("quarantine/" + id);
  return created;
}
