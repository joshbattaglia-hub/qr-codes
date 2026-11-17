import { env, ticketStore } from "./lib.mjs";
import { TICKET_ADMIN_EMAIL } from "./tickets.mjs";

/**
 * Read-only Resend delivery check, requested out of band (blob "mail-diag/request") and run by the scheduled digest function,
 * because the Resend key is a secret that only the function runtime can read.
 * It only calls GET endpoints, sends nothing, and stores a sanitised summary:
 * emails to the ticket admin only (id, time, from, subject, last event), and sending-domain status with record names and statuses (no values).
 */
const REQUEST_KEY = "mail-diag/request";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

async function get(path) {
  try {
    const res = await fetch("https://api.resend.com" + path, { headers: { authorization: "Bearer " + env("RESEND_API_KEY") } });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: { message: String(error?.name || "Error") } };
  }
}

function errorOf(r) {
  if (r.status >= 200 && r.status < 300) return "";
  return String(r.body?.name || "") + ": " + String(r.body?.message || "").slice(0, 200);
}

const hasAdmin = (to) => (Array.isArray(to) ? to : [to]).some((one) => String(one || "").toLowerCase() === TICKET_ADMIN_EMAIL);

export async function runMailDiag({ at = Date.now() } = {}) {
  const fromSetting = env("RESEND_FROM");
  const out = { at: new Date(at).toISOString(), from: fromSetting, fromDomain: (fromSetting.match(/@([^>\s]+)/) || [])[1] || "", emails: [], domains: [], errors: {} };
  const list = await get("/emails?limit=100");
  out.errors.list = errorOf(list);
  const rows = Array.isArray(list.body?.data) ? list.body.data : [];
  out.listed = rows.length;
  for (const row of rows) {
    if (!hasAdmin(row.to)) continue;
    if (at - Date.parse(row.created_at || "") > LOOKBACK_MS) continue;
    out.emails.push({ id: String(row.id || ""), created_at: row.created_at, from: row.from, subject: String(row.subject || "").slice(0, 120), last_event: row.last_event || "" });
    if (out.emails.length >= 40) break;
  }
  for (const email of out.emails.slice(0, 15)) {
    if (email.last_event) continue;
    const one = await get("/emails/" + encodeURIComponent(email.id));
    email.last_event = one.body?.last_event || ("lookup " + one.status);
  }
  const domains = await get("/domains");
  out.errors.domains = errorOf(domains);
  for (const d of Array.isArray(domains.body?.data) ? domains.body.data : []) {
    const detail = await get("/domains/" + encodeURIComponent(d.id));
    out.domains.push({
      name: d.name, status: d.status, region: d.region, created_at: d.created_at,
      records: (Array.isArray(detail.body?.records) ? detail.body.records : []).map((r) => ({ record: r.record, type: r.type, name: r.name, status: r.status })),
    });
  }
  return out;
}

export async function processMailDiagRequest({ at = Date.now() } = {}) {
  const request = await ticketStore().get(REQUEST_KEY, { type: "json" }).catch(() => null);
  if (!request?.id || !/^[a-z0-9-]{4,40}$/.test(request.id)) return null;
  const doneKey = "mail-diag/done/" + request.id;
  const claim = await ticketStore().setJSON(doneKey, { at: new Date(at).toISOString(), state: "claimed" }, { onlyIfNew: true }).catch(() => null);
  if (claim?.modified !== true) return { outcome: "diag-already-processed" };
  await ticketStore().delete(REQUEST_KEY).catch(() => null);
  const age = at - Date.parse(request.requestedAt || "");
  if (!(age >= 0 && age < MAX_AGE_MS)) {
    await ticketStore().setJSON(doneKey, { at: new Date(at).toISOString(), state: "expired" });
    return { outcome: "diag-expired" };
  }
  if (!env("RESEND_API_KEY")) {
    await ticketStore().setJSON(doneKey, { at: new Date(at).toISOString(), state: "done", error: "not-configured" });
    return { outcome: "diag-not-configured" };
  }
  const result = await runMailDiag({ at });
  await ticketStore().setJSON(doneKey, { state: "done", ...result });
  return { outcome: "diag", emails: result.emails.length };
}
