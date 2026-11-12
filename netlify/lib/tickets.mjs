import crypto from "node:crypto";
import { conditionalIncrement, sitesStore, ticketStore } from "./lib.mjs";
import { reencodeVisitorPhoto } from "./visitor-image.mjs";
import { isSiteRecord } from "./site-import.mjs";
import { newTicketTracking, writeTrackIndex } from "./ticket-track.mjs";

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
  signage: ["New sign or install", "Replacement", "Damage or repair", "Promotional install", "Print or reprint", "Other"],
};
/** Request types added after settings were first saved. Settings older than this version get them appended once. */
export const TYPES_VERSION = 2;
const ADDED_TYPES = { 2: { signage: ["Print or reprint"] } };
/** Ticket-only site option. Not a site record: it never appears in the sites store, mappings, visitor log or POS. */
export const NATIONAL_SITE_ID = "national";
export const NATIONAL_SITE_LABEL = "All sites / National";
const EXTENSION_OF = { "image/png": ".png", "image/jpeg": ".jpg", "application/pdf": ".pdf" };
const CLOSE_OUT_TYPES = new Set(["image/jpeg", "image/png"]);
/** The close-out photo is staff-only. Matches by closeOut.photoId, or the stored close-out name (legacy .jpg and .png). */
export function isCloseOutFile(ticket, file) {
  if (!file) return false;
  if (ticket?.closeOut?.photoId && file.id === ticket.closeOut.photoId) return true;
  return file.name === "close-out.jpg" || file.name === "close-out.png";
}
/** Filename whose extension matches the stored content type. */
export function fileNameFor(name, contentType, fallback = "file") {
  const ext = EXTENSION_OF[contentType] || "";
  const base = String(name || "").replace(/[\\/]+/g, " ").trim().replace(/\.[^.]*$/, "").slice(0, 60) || fallback;
  return base + ext;
}
export const BOARD_COLUMNS = [
  { id: "submitted", label: "Submitted", status: "new" },
  { id: "needs-info", label: "Needs more info", status: "awaiting" },
  { id: "in-progress", label: "In progress", status: "in-progress" },
  { id: "done", label: "Done", status: "done" },
];
const COLUMN_OF_STATUS = { new: "submitted", awaiting: "needs-info", "in-progress": "in-progress", scheduled: "in-progress", done: "done", closed: "done" };
/** Board column for a stored status. Old statuses (Scheduled, Closed) stay readable and map to a column. */
export function columnFor(status) {
  return COLUMN_OF_STATUS[status] || "submitted";
}
export function columnLabel(id) {
  return BOARD_COLUMNS.find((row) => row.id === id)?.label || id;
}
/** When the ticket last entered Done/Closed, falling back to updatedAt. */
export function doneAt(ticket) {
  const rows = Array.isArray(ticket?.statusHistory) ? ticket.statusHistory : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (columnFor(rows[i]?.to) === "done" && rows[i]?.at) return rows[i].at;
  }
  return ticket?.updatedAt || ticket?.createdAt || "";
}
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
    staff: { screens: [TICKET_ADMIN_EMAIL], signage: [TICKET_ADMIN_EMAIL] },
    types: { screens: [...DEFAULT_TYPES.screens], signage: [...DEFAULT_TYPES.signage] },
    typesVersion: TYPES_VERSION,
    requesters: [],
    domains: [{ domain: "libertyretail.com.au", sites: [], area: "" }],
    visibility: "own-and-sites",
    notify: { screens: false, signage: false },
    notifyGlobal: false,
    inbound: { enabled: false, addresses: { screens: "", signage: "" } },
  };
}

/** Exact host match only. Subdomains and lookalikes are rejected. */
export function domainAllowed(email, domains) {
  const host = emailOf(email).split("@")[1] || "";
  if (!host) return false;
  const allowed = new Set((Array.isArray(domains) ? domains : []).map((row) => {
    const domain = String(typeof row === "string" ? row : row?.domain || "").trim().toLowerCase().replace(/^@/, "");
    return domain;
  }).filter(Boolean));
  return allowed.has(host);
}

export function requesterAllowed(email, settings) {
  const value = emailOf(email);
  if (!value) return false;
  if ((settings?.requesters || []).some((row) => row.email === value)) return true;
  return domainAllowed(value, settings?.domains);
}

