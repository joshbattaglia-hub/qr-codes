import crypto from "node:crypto";
import { conditionalIncrement, sitesStore, ticketStore } from "./lib.mjs";
import { reencodeVisitorPhoto } from "./visitor-image.mjs";
import { isSiteRecord } from "./site-import.mjs";

export const TICKET_ADMIN_EMAIL = "jbattaglia@libertyretail.com.au";
export const QUEUES = ["screens", "signage"];
export const STATUSES = ["new", "in-progress", "awaiting", "scheduled", "done", "closed"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const STATUS_LABEL = {
  new: "New",
  "in-progress": "In progress",
  awaiting: "Awaiting info",
  scheduled: "Scheduled",
  done: "Done",
  closed: "Closed",
};
export const DEFAULT_TYPES = {
  screens: ["New screen install", "Content/playlist change", "Fault or repair", "Relocation or removal", "Other"],
  signage: ["New sign or install", "Replacement", "Damage or repair", "Promotional install", "Other"],
};
const OPEN = new Set(["new", "in-progress", "awaiting", "scheduled"]);
const FILE_MAX = 1_500_000;
const TEXT_MAX = 4000;

let clock = () => Date.now();
export function setTicketTestHooks({ now = null } = {}) {
  clock = typeof now === "function" ? now : () => Date.now();
}
function now() { return clock(); }

export function defaultSettings() {
  return {
    staff: { screens: [], signage: [] },
    types: { screens: [...DEFAULT_TYPES.screens], signage: [...DEFAULT_TYPES.signage] },
    requesters: [],
    domains: [],
    visibility: "own-and-sites",
    notify: { screens: false, signage: false },
    notifyGlobal: false,
    inbound: { enabled: false, addresses: { screens: "", signage: "" } },
  };
}

function emailOf(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return "";
  return email;
}

function cleanList(values, max, length) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim().slice(0, length);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export function normaliseSettings(raw) {
  const base = defaultSettings();
  const staff = {};
  const types = {};
  for (const queue of QUEUES) {
    staff[queue] = cleanList(raw?.staff?.[queue], 40, 254).map(emailOf).filter(Boolean);
    const seeded = cleanList(raw?.types?.[queue], 30, 80);
    types[queue] = seeded.length ? seeded : [...DEFAULT_TYPES[queue]];
  }
  const requesters = [];
  for (const row of Array.isArray(raw?.requesters) ? raw.requesters : []) {
    const email = emailOf(row?.email);
    if (!email) continue;
    requesters.push({
      email,
      sites: cleanList(row?.sites, 40, 12).filter((id) => /^s[a-f0-9]{8}$/.test(id)),
      area: String(row?.area || "").trim().slice(0, 80),
    });
    if (requesters.length >= 200) break;
  }
  const domains = [];
  for (const row of Array.isArray(raw?.domains) ? raw.domains : []) {
    const domain = String(row?.domain || "").trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) continue;
    domains.push({
      domain,
      sites: cleanList(row?.sites, 40, 12).filter((id) => /^s[a-f0-9]{8}$/.test(id)),
      area: String(row?.area || "").trim().slice(0, 80),
    });
    if (domains.length >= 20) break;
  }
  const visibility = raw?.visibility === "own-only" ? "own-only" : "own-and-sites";
  return {
    staff, types, requesters, domains, visibility,
    notify: { screens: raw?.notify?.screens === true, signage: raw?.notify?.signage === true },
    notifyGlobal: raw?.notifyGlobal === true,
    inbound: {
      enabled: raw?.inbound?.enabled === true,
      addresses: {
        screens: emailOf(raw?.inbound?.addresses?.screens),
        signage: emailOf(raw?.inbound?.addresses?.signage),
      },
    },
  };
}

export async function readSettings() {
  const stored = await ticketStore().get("settings", { type: "json" });
  return normaliseSettings(stored || {});
}

export async function saveSettings(actor, body) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  const next = normaliseSettings(body);
  await ticketStore().setJSON("settings", next);
  await audit(access.email, "settings", "");
  return { status: 200, body: next };
}

