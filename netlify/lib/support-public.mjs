import crypto from "node:crypto";
import { conditionalIncrement, env, rateStore, ticketStore } from "./lib.mjs";
import {
  BOARD_COLUMNS, PRIORITIES, QUEUES, acceptTicketFile, allTicketRows, auditRow, columnFor, columnLabel, doneAt, emailOf, listSiteChoices, readSettings, siteChoiceFor,
} from "./tickets.mjs";
import { derivedTrackToken, hashTrackToken, trackPath, trackTokenMatches, writeTrackIndex } from "./ticket-track.mjs";

export const REQUESTER_DOMAIN = "libertyretail.com.au";
export const SUBMIT_MAX_BYTES = 5_000_000;
export const MIN_FILL_MS = 3000;
const FORM_MAX_AGE_MS = 24 * 3600 * 1000;
const TEXT_MAX = 4000;
const FILES_MAX = 3;
const QUEUE_LABEL = { screens: "Screens", signage: "Signage" };
const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

let clock = () => Date.now();
export function setPublicTestHooks({ now = null } = {}) {
  clock = typeof now === "function" ? now : () => Date.now();
}

function serverKey() {
  const secret = env("OTP_SESSION_SECRET") || env("ADMIN_PASSWORD") || "";
  return crypto.createHash("sha256").update("support-public\n" + secret).digest();
}

/** Hashed, truncated client key. The raw address is never stored or logged. */
export function clientKey(req) {
  const value = String(req.headers.get("x-nf-client-connection-ip") || "").trim();
  if (!value || value.length > 64 || !/^[0-9a-f:.]+$/i.test(value)) return "untrusted";
  return crypto.createHmac("sha256", serverKey()).update("ip\n" + value).digest("hex").slice(0, 20);
}

async function limited(req, kind, perWindow, perDay) {
  const key = clientKey(req);
  const t = clock();
  const windowId = Math.floor(t / 600000);
  const dayId = Math.floor(t / 86400000);
  const factor = key === "untrusted" ? 0.5 : 1;
  for (const [bucket, max] of [[`w${windowId}`, Math.max(1, Math.floor(perWindow * factor))], [`d${dayId}`, Math.max(1, Math.floor(perDay * factor))]]) {
    const result = await conditionalIncrement(rateStore(), `support/${kind}/${key}/${bucket}`, max);
    if (!result.ok && result.reason === "unsupported") return { status: 503, error: "Support is temporarily unavailable." };
    if (result.reason === "limit") return { status: 429, error: "Too many requests. Wait a few minutes and try again." };
  }
  return null;
}

export function issueFormToken(at = clock()) {
  const issued = String(Math.floor(at));
  const mac = crypto.createHmac("sha256", serverKey()).update("form\n" + issued).digest("base64url").slice(0, 32);
  return issued + "." + mac;
}

export function formTokenAge(token, at = clock()) {
  const [issued, mac] = String(token || "").split(".");
  if (!/^\d{10,16}$/.test(issued || "") || !mac) return -1;
  const expected = crypto.createHmac("sha256", serverKey()).update("form\n" + issued).digest("base64url").slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return -1;
  return at - Number(issued);
}

export function requesterEmailOk(value) {
  const email = emailOf(value);
  if (!email) return "";
  return email.split("@")[1] === REQUESTER_DOMAIN ? email : "";
}

/** Australian numbers: mobiles and landlines (0X or +61X + 8 digits), 13/1300/1800, or an 8-digit local landline. */
export function phoneOk(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 30) return "";
  if (!/^[0-9+()\s.-]+$/.test(raw)) return "";
  const digits = raw.replace(/\(0\)/g, "").replace(/[\s().-]/g, "");
  const ok = /^(?:\+61|61|0)[2-478]\d{8}$/.test(digits)
    || /^1[38]00\d{6}$/.test(digits)
    || /^13\d{4}$/.test(digits)
    || /^\d{8}$/.test(digits);
  return ok ? raw.replace(/\s+/g, " ") : "";
}