export function emailOf(value) {
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
    staff[queue] = Array.isArray(raw?.staff?.[queue])
      ? cleanList(raw.staff[queue], 40, 254).map(emailOf).filter(Boolean)
      : [...base.staff[queue]];
    const seeded = Array.isArray(raw?.types?.[queue]) ? cleanList(raw.types[queue], 30, 80) : [];
    types[queue] = seeded.length ? seeded : [...DEFAULT_TYPES[queue]];
    if (seeded.length) {
      const from = Number.isInteger(raw?.typesVersion) ? raw.typesVersion : 1;
      for (let version = from + 1; version <= TYPES_VERSION; version++) {
        for (const added of ADDED_TYPES[version]?.[queue] || []) {
          if (types[queue].includes(added)) continue;
          const other = types[queue].indexOf("Other");
          if (other >= 0) types[queue].splice(other, 0, added); else types[queue].push(added);
        }
      }
    }
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
  if (!Array.isArray(raw?.domains)) {
    domains.push(...base.domains);
  } else {
    for (const row of raw.domains) {
      const domain = String(row?.domain || "").trim().toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) continue;
      domains.push({
        domain,
        sites: cleanList(row?.sites, 40, 12).filter((id) => /^s[a-f0-9]{8}$/.test(id)),
        area: String(row?.area || "").trim().slice(0, 80),
      });
      if (domains.length >= 20) break;
    }
  }
  const visibility = raw?.visibility === "own-only" ? "own-only" : "own-and-sites";
  return {
    staff, types, typesVersion: TYPES_VERSION, requesters, domains, visibility,
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

/** Users tab: set which ticket queues (areas) one email is staff on. Other settings are untouched. */
export async function setTicketStaffQueues(email, queues) {
  const address = emailOf(email);
  if (!address) return null;
  const want = new Set((Array.isArray(queues) ? queues : []).filter((queue) => QUEUES.includes(queue)));
  const current = normaliseSettings((await ticketStore().get("settings", { type: "json" })) || {});
  let changed = false;
  for (const queue of QUEUES) {
    const has = current.staff[queue].includes(address);
    if (want.has(queue) && !has) { current.staff[queue].push(address); changed = true; }
    if (!want.has(queue) && has && address !== TICKET_ADMIN_EMAIL) { current.staff[queue] = current.staff[queue].filter((row) => row !== address); changed = true; }
  }
  if (changed) await ticketStore().setJSON("settings", current);
  return current.staff;
}

export async function readSettings() {
  const stored = await ticketStore().get("settings", { type: "json" });
  return normaliseSettings(stored || {});
}

export async function saveSettings(actor, body) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  // The admin's saved list is authoritative: do not re-add types they removed.
  const next = normaliseSettings({ ...(body || {}), typesVersion: TYPES_VERSION });
  await ticketStore().setJSON("settings", next);
  await audit(access.email, "settings", "");
  return { status: 200, body: next };
}