export async function ticketAccess(actor, settings = null) {
  if (!actor || actor.kind !== "verified-identity" || actor.provider !== "otp") return { role: "none", email: "", queues: [] };
  const email = emailOf(actor.email);
  if (!email) return { role: "none", email: "", queues: [] };
  if (email === TICKET_ADMIN_EMAIL) return { role: "admin", email, queues: [...QUEUES] };
  const stored = settings || await readSettings();
  const queues = QUEUES.filter((queue) => stored.staff[queue].includes(email));
  if (!queues.length) return { role: "none", email, queues: [] };
  return { role: "staff", email, queues };
}

function melbourneDay(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export function isOverdue(ticket, at = now()) {
  if (!ticket?.neededBy || !OPEN.has(ticket.status)) return false;
  return ticket.neededBy < melbourneDay(at);
}

export function presentTicket(ticket, { staff = false } = {}) {
  const messages = (ticket.messages || []).filter((row) => staff || row.kind === "public");
  return {
    id: ticket.id,
    number: ticket.number,
    queue: ticket.queue,
    siteId: ticket.siteId,
    siteLabel: ticket.siteLabel,
    requestType: ticket.requestType,
    priority: ticket.priority,
    neededBy: ticket.neededBy || "",
    subject: ticket.subject,
    description: ticket.description,
    requesterEmail: ticket.requesterEmail,
    status: ticket.status,
    statusLabel: STATUS_LABEL[ticket.status] || ticket.status,
    assignee: ticket.assignee || "",
    overdue: isOverdue(ticket),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    messages: messages.map((row) => ({ id: row.id, at: row.at, actor: row.actor, kind: row.kind, text: row.text })),
    closeOut: staff ? (ticket.closeOut || null) : null,
    files: (ticket.files || []).map((file) => ({ id: file.id, name: file.name, contentType: file.contentType })),
    statusHistory: staff ? ticket.statusHistory || [] : (ticket.statusHistory || []).map((row) => ({ at: row.at, status: row.to })),
  };
}

async function audit(actorEmail, action, ticketId, detail = "") {
  const row = {
    id: "u" + crypto.randomBytes(8).toString("hex"),
    at: new Date(now()).toISOString(),
    action: String(action).slice(0, 40),
    actor: emailOf(actorEmail) || "system",
    ticketId: String(ticketId || ""),
    detail: String(detail || "").slice(0, 160),
  };
  await ticketStore().setJSON("audit/" + row.id, row);
  return row;
}

async function loadTicket(id) {
  if (!/^t[a-f0-9]{16}$/.test(id || "")) return null;
  return ticketStore().get("ticket/" + id, { type: "json" });
}

async function siteChoice(siteId, siteOther) {
  if (siteId === "other") {
    const label = String(siteOther || "").trim().slice(0, 80);
    if (!label) return { error: "Describe the other site." };
    return { siteId: "other", siteLabel: label, area: "" };
  }
  if (!/^s[a-f0-9]{8}$/.test(siteId || "")) return { error: "Choose a site." };
  const site = await sitesStore().get(siteId, { type: "json" });
  if (!isSiteRecord(site)) return { error: "Choose a site." };
  return { siteId: site.id, siteLabel: site.name, area: site.operationalRegion || "" };
}

export async function createTicket(actor, body) {
  const access = await ticketAccess(actor);
  if (access.role === "none") return { status: 403, error: "Ticket staff access is not granted." };
  const queue = QUEUES.includes(body?.queue) ? body.queue : "";
  if (!queue || (access.role === "staff" && !access.queues.includes(queue))) return { status: 400, error: "Choose a queue you can work." };
  const settings = await readSettings();
  const requestType = String(body?.requestType || "").trim();
  if (!settings.types[queue].includes(requestType)) return { status: 400, error: "Choose a request type." };
  const priority = PRIORITIES.includes(body?.priority) ? body.priority : "";
  if (!priority) return { status: 400, error: "Choose a priority." };
  const subject = String(body?.subject || "").trim().slice(0, 140);
  const description = String(body?.description || "").trim().slice(0, TEXT_MAX);
  if (!subject || !description) return { status: 400, error: "Subject and description are required." };
  const neededBy = String(body?.neededBy || "");
  if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return { status: 400, error: "Needed-by must be a date." };
  const requesterEmail = emailOf(body?.requesterEmail);
  if (!requesterEmail) return { status: 400, error: "Requester email is required." };
  const site = await siteChoice(body?.siteId, body?.siteOther);
  if (site.error) return { status: 400, error: site.error };
  const count = await conditionalIncrement(ticketStore(), "counter", 1000000);
  if (!count.ok) return { status: 503, error: "Tickets are temporarily unavailable." };
  const at = new Date(now()).toISOString();
  const ticket = {
    id: "t" + crypto.randomBytes(8).toString("hex"),
    number: 1000 + count.n,
    queue, ...site, requestType, priority, neededBy,
    subject, description, requesterEmail,
    status: "new",
    statusHistory: [{ at, from: "", to: "new", actor: access.email }],
    assignee: "",
    messages: [],
    closeOut: null,
    files: [],
    createdAt: at,
    updatedAt: at,
  };
  await ticketStore().setJSON("ticket/" + ticket.id, ticket);
  await audit(access.email, "create", ticket.id, queue);
  return { status: 200, body: { ticket: presentTicket(ticket, { staff: true }) } };
}

function canSee(access, ticket) {
  return access.role === "admin" || access.queues.includes(ticket.queue);
}

async function allTickets() {
  const { blobs } = await ticketStore().list({ prefix: "ticket/" });
  const rows = await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })));
  return rows.filter((row) => row && row.id);
}