export function makeTrackToken(ticketId) {
  return derivedTrackToken(ticketId);
}

export async function publicForm() {
  const settings = await readSettings();
  const sites = (await listSiteChoices()).map((site) => ({ id: site.id, name: site.name }));
  return { status: 200, body: { types: settings.types, sites, formToken: issueFormToken(), domain: REQUESTER_DOMAIN } };
}

export async function submitPublicTicket(req, raw) {
  if (raw.length > SUBMIT_MAX_BYTES) return { status: 413, error: "The request is too large. Use fewer or smaller files." };
  let body;
  try { body = JSON.parse(raw); } catch { return { status: 400, error: "The request was not accepted." }; }
  if (!body || typeof body !== "object") return { status: 400, error: "The request was not accepted." };
  const blocked = await limited(req, "submit", 5, 30);
  if (blocked) return blocked;
  if (String(body.website || "").trim()) return { status: 400, error: "The request was not accepted." };
  const age = formTokenAge(body.formToken);
  if (age < 0 || age > FORM_MAX_AGE_MS) return { status: 400, error: "This form has expired. Reload the page and try again." };
  if (age < MIN_FILL_MS) return { status: 400, error: "That was quick. Check your details and submit again." };

  const name = String(body.name || "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return { status: 400, error: "Enter your full name." };
  const email = requesterEmailOk(body.email);
  if (!email) return { status: 400, error: "Use your @" + REQUESTER_DOMAIN + " email address." };
  const phone = phoneOk(body.phone);
  if (!phone) return { status: 400, error: "Enter a valid Australian phone number." };
  const queue = QUEUES.includes(body.queue) ? body.queue : "";
  if (!queue) return { status: 400, error: "Choose Screens or Signage." };
  const settings = await readSettings();
  const requestType = String(body.requestType || "").trim();
  if (!settings.types[queue].includes(requestType)) return { status: 400, error: "Choose a request type." };
  const priority = PRIORITIES.includes(body.priority) ? body.priority : "";
  if (!priority) return { status: 400, error: "Choose a priority." };
  const subject = String(body.subject || "").trim().slice(0, 140);
  const description = String(body.description || "").trim().slice(0, TEXT_MAX);
  if (!subject || !description) return { status: 400, error: "Subject and description are required." };
  const neededBy = String(body.neededBy || "");
  if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return { status: 400, error: "Needed-by must be a date." };
  const site = await siteChoiceFor(body.siteId, body.siteOther);
  if (site.error) return { status: 400, error: site.error };

  const files = [];
  const incoming = Array.isArray(body.files) ? body.files : [];
  if (incoming.length > FILES_MAX) return { status: 400, error: "Attach up to " + FILES_MAX + " files." };
  for (const row of incoming) {
    let bytes;
    try { bytes = Buffer.from(String(row?.data || ""), "base64"); } catch { return { status: 400, error: "A file was not accepted." }; }
    const file = await acceptTicketFile(bytes, row?.name);
    if (file.error) return { status: 400, error: file.error };
    files.push(file);
  }

  const count = await conditionalIncrement(ticketStore(), "counter", 1000000);
  if (!count.ok) return { status: 503, error: "Tickets are temporarily unavailable." };
  const at = new Date(clock()).toISOString();
  const ticketId = "t" + crypto.randomBytes(8).toString("hex");
  const token = makeTrackToken(ticketId);
  const ticket = {
    id: ticketId,
    number: 1000 + count.n,
    queue, ...site, siteFreeText: site.siteId === "other", requestType, priority, neededBy,
    subject, description,
    requesterEmail: email, requesterName: name, requesterPhone: phone,
    source: "web-form",
    trackHash: hashTrackToken(token),
    status: "new",
    statusHistory: [{ at, from: "", to: "new", actor: email }],
    assignee: "",
    messages: [],
    closeOut: null,
    files: [],
    createdAt: at,
    updatedAt: at,
  };
  for (const file of files) {
    const saved = { id: "f" + crypto.randomBytes(8).toString("hex"), name: file.name, contentType: file.contentType };
    await ticketStore().setJSON("file/" + saved.id, { ...saved, ticketId: ticket.id, bytes: file.bytes });
    ticket.files.push(saved);
  }
  await ticketStore().setJSON("ticket/" + ticket.id, ticket);
  await writeTrackIndex(ticket.number, ticket.id);
  await auditRow(email, "web-request", ticket.id, queue);
  return { status: 200, body: { ok: true, number: ticket.number, token, trackPath: trackPath(ticket.number, token) } };
}

function presentTracking(ticket) {
  return {
    number: ticket.number,
    queue: QUEUE_LABEL[ticket.queue] || ticket.queue,
    site: ticket.siteLabel,
    requestType: ticket.requestType,
    priority: PRIORITY_LABEL[ticket.priority] || ticket.priority,
    subject: ticket.subject,
    description: ticket.description,
    status: columnLabel(columnFor(ticket.status)),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    history: (ticket.statusHistory || []).map((row) => ({ at: row.at, status: columnLabel(columnFor(row.to)) })),
    replies: (ticket.messages || []).filter((row) => row.kind === "public").map((row) => ({
      at: row.at,
      from: row.actor === ticket.requesterEmail ? "You" : "Express Help",
      text: row.text,
    })),
  };
}

const NOT_FOUND = { status: 404, error: "That tracking link is not valid." };

export async function readTracking(req, raw) {
  if (raw.length > 2000) return NOT_FOUND;
  const blocked = await limited(req, "track", 60, 600);
  if (blocked) return blocked;
  let body;
  try { body = JSON.parse(raw); } catch { return NOT_FOUND; }
  const number = Number(body?.number);
  const token = String(body?.token || "");
  if (!Number.isInteger(number) || number < 1 || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return NOT_FOUND;
  const index = await ticketStore().get("track/" + number, { type: "json" });
  const id = index?.id;
  const ticket = id && /^t[a-f0-9]{16}$/.test(id) ? await ticketStore().get("ticket/" + id, { type: "json" }) : null;
  const match = trackTokenMatches(ticket, token);
  if (!ticket || ticket.number !== number || !match) return NOT_FOUND;
  return { status: 200, body: { ticket: presentTracking(ticket) } };
}

export const PUBLIC_DONE_DAYS = 30;

/** Public board row. Whitelist only: number, site, queue, column, updatedAt. */
export const PUBLIC_OTHER_SITE = "Other site";

/** Public board row. Whitelist only: number, site, queue, column, updatedAt. Typed-in sites never leave the server. */
export function publicBoardRow(ticket) {
  const freeText = ticket.siteId === "other" || ticket.siteFreeText === true || !/^s[a-f0-9]{8}$/.test(String(ticket.siteId || ""));
  const site = freeText ? PUBLIC_OTHER_SITE : String(ticket.siteLabel || "").replace(/\s+/g, " ").trim().slice(0, 80) || PUBLIC_OTHER_SITE;
  return {
    number: Number(ticket.number) || 0,
    site,
    queue: QUEUES.includes(ticket.queue) ? ticket.queue : "",
    column: columnFor(ticket.status),
    updatedAt: String(ticket.updatedAt || ""),
  };
}

export async function publicBoard(req) {
  const blocked = await limited(req, "board", 30, 1000);
  if (blocked) return blocked;
  const cutoff = clock() - PUBLIC_DONE_DAYS * 86400000;
  const rows = (await allTicketRows())
    .filter((ticket) => ticket && ticket.number && QUEUES.includes(ticket.queue))
    .filter((ticket) => columnFor(ticket.status) !== "done" || Date.parse(doneAt(ticket)) >= cutoff)
    .map(publicBoardRow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { status: 200, body: { columns: BOARD_COLUMNS.map(({ id, label }) => ({ id, label })), doneDays: PUBLIC_DONE_DAYS, tickets: rows } };
}