export async function ticketAccess(actor, settings = null) {
  // Email-code users only. Queue membership (the ticket staff lists, edited in Users or Support settings) decides access.
  if (!actor || actor.kind !== "verified-identity" || actor.provider !== "otp") return { role: "none", email: "", queues: [] };
  if (actor.role === "building-maintenance" && actor.ticketsEnabled !== true) return { role: "none", email: "", queues: [] };
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
    siteLabel: ticket.siteId === NATIONAL_SITE_ID ? NATIONAL_SITE_LABEL : ticket.siteLabel,
    siteNational: ticket.siteId === NATIONAL_SITE_ID,
    requestType: ticket.requestType,
    priority: ticket.priority,
    neededBy: ticket.neededBy || "",
    subject: ticket.subject,
    description: ticket.description,
    requesterEmail: ticket.requesterEmail,
    requesterName: staff ? ticket.requesterName || "" : "",
    requesterPhone: staff ? ticket.requesterPhone || "" : "",
    siteFreeText: ticket.siteId === "other",
    source: staff ? ticket.source || "" : "",
    status: ticket.status,
    statusLabel: STATUS_LABEL[ticket.status] || ticket.status,
    column: columnFor(ticket.status),
    columnLabel: columnLabel(columnFor(ticket.status)),
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

export async function auditRow(actorEmail, action, ticketId, detail = "") {
  return audit(actorEmail, action, ticketId, detail);
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

export function siteChoiceFor(siteId, siteOther) {
  return siteChoice(siteId, siteOther);
}

async function siteChoice(siteId, siteOther) {
  if (siteId === NATIONAL_SITE_ID) return { siteId: NATIONAL_SITE_ID, siteLabel: NATIONAL_SITE_LABEL, area: "" };
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
  const newId = "t" + crypto.randomBytes(8).toString("hex");
  const ticket = {
    id: newId,
    number: 1000 + count.n,
    queue, ...site, requestType, priority, neededBy,
    subject, description, requesterEmail,
    ...newTicketTracking(newId),
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
  await writeTrackIndex(ticket.number, ticket.id);
  await audit(access.email, "create", ticket.id, queue);
  return { status: 200, body: { ticket: presentTicket(ticket, { staff: true }) } };
}

function canSee(access, ticket) {
  return access.role === "admin" || access.queues.includes(ticket.queue);
}

export function allTicketRows() {
  return allTickets();
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
  const site = String(query.get("site") || "");
  const type = String(query.get("type") || "");
  const column = String(query.get("column") || "");
  const from = String(query.get("updatedFrom") || "");
  const to = String(query.get("updatedTo") || "");
  const rows = (await allTickets()).filter((ticket) => canSee(access, ticket));
  const filtered = rows.filter((ticket) => {
    if (queue && queue !== "all" && ticket.queue !== queue) return false;
    if (site && ticket.siteId !== site) return false;
    if (type && ticket.requestType !== type) return false;
    if (column && columnFor(ticket.status) !== column) return false;
    if (status && ticket.status !== status) return false;
    if (priority && ticket.priority !== priority) return false;
    const updated = melbourneDay(Date.parse(ticket.updatedAt));
    if (from && updated < from) return false;
    if (to && updated > to) return false;
    if (q && ![String(ticket.number), ticket.subject, ticket.siteLabel, ticket.requesterEmail, ticket.requesterName || "", ticket.requesterPhone || ""].join(" ").toLowerCase().includes(q)) return false;
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
      if (typeof result.after === "function") await result.after();
      const rows = Array.isArray(result.audits) ? result.audits : [{ action: result.action, detail: result.detail }];
      for (const row of rows) await audit(access.email, row.action, id, row.detail || "");
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

export function moveTicket(actor, id, body) {
  const target = BOARD_COLUMNS.find((row) => row.id === body?.column);
  if (!target) return { status: 400, error: "Choose a column." };
  const reply = String(body?.reply || "").trim().slice(0, TEXT_MAX);
  if (target.id === "needs-info" && !reply) return { status: 400, error: "Write a public reply saying what information is needed." };
  return mutate(actor, id, (ticket, access) => {
    const fromColumn = columnFor(ticket.status);
    if (fromColumn === target.id) return { error: "The ticket is already in " + target.label + "." };
    const at = new Date(now()).toISOString();
    const messages = reply
      ? [...(ticket.messages || []), { id: "m" + crypto.randomBytes(6).toString("hex"), at, actor: access.email, kind: "public", text: reply }]
      : ticket.messages || [];
    return {
      action: "move",
      detail: fromColumn + " -> " + target.id + " (" + ticket.status + " -> " + target.status + ")",
      patch: {
        status: target.status,
        messages,
        statusHistory: [...(ticket.statusHistory || []), { at, from: ticket.status, to: target.status, fromColumn, toColumn: target.id, actor: access.email, via: "board" }],
      },
    };
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
    return { name: fileNameFor(name, "application/pdf"), contentType: "application/pdf", bytes: buf.toString("base64") };
  }
  const image = reencodeVisitorPhoto(buf);
  if (image.error) return { error: image.error };
  if (image.bytes.length > FILE_MAX) return { error: "The file is too large." };
  return { name: fileNameFor(name, image.contentType, "image"), contentType: image.contentType, bytes: image.bytes.toString("base64") };
}

const EDIT_NOTE_MAX = 80;
/**
 * Staff edit of site and request type. One audit row per changed field ("edit-site", "edit-type"),
 * detail "old -> new", plus the optional note. No notifications.
 */
export function editTicket(actor, id, body) {
  const note = String(body?.note || "").replace(/\s+/g, " ").trim().slice(0, EDIT_NOTE_MAX);
  const wantsSite = body?.siteId !== undefined && body?.siteId !== null && body?.siteId !== "";
  const wantsType = body?.requestType !== undefined && body?.requestType !== null && body?.requestType !== "";
  if (!wantsSite && !wantsType) return { status: 400, error: "Choose a site or request type to change." };
  return mutate(actor, id, async (ticket, access) => {
    const patch = {};
    const audits = [];
    const edits = [];
    const at = new Date(now()).toISOString();
    const suffix = note ? " · " + note : "";
    const fromSite = ticket.siteId === NATIONAL_SITE_ID ? NATIONAL_SITE_LABEL : ticket.siteLabel;
    if (wantsSite) {
      const site = await siteChoice(body.siteId, body.siteOther);
      if (site.error) return { error: site.error };
      if (site.siteId !== ticket.siteId || site.siteLabel !== ticket.siteLabel) {
        Object.assign(patch, site, { siteFreeText: site.siteId === "other" });
        audits.push({ action: "edit-site", detail: (String(fromSite).slice(0, 36) + " -> " + String(site.siteLabel).slice(0, 36)) + suffix });
        edits.push({ at, actor: access.email, field: "site", from: fromSite, to: site.siteLabel, note });
      }
    }
    if (wantsType) {
      const requestType = String(body.requestType).trim();
      if (requestType !== ticket.requestType) {
        const settings = await readSettings();
        if (!(settings.types[ticket.queue] || []).includes(requestType)) return { error: "Choose a request type." };
        patch.requestType = requestType;
        audits.push({ action: "edit-type", detail: (String(ticket.requestType).slice(0, 36) + " -> " + requestType.slice(0, 36)) + suffix });
        edits.push({ at, actor: access.email, field: "requestType", from: ticket.requestType, to: requestType, note });
      }
    }
    if (!audits.length) return { error: "Nothing changed." };
    patch.editHistory = [...(ticket.editHistory || []), ...edits];
    return { audits, patch };
  });
}

/**
 * Admin maintenance: make attachment names match their stored content type. Metadata only
 * (ticket file list and the file record's name); bytes are untouched. One "file-rename" audit row per file.
 */
export async function correctFileNames(actor, id) {
  const access = await ticketAccess(actor);
  if (access.role !== "admin") return { status: 403, error: "Ticket settings are limited to the ticket admin." };
  const renamed = [];
  const result = await mutate(actor, id, async (ticket) => {
    renamed.length = 0;
    const files = (ticket.files || []).map((file) => {
      if (!EXTENSION_OF[file.contentType] || isCloseOutFile(ticket, file)) return file;
      const name = fileNameFor(file.name, file.contentType);
      if (name === file.name) return file;
      renamed.push({ id: file.id, from: file.name, to: name });
      return { ...file, name };
    });
    if (!renamed.length) return { error: "All attachment names already match." };
    return {
      patch: { files },
      audits: renamed.map((row) => ({ action: "file-rename", detail: row.id + " " + row.from.slice(0, 60) + " -> " + row.to.slice(0, 60) })),
      after: async () => {
        for (const row of renamed) {
          const meta = await ticketStore().getWithMetadata("file/" + row.id, { type: "json", consistency: "strong" });
          if (!meta?.data || meta.data.ticketId !== id) continue;
          await ticketStore().setJSON("file/" + row.id, { ...meta.data, name: row.to }, { onlyIfMatch: meta.etag });
        }
      },
    };
  });
  if (result.status !== 200) return result;
  return { status: 200, body: { ticket: result.body.ticket, renamed: [...renamed] } };
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
    let photo = null;
    if (body?.photo) {
      let bytes;
      try { bytes = Buffer.from(String(body.photo), "base64"); } catch { return { error: "The photo was not accepted." }; }
      // Same checks as any upload: magic-byte sniff, dimension and size limits, re-encode (metadata stripped).
      const file = await acceptTicketFile(bytes, "close-out");
      if (file.error) return { error: file.error };
      if (!CLOSE_OUT_TYPES.has(file.contentType)) return { error: "Close-out uses a JPEG or PNG photo." };
      photoId = "f" + crypto.randomBytes(8).toString("hex");
      photo = { id: photoId, name: fileNameFor("close-out", file.contentType), contentType: file.contentType };
      await ticketStore().setJSON("file/" + photoId, { ...photo, ticketId: ticket.id, bytes: file.bytes });
    }
    const at = new Date(now()).toISOString();
    return {
      action: "close",
      patch: {
        status: "closed",
        closeOut: { notes, photoId, at, actor: access.email },
        files: photo ? [...(ticket.files || []), photo] : ticket.files,
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
  if (!domainAllowed(address, settings.domains)) return null;
  const host = address.split("@")[1];
  const mapped = (settings.domains || []).find((row) => row.domain === host);
  return { email: address, sites: mapped?.sites || [], area: mapped?.area || "" };
}

/** Ticket site option for forms and filters; never stored in the sites store. */
export function nationalSiteChoice() {
  return { id: NATIONAL_SITE_ID, name: NATIONAL_SITE_LABEL, area: "", national: true };
}

export async function listSiteChoices() {
  const { blobs } = await sitesStore().list();
  const sites = (await Promise.all(blobs.map((blob) => sitesStore().get(blob.key, { type: "json" })))).filter(isSiteRecord);
  return sites.map((site) => ({ id: site.id, name: site.name, area: site.operationalRegion || "" })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function ingestEmailReply(ticketId, actorEmail, text, files = []) {
  const address = emailOf(actorEmail);
  const body = String(text || "").trim().slice(0, TEXT_MAX);
  if (!address) return { status: 400, error: "The sender was not accepted." };
  if (!body && !(files || []).length) return { status: 400, error: "Write a comment first." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await ticketStore().getWithMetadata("ticket/" + ticketId, { type: "json", consistency: "strong" });
    if (!meta?.etag || !meta.data) return { status: 404, error: "That ticket is not available." };
    const at = new Date(now()).toISOString();
    const messages = [...(meta.data.messages || [])];
    if (body) {
      messages.push({ id: "m" + crypto.randomBytes(6).toString("hex"), at, actor: address, kind: "public", text: body });
    }
    const nextFiles = [...(meta.data.files || [])];
    for (const file of files || []) {
      if (nextFiles.length >= 8) break;
      const saved = { id: "f" + crypto.randomBytes(8).toString("hex"), name: file.name, contentType: file.contentType };
      await ticketStore().setJSON("file/" + saved.id, { ...saved, ticketId, bytes: file.bytes });
      nextFiles.push(saved);
    }
    const next = { ...meta.data, messages, files: nextFiles, updatedAt: at };
    const write = await ticketStore().setJSON("ticket/" + ticketId, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) {
      await audit(address, "email-reply", ticketId);
      return { status: 200, body: { ticket: presentTicket(next, { staff: true }) } };
    }
    if (write?.modified !== false) return { status: 503, error: "Tickets are temporarily unavailable." };
  }
  return { status: 409, error: "That ticket changed. Try again." };
}

export async function ingestEmailTicket({ queue, requesterEmail, subject, description, siteId, siteOther, files = [] }) {
  const settings = await readSettings();
  const chosen = QUEUES.includes(queue) ? queue : "";
  if (!chosen) return { status: 400, error: "Choose a queue." };
  const address = emailOf(requesterEmail);
  if (!address) return { status: 400, error: "Requester email is required." };
  const title = String(subject || "").trim().slice(0, 140) || "Email request";
  const details = String(description || "").trim().slice(0, TEXT_MAX) || "(empty message)";
  const fallbackType = (settings.types[chosen] || []).includes("Other") ? "Other" : (settings.types[chosen] || [])[0];
  if (!fallbackType) return { status: 400, error: "Choose a request type." };
  const site = await siteChoice(siteId || "other", siteOther || "Email");
  if (site.error) return { status: 400, error: site.error };
  const count = await conditionalIncrement(ticketStore(), "counter", 1000000);
  if (!count.ok) return { status: 503, error: "Tickets are temporarily unavailable." };
  const at = new Date(now()).toISOString();
  const emailId = "t" + crypto.randomBytes(8).toString("hex");
  const ticket = {
    id: emailId,
    ...newTicketTracking(emailId),
    number: 1000 + count.n,
    queue: chosen, ...site, requestType: fallbackType, priority: "normal", neededBy: "",
    subject: title, description: details, requesterEmail: address,
    status: "new",
    statusHistory: [{ at, from: "", to: "new", actor: address }],
    assignee: "",
    messages: [],
    closeOut: null,
    files: [],
    createdAt: at,
    updatedAt: at,
  };
  const savedFiles = [];
  for (const file of files || []) {
    if (savedFiles.length >= 8) break;
    const saved = { id: "f" + crypto.randomBytes(8).toString("hex"), name: file.name, contentType: file.contentType };
    await ticketStore().setJSON("file/" + saved.id, { ...saved, ticketId: ticket.id, bytes: file.bytes });
    savedFiles.push(saved);
  }
  ticket.files = savedFiles;
  await ticketStore().setJSON("ticket/" + ticket.id, ticket);
  await writeTrackIndex(ticket.number, ticket.id);
  await audit(address, "email-create", ticket.id, chosen);
  return { status: 200, body: { ticket: presentTicket(ticket, { staff: true }) } };
}

export async function findTicketByNumber(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) return null;
  const { blobs } = await ticketStore().list({ prefix: "ticket/" });
  const rows = await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })));
  return rows.find((row) => row && row.number === n) || null;
}