export async function listTickets(actor, query) {
  const access = await ticketAccess(actor);
  if (access.role === "none") return { status: 403, error: "Ticket staff access is not granted." };
  const queue = String(query.get("queue") || "");
  const status = String(query.get("status") || "");
  const priority = String(query.get("priority") || "");
  const q = String(query.get("q") || "").trim().toLowerCase();
  const from = String(query.get("updatedFrom") || "");
  const to = String(query.get("updatedTo") || "");
  const rows = (await allTickets()).filter((ticket) => canSee(access, ticket));
  const filtered = rows.filter((ticket) => {
    if (queue && ticket.queue !== queue) return false;
    if (status && ticket.status !== status) return false;
    if (priority && ticket.priority !== priority) return false;
    const updated = melbourneDay(Date.parse(ticket.updatedAt));
    if (from && updated < from) return false;
    if (to && updated > to) return false;
    if (q && ![String(ticket.number), ticket.subject, ticket.siteLabel, ticket.requesterEmail].join(" ").toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { status: 200, body: { tickets: filtered.map((ticket) => presentTicket(ticket, { staff: true })) } };
}

export async function summary(actor, query) {
  const listed = await listTickets(actor, new URLSearchParams(query.get("queue") ? [["queue", query.get("queue")]] : []));
  if (listed.status !== 200) return listed;
  const at = now();
  const rows = listed.body.tickets;
  const closedWithin = (days) => rows.filter((ticket) => {
    if (ticket.status !== "done" && ticket.status !== "closed") return false;
    return Date.parse(ticket.updatedAt) >= at - days * 86400000;
  }).length;
  return {
    status: 200,
    body: {
      open: rows.filter((ticket) => OPEN.has(ticket.status)).length,
      awaiting: rows.filter((ticket) => ticket.status === "awaiting").length,
      closed30: closedWithin(30),
      closed60: closedWithin(60),
      closed90: closedWithin(90),
      overdue: rows.filter((ticket) => ticket.overdue).length,
    },
  };
}

export async function readTicket(actor, id) {
  const access = await ticketAccess(actor);
  if (access.role === "none") return { status: 403, error: "Ticket staff access is not granted." };
  const ticket = await loadTicket(id);
  if (!ticket || !canSee(access, ticket)) return { status: 404, error: "That ticket is not available." };
  return { status: 200, body: { ticket: presentTicket(ticket, { staff: true }) } };
}

async function mutate(actor, id, change) {
  const access = await ticketAccess(actor);
  if (access.role === "none") return { status: 403, error: "Ticket staff access is not granted." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await ticketStore().getWithMetadata("ticket/" + id, { type: "json", consistency: "strong" });
    if (!meta?.etag || !meta.data) return { status: 404, error: "That ticket is not available." };
    if (!canSee(access, meta.data)) return { status: 404, error: "That ticket is not available." };
    const result = await change(meta.data, access);
    if (result.error) return { status: 400, error: result.error };
    const next = { ...meta.data, ...result.patch, updatedAt: new Date(now()).toISOString() };
    const write = await ticketStore().setJSON("ticket/" + id, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) {
      await audit(access.email, result.action, id, result.detail || "");
      return { status: 200, body: { ticket: presentTicket(next, { staff: true }) } };
    }
    if (write?.modified !== false) return { status: 503, error: "Tickets are temporarily unavailable." };
  }
  return { status: 409, error: "That ticket changed. Try again." };
}

export function setStatus(actor, id, body) {
  const status = STATUSES.includes(body?.status) ? body.status : "";
  if (!status) return { status: 400, error: "Choose a status." };
  return mutate(actor, id, (ticket, access) => {
    if (ticket.status === status) return { error: "That status is already set." };
    return {
      action: "status",
      detail: status,
      patch: { status, statusHistory: [...(ticket.statusHistory || []), { at: new Date(now()).toISOString(), from: ticket.status, to: status, actor: access.email }] },
    };
  });
}

export function assignTicket(actor, id, body) {
  const assignee = body?.assignee ? emailOf(body.assignee) : "";
  if (body?.assignee && !assignee) return { status: 400, error: "Assignee email was not accepted." };
  return mutate(actor, id, async (ticket) => {
    if (assignee) {
      const settings = await readSettings();
      const allowed = assignee === TICKET_ADMIN_EMAIL || settings.staff[ticket.queue].includes(assignee);
      if (!allowed) return { error: "Assignee is not staff for this queue." };
    }
    return { action: "assign", detail: assignee, patch: { assignee } };
  });
}

function addMessage(kind) {
  return (actor, id, body) => {
    const text = String(body?.text || "").trim().slice(0, TEXT_MAX);
    if (!text) return { status: 400, error: "Write a note first." };
    return mutate(actor, id, (ticket, access) => ({
      action: kind,
      patch: { messages: [...(ticket.messages || []), { id: "m" + crypto.randomBytes(6).toString("hex"), at: new Date(now()).toISOString(), actor: access.email, kind, text }] },
    }));
  };
}
export const addInternalNote = addMessage("internal");
export const addPublicReply = addMessage("public");

export async function acceptTicketFile(input, name) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) return { error: "Choose a file." };
  if (buf.length > 8_000_000) return { error: "The file is too large." };
  const head = buf.subarray(0, 8).toString("utf8");
  if (head.startsWith("%PDF")) {
    if (buf.length > FILE_MAX) return { error: "The file is too large." };
    const sample = buf.subarray(0, Math.min(buf.length, 4000)).toString("latin1");
    if (/\/JavaScript|\/JS/.test(sample)) return { error: "That PDF was not accepted." };
    return { name: String(name || "file.pdf").slice(0, 80), contentType: "application/pdf", bytes: buf.toString("base64") };
  }
  const image = reencodeVisitorPhoto(buf);
  if (image.error) return { error: image.error };
  if (image.bytes.length > FILE_MAX) return { error: "The file is too large." };
  return { name: String(name || "image.jpg").replace(/\.[^.]+$/, "") .slice(0, 60) + ".jpg", contentType: image.contentType, bytes: image.bytes.toString("base64") };
}

export function addFile(actor, id, body) {
  let bytes;
  try { bytes = Buffer.from(String(body?.data || ""), "base64"); }
  catch { return { status: 400, error: "The file was not accepted." }; }
  return mutate(actor, id, async (ticket) => {
    if ((ticket.files || []).length >= 8) return { error: "This ticket already has 8 files." };
    const file = await acceptTicketFile(bytes, body?.name);
    if (file.error) return { error: file.error };
    const saved = { id: "f" + crypto.randomBytes(8).toString("hex"), name: file.name, contentType: file.contentType };
    await ticketStore().setJSON("file/" + saved.id, { ...saved, ticketId: ticket.id, bytes: file.bytes });
    return { action: "file", detail: saved.id, patch: { files: [...(ticket.files || []), saved] } };
  });
}

export async function readFile(actor, ticketId, fileId) {
  const access = await ticketAccess(actor);
  if (access.role === "none") return { status: 403, error: "Ticket staff access is not granted." };
  const ticket = await loadTicket(ticketId);
  if (!ticket || !canSee(access, ticket)) return { status: 404, error: "That file is not available." };
  if (!(ticket.files || []).some((file) => file.id === fileId)) return { status: 404, error: "That file is not available." };
  const stored = await ticketStore().get("file/" + fileId, { type: "json" });
  if (!stored || stored.ticketId !== ticketId) return { status: 404, error: "That file is not available." };
  return { status: 200, body: Buffer.from(stored.bytes, "base64"), contentType: stored.contentType, name: stored.name };
}

export function closeTicket(actor, id, body) {
  const notes = String(body?.notes || "").trim().slice(0, TEXT_MAX);
  if (!notes) return { status: 400, error: "Completion notes are required." };
  return mutate(actor, id, async (ticket, access) => {
    let photoId = "";
    if (body?.photo) {
      let bytes;
      try { bytes = Buffer.from(String(body.photo), "base64"); } catch { return { error: "The photo was not accepted." }; }
      const file = await acceptTicketFile(bytes, "close-out.jpg");
      if (file.error || file.contentType !== "image/jpeg") return { error: file.error || "Close-out uses a JPEG or PNG photo." };
      photoId = "f" + crypto.randomBytes(8).toString("hex");
      await ticketStore().setJSON("file/" + photoId, { id: photoId, ticketId: ticket.id, name: file.name, contentType: file.contentType, bytes: file.bytes });
    }
    const at = new Date(now()).toISOString();
    return {
      action: "close",
      patch: {
        status: "closed",
        closeOut: { notes, photoId, at, actor: access.email },
        files: photoId ? [...(ticket.files || []), { id: photoId, name: "close-out.jpg", contentType: "image/jpeg" }] : ticket.files,
        statusHistory: [...(ticket.statusHistory || []), { at, from: ticket.status, to: "closed", actor: access.email }],
      },
    };
  });
}

export async function listAudit(actor) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  const { blobs } = await ticketStore().list({ prefix: "audit/" });
  const rows = (await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })))).filter(Boolean);
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { status: 200, body: { audit: rows.slice(0, 200) } };
}

