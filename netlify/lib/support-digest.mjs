/**
 * Daily Support digest: one email per recipient listing open jobs for the chosen queues, most overdue first.
 * At most one digest per Melbourne date: the scheduled run claims "digest/sent/<date>" with a conditional
 * (only-if-new) write before anything is sent, so overlapping or repeated runs cannot send twice.
 */
import crypto from "node:crypto";
import { env, ticketStore } from "./lib.mjs";
import { deliver } from "./mail.mjs";
import { footerHtml, footerText } from "./footer.mjs";
import { emailLogoHtml } from "./brand.mjs";
import { notifyRecipientOk, NOTIFY_DOMAIN, NOTIFY_RECIPIENTS_MAX } from "./visitor-log.mjs";
import { allTicketRows, columnFor, columnLabel, isOpenStatus, NATIONAL_SITE_ID, NATIONAL_SITE_LABEL, QUEUES, STATUS_LABEL, TICKET_ADMIN_EMAIL } from "./tickets.mjs";

export const DIGEST_SETTINGS_KEY = "digest/settings";
export const DIGEST_TZ = "Australia/Melbourne";
/** A missed morning run is not sent later in the day: the digest goes out only within this window after the set time. */
export const DIGEST_WINDOW_MINUTES = 180;
export const QUEUE_LABEL = { screens: "Screens", signage: "Signage" };
const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const TEST_COOLDOWN_MS = 10 * 60 * 1000;

let clock = () => Date.now();
export function setDigestTestHooks({ now = null } = {}) { clock = typeof now === "function" ? now : () => Date.now(); }

function publicUrl() { return (env("PUBLIC_URL") || "https://expresshelp.site").replace(/\/+$/, ""); }

export function defaultDigestSettings() {
  return { enabled: true, time: "07:00", recipients: [TICKET_ADMIN_EMAIL], queues: ["signage"], emptyDay: "skip" };
}

export function cleanDigestSettings(raw) {
  const base = defaultDigestSettings();
  if (!raw || typeof raw !== "object") return base;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time || "")) ? String(raw.time) : base.time;
  const recipients = [];
  for (const value of Array.isArray(raw.recipients) ? raw.recipients : []) {
    const email = notifyRecipientOk(value);
    if (email && !recipients.includes(email) && recipients.length < NOTIFY_RECIPIENTS_MAX) recipients.push(email);
  }
  const queues = QUEUES.filter((q) => Array.isArray(raw.queues) && raw.queues.includes(q));
  return {
    enabled: raw.enabled === true,
    time,
    recipients: recipients.length ? recipients : base.recipients,
    queues: queues.length ? queues : base.queues,
    emptyDay: raw.emptyDay === "note" ? "note" : "skip",
  };
}

export async function readDigestSettings() {
  const stored = await ticketStore().get(DIGEST_SETTINGS_KEY, { type: "json" }).catch(() => null);
  return stored ? cleanDigestSettings(stored) : defaultDigestSettings();
}

/** Validates like the Visitor Log recipients: exact @libertyretail.com.au, de-duplicated, up to 10, at least one. */
export function validateDigestBody(body) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body?.time || ""))) return { error: "Choose a time like 07:00." };
  const raw = Array.isArray(body?.recipients) ? body.recipients : String(body?.recipients || "").split(/[\s,;]+/);
  const asked = raw.map((v) => String(v || "").trim()).filter(Boolean);
  if (!asked.length) return { error: "Add at least one recipient." };
  const bad = asked.filter((v) => !notifyRecipientOk(v));
  if (bad.length) return { error: "Recipients must be exact @" + NOTIFY_DOMAIN + " addresses." };
  const recipients = [...new Set(asked.map((v) => notifyRecipientOk(v)))];
  if (recipients.length > NOTIFY_RECIPIENTS_MAX) return { error: "Up to " + NOTIFY_RECIPIENTS_MAX + " recipients." };
  const queues = QUEUES.filter((q) => Array.isArray(body?.queues) && body.queues.includes(q));
  if (!queues.length) return { error: "Choose at least one queue." };
  return { value: { enabled: body?.enabled === true, time: body.time, recipients, queues, emptyDay: body?.emptyDay === "note" ? "note" : "skip" } };
}