export function requesterScope(settings, email) {
  const address = emailOf(email);
  if (!address) return null;
  const exact = (settings.requesters || []).find((row) => row.email === address);
  if (exact) return { email: address, sites: exact.sites || [], area: exact.area || "" };
  const domain = address.split("@")[1];
  const mapped = (settings.domains || []).find((row) => row.domain === domain);
  if (!mapped) return null;
  return { email: address, sites: mapped.sites || [], area: mapped.area || "" };
}

function requesterCanSee(settings, scope, ticket) {
  if (ticket.requesterEmail === scope.email) return "own";
  if (settings.visibility === "own-only") return "";
  if (scope.sites.includes(ticket.siteId)) return "site";
  if (scope.area && ticket.area && ticket.area === scope.area) return "area";
  return "";
}

export async function createRequesterTicket(scope, body) {
  const settings = await readSettings();
  const queue = QUEUES.includes(body?.queue) ? body.queue : "";
  if (!queue) return { status: 400, error: "Choose a queue." };
  const requestType = String(body?.requestType || "").trim();
  if (!settings.types[queue].includes(requestType)) return { status: 400, error: "Choose a request type." };
  const priority = PRIORITIES.includes(body?.priority) ? body.priority : "normal";
  const subject = String(body?.subject || "").trim().slice(0, 140);
  const description = String(body?.description || "").trim().slice(0, TEXT_MAX);
  if (!subject || !description) return { status: 400, error: "Subject and description are required." };
  const neededBy = String(body?.neededBy || "");
  if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return { status: 400, error: "Needed-by must be a date." };
  const site = await siteChoice(body?.siteId, body?.siteOther);
  if (site.error) return { status: 400, error: site.error };
  if (site.siteId !== "other" && !scope.sites.includes(site.siteId) && !(scope.area && site.area === scope.area)) {
    return { status: 400, error: "Choose one of your sites." };
  }
  const count = await conditionalIncrement(ticketStore(), "counter", 1000000);
  if (!count.ok) return { status: 503, error: "Tickets are temporarily unavailable." };
  const at = new Date(now()).toISOString();
  const ticket = {
    id: "t" + crypto.randomBytes(8).toString("hex"),
    number: 1000 + count.n,
    queue, ...site, requestType, priority, neededBy,
    subject, description, requesterEmail: scope.email,
    status: "new",
    statusHistory: [{ at, from: "", to: "new", actor: scope.email }],
    assignee: "",
    messages: [],
    closeOut: null,
    files: [],
    createdAt: at,
    updatedAt: at,
  };
  await ticketStore().setJSON("ticket/" + ticket.id, ticket);
  await audit(scope.email, "request", ticket.id, queue);
  return { status: 200, body: { ticket: { ...presentTicket(ticket, { staff: false }), access: "own" } } };
}