export async function saveDigestSettings(actorEmail, body) {
  const checked = validateDigestBody(body);
  if (checked.error) return { status: 400, error: checked.error };
  const next = { ...checked.value, updatedAt: new Date(clock()).toISOString(), updatedBy: actorEmail };
  await ticketStore().setJSON(DIGEST_SETTINGS_KEY, next);
  return { status: 200, body: cleanDigestSettings(next) };
}

/* ---------- Melbourne dates (DST-correct) ---------- */

export function melbourneParts(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: DIGEST_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  return { date: get("year") + "-" + get("month") + "-" + get("day"), minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

function dayNumber(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function dueInfo(neededBy, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(neededBy || ""))) return { kind: "none", days: null, text: "No due date" };
  const diff = dayNumber(neededBy) - dayNumber(today);
  if (diff < 0) return { kind: "overdue", days: -diff, text: -diff + (diff === -1 ? " day overdue" : " days overdue") };
  if (diff === 0) return { kind: "today", days: 0, text: "Due today" };
  return { kind: "due", days: diff, text: "Due in " + diff + (diff === 1 ? " day" : " days") };
}

function prettyDate(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function ageDays(iso, at) {
  const ms = at - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  return days + (days === 1 ? " day ago" : " days ago");
}

/** Most overdue first, then due soonest (today first), then no due date; oldest first within a group. */
export function sortJobs(jobs) {
  const rank = (j) => (j.due.kind === "overdue" ? [0, -j.due.days] : j.due.kind === "none" ? [2, 0] : [1, j.due.days]);
  return [...jobs].sort((a, b) => {
    const x = rank(a); const y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

export async function collectJobs(queues, at = clock()) {
  const today = melbourneParts(at).date;
  const rows = (await allTicketRows()).filter((t) => queues.includes(t.queue) && isOpenStatus(t.status));
  return sortJobs(rows.map((t) => ({
    id: t.id,
    number: t.number,
    subject: String(t.subject || ""),
    queue: t.queue,
    siteLabel: t.siteId === NATIONAL_SITE_ID ? NATIONAL_SITE_LABEL : String(t.siteLabel || ""),
    siteFreeText: t.siteId === "other",
    requestType: String(t.requestType || ""),
    priority: t.priority,
    status: columnLabel(columnFor(t.status)),
    statusDetail: STATUS_LABEL[t.status] || t.status,
    submitter: String(t.requesterName || t.requesterEmail || ""),
    assignee: String(t.assignee || ""),
    neededBy: t.neededBy || "",
    createdAt: t.createdAt,
    age: ageDays(t.createdAt, at),
    due: dueInfo(t.neededBy, today),
    link: publicUrl() + "/admin/#/tickets/" + t.id,
  })));
}

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

export function buildDigest({ jobs, queues, date, test = false }) {
  const label = queues.map((q) => QUEUE_LABEL[q] || q).join(" + ");
  const overdue = jobs.filter((j) => j.due.kind === "overdue").length;
  const supportUrl = publicUrl() + "/admin/#/tickets";
  const prefix = test ? "[TEST] " : "";
  const subject = prefix + (jobs.length
    ? `Support digest: ${jobs.length} open ${label} job${jobs.length === 1 ? "" : "s"}${overdue ? ` (${overdue} overdue)` : ""} · ${prettyDate(date)}`
    : `Support digest: nothing open in ${label} · ${prettyDate(date)}`);
  const footerLine = footerText();
  const lines = [];
  if (test) lines.push("This is a test digest. The daily schedule is not affected.", "");
  lines.push(jobs.length ? `${jobs.length} open ${label} job${jobs.length === 1 ? "" : "s"}, most overdue first.` : `No open ${label} jobs today.`, "");
  for (const j of jobs) {
    lines.push(`T-${j.number} · ${j.subject}`);
    lines.push(`  ${j.due.text}${j.neededBy ? ` (needed by ${prettyDate(j.neededBy)})` : ""}`);
    lines.push(`  ${j.siteLabel}${j.siteFreeText ? " (free-text site)" : ""} · ${j.requestType} · ${PRIORITY_LABEL[j.priority] || j.priority} priority · ${j.status}`);
    lines.push(`  Submitted by ${j.submitter || "unknown"} · ${j.age}${j.assignee ? ` · Assignee ${j.assignee}` : ""}`);
    lines.push(`  ${j.link}`, "");
  }
  lines.push(`Support: ${supportUrl}`, "", footerLine);
  const dueColour = (j) => (j.due.kind === "overdue" ? "#b42318" : j.due.kind === "today" ? "#b54708" : "#475467");
  const cards = jobs.map((j) => `<tr><td style="padding:12px 0;border-top:1px solid #e4e7ec">`
    + `<div style="font-weight:600;font-size:15px"><a href="${esc(j.link)}" style="color:#1f4bdb;text-decoration:none">T-${esc(j.number)}</a> · ${esc(j.subject)}</div>`
    + `<div style="margin-top:4px;font-weight:600;color:${dueColour(j)}">${esc(j.due.text)}${j.neededBy ? ` <span style="font-weight:400;color:#667085">(needed by ${esc(prettyDate(j.neededBy))})</span>` : ""}</div>`
    + `<div style="margin-top:4px;color:#344054">${esc(j.siteLabel)}${j.siteFreeText ? " <span style=\"color:#667085\">(free-text site)</span>" : ""} · ${esc(j.requestType)} · ${esc(PRIORITY_LABEL[j.priority] || j.priority)} priority · ${esc(j.status)}</div>`
    + `<div style="margin-top:2px;color:#667085;font-size:13px">Submitted by ${esc(j.submitter || "unknown")} · ${esc(j.age)}${j.assignee ? ` · Assignee ${esc(j.assignee)}` : ""}</div>`
    + `<div style="margin-top:6px"><a href="${esc(j.link)}" style="color:#1f4bdb">Open ticket</a></div></td></tr>`).join("");
  const html = `<div style="font:14px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#101828;max-width:640px">`
    + (test ? `<p style="background:#fef0c7;padding:8px 12px;border-radius:6px">This is a test digest. The daily schedule is not affected.</p>` : "")
    + emailLogoHtml()
    + `<h2 style="margin:0 0 4px;font-size:18px">Express Help · ${esc(label)} digest</h2><p style="margin:0 0 12px;color:#667085">${esc(prettyDate(date))} · ${jobs.length ? `${jobs.length} open, ${overdue} overdue, most overdue first` : "nothing open"}</p>`
    + (jobs.length ? `<table role="presentation" style="width:100%;border-collapse:collapse">${cards}</table>` : `<p>No open ${esc(label)} jobs today.</p>`)
    + `<p style="margin-top:16px"><a href="${esc(supportUrl)}" style="color:#1f4bdb">Open Support</a></p>`
    + footerHtml() + `</div>`;
  return { subject, text: lines.join("\n"), html, count: jobs.length, overdue };
}

function hashed(email) { return crypto.createHash("sha256").update(email).digest("hex").slice(0, 12); }

async function sendTo(recipients, digest, keyPrefix) {
  const results = [];
  for (const to of recipients) {
    let status = "unknown";
    let id = "";
    try {
      const r = await deliver({ to, subject: digest.subject, text: digest.text, html: digest.html, idempotencyKey: keyPrefix + "-" + hashed(to) });
      status = r?.status || "unknown";
      id = typeof r?.id === "string" ? r.id : "";
    } catch { status = "unknown"; }
    results.push({ to: hashed(to), status, id });
  }
  return results;
}

/** Scheduled entry point. Sends at most once per Melbourne date, only in the window after the set time. */
export async function runDigest({ at = clock() } = {}) {
  const settings = await readDigestSettings();
  if (!settings.enabled) return { outcome: "disabled" };
  const { date, minutes } = melbourneParts(at);
  const [h, m] = settings.time.split(":").map(Number);
  const start = h * 60 + m;
  if (minutes < start) return { outcome: "not-yet", date };
  if (minutes >= start + DIGEST_WINDOW_MINUTES) return { outcome: "window-passed", date };
  const key = "digest/sent/" + date;
  if (await ticketStore().get(key, { type: "json" }).catch(() => null)) return { outcome: "already-sent", date };
  const runId = "r" + crypto.randomBytes(6).toString("hex");
  const claim = await ticketStore().setJSON(key, { state: "claimed", runId, at: new Date(at).toISOString() }, { onlyIfNew: true }).catch(() => null);
  if (claim?.modified !== true) return { outcome: "already-sent", date };
  const jobs = await collectJobs(settings.queues, at);
  if (!jobs.length && settings.emptyDay === "skip") {
    await ticketStore().setJSON(key, { state: "skipped-empty", runId, at: new Date(at).toISOString() });
    return { outcome: "skipped-empty", date };
  }
  const digest = buildDigest({ jobs, queues: settings.queues, date });
  const results = await sendTo(settings.recipients, digest, "support-digest-" + date);
  await ticketStore().setJSON(key, { state: "done", runId, at: new Date(at).toISOString(), count: digest.count, overdue: digest.overdue, results });
  return { outcome: "sent", date, count: digest.count, results };
}

/**
 * Test digest: [TEST] subject, sent only to the ticket admin, never touches the daily sent-marker.
 * Limited to one per 10 minutes with a conditional write.
 */
export async function sendTestDigest({ at = clock(), requestId = "" } = {}) {
  const settings = await readDigestSettings();
  const slot = Math.floor(at / TEST_COOLDOWN_MS);
  const claim = await ticketStore().setJSON("digest/test/" + slot, { at: new Date(at).toISOString(), requestId }, { onlyIfNew: true }).catch(() => null);
  if (claim?.modified !== true) return { status: 429, error: "A test digest was sent in the last few minutes. Try again shortly." };
  const { date } = melbourneParts(at);
  const jobs = await collectJobs(settings.queues, at);
  const digest = buildDigest({ jobs, queues: settings.queues, date, test: true });
  const results = await sendTo([TICKET_ADMIN_EMAIL], digest, "support-digest-test-" + slot);
  await ticketStore().setJSON("digest/test/" + slot, { at: new Date(at).toISOString(), requestId, count: digest.count, results });
  return { status: 200, body: { sent: results[0]?.status === "sent", status: results[0]?.status, count: digest.count, overdue: digest.overdue, to: TICKET_ADMIN_EMAIL, id: results[0]?.id || "" } };
}

/** One-off test requested out of band (for example by the release process): processed by the scheduled run, once. */
export async function processTestRequest({ at = clock() } = {}) {
  const request = await ticketStore().get("digest/test-request", { type: "json" }).catch(() => null);
  if (!request?.id || !/^[a-z0-9-]{4,40}$/.test(request.id)) return null;
  const claim = await ticketStore().setJSON("digest/test-request-done/" + request.id, { at: new Date(at).toISOString(), state: "claimed" }, { onlyIfNew: true }).catch(() => null);
  if (claim?.modified !== true) return { outcome: "test-already-processed" };
  await ticketStore().delete("digest/test-request").catch(() => null);
  const age = at - Date.parse(request.requestedAt || "");
  if (!(age >= 0 && age < 2 * 60 * 60 * 1000)) {
    await ticketStore().setJSON("digest/test-request-done/" + request.id, { at: new Date(at).toISOString(), state: "expired" });
    return { outcome: "test-expired" };
  }
  const result = await sendTestDigest({ at, requestId: request.id });
  await ticketStore().setJSON("digest/test-request-done/" + request.id, { at: new Date(at).toISOString(), state: "done", status: result.status, body: result.body || null, error: result.error || "" });
  return { outcome: "test", result };
}