export async function listRequesterTickets(scope) {
  const settings = await readSettings();
  const rows = await allTickets();
  const visible = rows.filter((ticket) => requesterCanSee(settings, scope, ticket)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    status: 200,
    body: {
      tickets: visible.map((ticket) => ({ ...presentTicket(ticket, { staff: false }), access: requesterCanSee(settings, scope, ticket) === "own" ? "own" : "read" })),
    },
  };
}

async function requesterTicket(scope, id) {
  const settings = await readSettings();
  const ticket = await loadTicket(id);
  if (!ticket) return null;
  const access = requesterCanSee(settings, scope, ticket);
  if (!access) return null;
  return { ticket, access };
}

export async function readRequesterTicket(scope, id) {
  const found = await requesterTicket(scope, id);
  if (!found) return { status: 404, error: "That ticket is not available." };
  return { status: 200, body: { ticket: { ...presentTicket(found.ticket, { staff: false }), access: found.access === "own" ? "own" : "read" } } };
}

export async function commentRequesterTicket(scope, id, body) {
  const text = String(body?.text || "").trim().slice(0, TEXT_MAX);
  if (!text) return { status: 400, error: "Write a comment first." };
  const found = await requesterTicket(scope, id);
  if (!found) return { status: 404, error: "That ticket is not available." };
  if (found.access !== "own") return { status: 403, error: "This ticket is read only." };
  const at = new Date(now()).toISOString();
  const next = {
    ...found.ticket,
    updatedAt: at,
    messages: [...(found.ticket.messages || []), { id: "m" + crypto.randomBytes(6).toString("hex"), at, actor: scope.email, kind: "public", text }],
  };
  await ticketStore().setJSON("ticket/" + id, next);
  await audit(scope.email, "comment", id);
  return { status: 200, body: { ticket: { ...presentTicket(next, { staff: false }), access: "own" } } };
}

export async function addRequesterFile(scope, id, body) {
  const found = await requesterTicket(scope, id);
  if (!found) return { status: 404, error: "That ticket is not available." };
  if (found.access !== "own") return { status: 403, error: "This ticket is read only." };
  if ((found.ticket.files || []).length >= 8) return { status: 400, error: "This ticket already has 8 files." };
  let bytes;
  try { bytes = Buffer.from(String(body?.data || ""), "base64"); } catch { return { status: 400, error: "The file was not accepted." }; }
  const file = await acceptTicketFile(bytes, body?.name);
  if (file.error) return { status: 400, error: file.error };
  const saved = { id: "f" + crypto.randomBytes(8).toString("hex"), name: file.name, contentType: file.contentType };
  await ticketStore().setJSON("file/" + saved.id, { ...saved, ticketId: id, bytes: file.bytes });
  const next = { ...found.ticket, files: [...(found.ticket.files || []), saved], updatedAt: new Date(now()).toISOString() };
  await ticketStore().setJSON("ticket/" + id, next);
  await audit(scope.email, "file", id, saved.id);
  return { status: 200, body: { ticket: { ...presentTicket(next, { staff: false }), access: "own" } } };
}

export async function readRequesterFile(scope, ticketId, fileId) {
  const found = await requesterTicket(scope, ticketId);
  if (!found || !(found.ticket.files || []).some((file) => file.id === fileId)) return { status: 404, error: "That file is not available." };
  const stored = await ticketStore().get("file/" + fileId, { type: "json" });
  if (!stored || stored.ticketId !== ticketId) return { status: 404, error: "That file is not available." };
  return { status: 200, body: Buffer.from(stored.bytes, "base64"), contentType: stored.contentType, name: stored.name };
}

export async function listSiteChoices() {
  const { blobs } = await sitesStore().list();
  const sites = (await Promise.all(blobs.map((blob) => sitesStore().get(blob.key, { type: "json" })))).filter(isSiteRecord);
  return sites.map((site) => ({ id: site.id, name: site.name, area: site.operationalRegion || "" })).sort((a, b) => a.name.localeCompare(b.name));
}
