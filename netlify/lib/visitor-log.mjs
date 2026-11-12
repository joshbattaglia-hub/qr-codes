import crypto from "node:crypto";
import { conditionalIncrement, env, publicBase, rateStore, visitorStore } from "./lib.mjs";
import { deliver } from "./mail.mjs";
import { reencodeVisitorPhoto } from "./visitor-image.mjs";
import { buildingMaintenanceEmailOk } from "./building-maintenance.mjs";
import { readUsers, setVisitorLevel } from "./users.mjs";
import { backfillIdPhotoColumn, recordUrl, runSheetConnectionProbe, sheetConfigured, sheetUrl, syncVisitRow } from "./visitor-sheet.mjs";

export const JOSHUA_EMAIL = "jbattaglia@libertyretail.com.au";
export const PHOTO_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const VISITOR_NOTICE = [
  "This visitor log asks you to sign in and to sign out. Return the Shell card to the lockbox before you sign out. The form will not sign you out or mark the card returned on its own.",
  "A clear photo of your ID is required when you sign in. The photo is stored privately in Express Help, not on a public link.",
  "If you sign out, that ID photo is deleted 90 days after sign-out. If you never sign out, the ID photo is deleted 90 days after sign-in and the written visit stays open, flagged for review. A later sign-out does not restore a photo that has expired or already been deleted.",
  "The written record is kept until Joshua deletes it. There is no scheduled deletion of the text.",
  "Inside Express Help, only Joshua's explicit visitor-log access, and people Joshua has given Visitor Log access in Users (for example building maintenance), can open these records. For each person Joshua chooses whether they can see the ID photo and whether they can change visitor log settings (notifications, maintenance numbers and the spreadsheet connection). Only Joshua can export or delete records or decide who has access. Every ID photo view is logged with who viewed it and when. A head-office password or a POS role does not grant access.",
  "Visitor log email notifications are off unless Joshua turns them on. When on, they go only to the @libertyretail.com.au addresses Joshua lists and say only that a visitor signed in or out, the location and time, with links that still need an authorised sign-in. They contain no visitor name, phone, company, notes or ID photo.",
  "When a private spreadsheet is configured, the written record is copied there for Joshua and the server identity that updates the sheet. The sheet cell for the photo is only the authenticated admin link for that record. It is not the stored photo and it is not a bearer token. Clearing a row does not erase Google Sheets version history or Google backups.",
].join(" ");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORPHAN_GRACE_MS = 15 * 60 * 1000;
let hooks = { collect: false, now: () => Date.now(), beforeNotifySend: null, idemPollMs: 400 };
let faults = { failVisitWrite: 0, failPhotoDelete: 0 };

export function setVisitorFaults(next = {}) {
  faults = { failVisitWrite: Number(next.failVisitWrite) || 0, failPhotoDelete: Number(next.failPhotoDelete) || 0 };
}

export function setVisitorTestHooks({ collect = false, now = null, beforeNotifySend = null, idemPollMs = 400 } = {}) {
  hooks = {
    collect: collect === true,
    now: typeof now === "function" ? now : () => Date.now(),
    beforeNotifySend: typeof beforeNotifySend === "function" ? beforeNotifySend : null,
    idemPollMs: Number(idemPollMs) >= 0 ? Number(idemPollMs) : 400,
  };
}

function now() {
  return hooks.now();
}

export function parseVisitorAccess(raw = env("VISITOR_ACCESS_MAP")) {
  const empty = { joshuaOtp: false, joshuaEntraOid: "", error: raw ? "" : "missing" };
  if (!raw) return empty;
  if (raw.length > 4000) return { ...empty, error: "too-large" };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ...empty, error: "invalid" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...empty, error: "invalid" };
  if (parsed.siteIds || parsed.allSites || parsed.sites || parsed.siteId) return { ...empty, error: "site-scope-not-used" };
  let joshuaEntraOid = "";
  if (parsed.joshuaEntraOid) {
    const oid = String(parsed.joshuaEntraOid).trim().toLowerCase();
    if (!GUID.test(oid)) return { ...empty, error: "entra-oid" };
    joshuaEntraOid = oid;
  }
  return { joshuaOtp: parsed.joshuaOtp === true, joshuaEntraOid, error: "" };
}

export function visitorCapability(actor) {
  const access = parseVisitorAccess();
  if (!actor || actor.kind !== "verified-identity" || access.error === "site-scope-not-used") return false;
  if (actor.provider === "otp" && access.joshuaOtp && String(actor.email || "").toLowerCase() === JOSHUA_EMAIL) return true;
  if (actor.provider === "entra" && access.joshuaEntraOid && String(actor.oid || "").toLowerCase() === access.joshuaEntraOid) return true;
  return false;
}

export function visitorReadiness() {
  const access = parseVisitorAccess();
  const blockers = [];
  if (access.error === "site-scope-not-used" || access.error === "invalid" || access.error === "entra-oid" || access.error === "too-large") blockers.push("access-map-rejected");
  else if (!access.joshuaOtp && !access.joshuaEntraOid) blockers.push("access-map-missing");
  if (!sheetConfigured()) blockers.push("sheet-not-configured");
  if (!visitorCollectionOpen()) blockers.push("collection-closed");
  return {
    open: blockers.length === 0,
    blockers,
    notice: VISITOR_NOTICE,
    photoRetention: "90 days after sign-out, or 90 days after sign-in if still open",
    openVisitPhotoRetention: "90 days after sign-in",
    textRetention: "until Joshua deletes the record",
    collection: visitorCollectionOpen() ? "open" : "closed",
    sheetConfigured: sheetConfigured(),
    sheetSharing: "none",
    viewer: "Joshua's explicit visitor-log access, and the people Joshua has given Visitor Log access in Users (view, view with ID photos, or settings)",
  };
}

/** New submissions stay closed until a later explicit approval sets this exact value. Sheet credentials do not open the form. */
export function visitorCollectionOpen() {
  return env("VISITOR_COLLECTION").trim() === "open";
}

function melbourne(iso) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day") + " " + get("hour") + ":" + get("minute") + " Australia/Melbourne";
}

export function melbourneDay(iso) {
  return melbourne(iso).slice(0, 10);
}

function trustedIp(req) {
  const value = String(req.headers.get("x-nf-client-connection-ip") || "").trim();
  if (value && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value)) {
    return crypto.createHash("sha256").update("visitor-ip\n" + value).digest("hex").slice(0, 24);
  }
  return "untrusted";
}

async function limited(req, kind) {
  const windowId = Math.floor(now() / 900000);
  const ip = trustedIp(req);
  const max = ip === "untrusted" ? (kind === "match" ? 5 : 8) : kind === "in" ? 10 : kind === "match" ? 8 : 20;
  const result = await conditionalIncrement(rateStore(), `visitor/${kind}/${ip}/${windowId}`, max);
  if (!result.ok && result.reason === "unsupported") return { status: 503, error: "Visitor log is temporarily unavailable." };
  if (result.reason === "limit") return { status: 429, error: "Too many attempts. Wait and try again." };
  return null;
}

function textField(value, max, label, required) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  if (!text && required) return { error: label + " is required." };
  if (text.length > max) return { error: label + " is too long." };
  return { text };
}

export function normalizeVisitorMatch(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const NEUTRAL_SIGN_OUT = "That sign-out could not be completed. Ask the site contact for help.";

function hashReceipt(receipt) {
  return crypto.createHash("sha256").update(String(receipt)).digest("hex");
}

function sameHex(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function publicVisit(visit) {
  if (!visit) return null;
  return {
    id: visit.id,
    location: visit.location,
    name: visit.name,
    phone: visit.phone,
    company: visit.company,
    issues: visit.issues || "",
    signOutIssues: visit.signOutIssues || "",
    signedInAt: visit.signedInAt,
    signedInMelbourne: melbourne(visit.signedInAt),
    signedOutAt: visit.signedOutAt || "",
    signedOutMelbourne: melbourne(visit.signedOutAt),
    cardReturned: visit.cardReturned === true,
    photoStatus: visit.photoStatus,
    review: visit.review || "",
    onSite: !visit.signedOutAt,
  };
}

async function audit(action, actorId, visitId, detail = "") {
  const row = {
    id: "a" + crypto.randomBytes(8).toString("hex"),
    at: new Date(now()).toISOString(),
    action,
    actorId: String(actorId || "").slice(0, 80),
    visitId: String(visitId || ""),
  };
  if (detail) row.detail = String(detail).slice(0, 600);
  await visitorStore().setJSON("audit/" + row.id, row);
  return row;
}

function sheetFingerprint(visit) {
  return JSON.stringify({
    location: visit.location, name: visit.name, phone: visit.phone, company: visit.company,
    issues: visit.issues || "", signOutIssues: visit.signOutIssues || "", signedOutAt: visit.signedOutAt || "", cardReturned: visit.cardReturned === true,
    photoStatus: visit.photoStatus || "",
  });
}

async function rememberSheet(before, result) {
  const meta = await visitorStore().getWithMetadata("visit/" + before.id, { type: "json", consistency: "strong" });
  if (!meta?.etag) return;
  const changed = sheetFingerprint(meta.data) !== sheetFingerprint(before);
  const status = result.status === "synced" && changed ? "pending" : result.status;
  const next = { ...meta.data, sheetSync: status, sheetRow: result.row || meta.data.sheetRow || null };
  await visitorStore().setJSON("visit/" + before.id, next, { onlyIfMatch: meta.etag });
}

async function syncVisit(visit) {
  const fresh = await visitorStore().get("visit/" + visit.id, { type: "json" });
  if (!fresh) return { status: "missing" };
  const result = await syncVisitRow(fresh, melbourne);
  await rememberSheet(fresh, result);
  return result;
}

export const NOTIFY_DOMAIN = "libertyretail.com.au";
/** Notification recipient: one exact @libertyretail.com.au address (no subdomains, lookalikes or lists). */
export function notifyRecipientOk(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 254) return "";
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at) return "";
  if (email.slice(at + 1) !== NOTIFY_DOMAIN) return "";
  if (!/^[a-z0-9._%+-]+$/.test(email.slice(0, at)) || email.startsWith(".") || email.includes("..")) return "";
  return email;
}
export const NOTIFY_RECIPIENTS_MAX = 10;
/**
 * Saved recipient list (exact @libertyretail.com.au, de-duplicated case-insensitively, capped).
 * A legacy single `recipient` is migrated into the list. Joshua's address when nothing valid is stored.
 */
export function effectiveRecipients(settings) {
  const raw = Array.isArray(settings?.recipients) ? settings.recipients : [settings?.recipient];
  const list = [];
  for (const value of raw) {
    const email = notifyRecipientOk(value);
    if (email && !list.includes(email) && list.length < NOTIFY_RECIPIENTS_MAX) list.push(email);
  }
  return list.length ? list : [JOSHUA_EMAIL];
}
function recipientKey(email) {
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 12);
}

async function notify(visit, event) {
  const settings = await visitorStore().get("notify/settings", { type: "json" });
  if (!settings?.enabled) return { status: "disabled" };
  if (settings.events !== "both" && settings.events !== event) return { status: "disabled" };
  if (!visitorCapability({ kind: "verified-identity", provider: "otp", email: JOSHUA_EMAIL })) return { status: "disabled" };
  const key = "notify/" + visit.id + "/" + event;
  const claim = await visitorStore().setJSON(key, { status: "pending", at: new Date(now()).toISOString() }, { onlyIfNew: true });
  if (claim?.modified !== true) {
    const existing = await visitorStore().get(key, { type: "json" });
    return { status: existing?.status || "duplicate" };
  }
  if (hooks.beforeNotifySend) await hooks.beforeNotifySend(visit, event);
  const current = await visitorStore().get("visit/" + visit.id, { type: "json" });
  if (!current || current.deleted) {
    await visitorStore().setJSON(key, { status: "suppressed", at: new Date(now()).toISOString() });
    return { status: "suppressed" };
  }
  const pending = await visitorStore().getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!pending?.etag || pending.data.status !== "pending") return { status: pending?.data?.status || "suppressed" };
  const sending = await visitorStore().setJSON(key, { status: "sending", at: new Date(now()).toISOString() }, { onlyIfMatch: pending.etag });
  if (sending?.modified !== true) return { status: "suppressed" };
  const again = await visitorStore().get("visit/" + visit.id, { type: "json" });
  if (!again || again.deleted) {
    const owned = await visitorStore().getWithMetadata(key, { type: "json", consistency: "strong" });
    if (owned?.etag && owned.data.status === "sending") {
      await visitorStore().setJSON(key, { status: "suppressed", at: new Date(now()).toISOString() }, { onlyIfMatch: owned.etag });
    }
    return { status: "suppressed" };
  }
  const location = String(again.location || "").replace(/[\r\n]+/g, " ").slice(0, 120);
  const text = [
      event === "out" ? "A visitor signed out." : "A visitor signed in.",
      "Location: " + location,
      "When: " + melbourne(event === "out" ? again.signedOutAt : again.signedInAt),
      "Record: " + publicBase() + "/admin#/visitors/" + visit.id,
      ...(sheetUrl() ? ["View visitor log spreadsheet: " + sheetUrl()] : []),
      "This message has no visitor name, phone, company, notes, or ID photo.",
    ].join("\n");
  // One message per recipient, so no recipient sees the others' addresses.
  const statuses = [];
  for (const to of effectiveRecipients(settings)) {
    const result = await deliver({
      to,
      subject: event === "out" ? "Visitor log sign-out" : "Visitor log sign-in",
      idempotencyKey: "visitor-" + visit.id + "-" + event + "-" + recipientKey(to),
      text,
    });
    statuses.push(result.status === "sent" ? "sent" : result.status === "unknown" ? "unknown" : result.status === "not-configured" ? "not-configured" : "failed");
  }
  const status = statuses.every((one) => one === "sent") ? "sent"
    : statuses.includes("unknown") ? "unknown"
    : statuses.every((one) => one === "not-configured") ? "not-configured" : "failed";
  const owned = await visitorStore().getWithMetadata(key, { type: "json", consistency: "strong" });
  if (owned?.etag && owned.data.status === "sending") {
    await visitorStore().setJSON(key, { status, at: new Date(now()).toISOString() }, { onlyIfMatch: owned.etag });
  }
  return { status };
}

function signInPhotoDeadline(visit) {
  return Date.parse(visit.signedInAt) + PHOTO_RETENTION_MS;
}

export function photoExpired(visit, at) {
  if (!visit || visit.deleted || visit.photoStatus === "purged") return true;
  if (!visit.signedOutAt) return signInPhotoDeadline(visit) <= at;
  if (Date.parse(visit.signedOutAt) >= signInPhotoDeadline(visit)) return true;
  return Date.parse(visit.signedOutAt) + PHOTO_RETENTION_MS <= at;
}

function photoDue(visit, at) {
  return !!(visit && !visit.deleted && visit.photoStatus === "stored" && photoExpired(visit, at));
}

export function photoReadable(visit, at = now()) {
  return !!(visit && !visit.deleted && visit.photoStatus === "stored" && !photoExpired(visit, at));
}

export async function signIn(req, body) {
  const readiness = visitorReadiness();
  if (!readiness.open) return { status: 403, error: "Visitor collection is not open.", blockers: readiness.blockers };
  const gate = await limited(req, "in");
  if (gate) return gate;
  const location = textField(body?.location, 120, "Site location", true);
  const name = textField(body?.name, 80, "Visitor name", true);
  const phone = textField(body?.phone, 40, "Phone", true);
  const company = textField(body?.company, 80, "Company", true);
  const issues = textField(body?.issues, 500, "Issues", false);
  const fieldError = [location, name, phone, company, issues].find((item) => item.error);
  if (fieldError) return { status: 400, error: fieldError.error };
  if (phone.text && !/^[0-9+() .\-]{6,40}$/.test(phone.text)) return { status: 400, error: "Phone is not valid." };
  let bytes;
  try { bytes = Buffer.from(String(body?.photo || "").replace(/^data:[^,]+,/, ""), "base64"); }
  catch { return { status: 400, error: "A photo of the ID is required." }; }
  if (!bytes.length) return { status: 400, error: "A photo of the ID is required." };
  const photo = reencodeVisitorPhoto(bytes);
  if (photo.error) return { status: 400, error: photo.error };
  const id = "v" + crypto.randomBytes(16).toString("hex");
  const receipt = crypto.randomBytes(32).toString("base64url");
  const signedInAt = new Date(now()).toISOString();
  const visit = {
    id, location: location.text, name: name.text, phone: phone.text, company: company.text, issues: issues.text,
    signedInAt, signedOutAt: "", cardReturned: false, receiptHash: hashReceipt(receipt),
    photoStatus: "stored", sheetRow: null, sheetSync: "pending",
  };
  const storedPhoto = await visitorStore().setJSON("photo/" + id, { contentType: photo.contentType, bytes: photo.bytes.toString("base64"), storedAt: signedInAt }, { onlyIfNew: true });
  if (storedPhoto?.modified !== true) return { status: 503, error: "Visitor log is temporarily unavailable." };
  if (faults.failVisitWrite > 0) {
    faults.failVisitWrite -= 1;
    await visitorStore().delete("photo/" + id);
    return { status: 503, error: "Visitor log is temporarily unavailable." };
  }
  const storedVisit = await visitorStore().setJSON("visit/" + id, visit, { onlyIfNew: true });
  if (storedVisit?.modified !== true) {
    await visitorStore().delete("photo/" + id);
    return { status: 503, error: "Visitor log is temporarily unavailable." };
  }
  const storedReceipt = await visitorStore().setJSON("receipt/" + visit.receiptHash, { visitId: id }, { onlyIfNew: true });
  if (storedReceipt?.modified !== true) {
    await visitorStore().delete("visit/" + id);
    await visitorStore().delete("photo/" + id);
    return { status: 503, error: "Visitor log is temporarily unavailable." };
  }
  await audit("sign-in", "public", id);
  await syncVisit(visit);
  await notify(visit, "in");
  return { status: 200, body: { ok: true, receipt, signedInAt, signedInMelbourne: melbourne(signedInAt) } };
}

export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_STALE_MS = 60 * 1000;
const IDEMPOTENCY_POLLS = 20;

/**
 * Public form duplicate protection. The browser sends one random key per submission; the first request
 * with that key runs, a repeat within 10 minutes gets the original successful result back (marked
 * duplicate) without a second visit, sheet row or notification. Only a hash of the key is stored. A
 * failed attempt releases the key so the visitor can fix the form and retry. The sign-in receipt is not
 * kept in the stored result.
 */
export async function idempotentSubmit(kind, rawKey, run) {
  const key = typeof rawKey === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(rawKey) ? rawKey : "";
  if (!key) return run();
  const blobKey = "idem/" + kind + "/" + crypto.createHash("sha256").update(kind + "\n" + key).digest("hex").slice(0, 40);
  const pending = () => ({ state: "pending", at: new Date(now()).toISOString() });
  let claimed = false;
  for (let attempt = 0; attempt < IDEMPOTENCY_POLLS && !claimed; attempt++) {
    const claim = await visitorStore().setJSON(blobKey, pending(), { onlyIfNew: true });
    if (claim?.modified === true) { claimed = true; break; }
    const meta = await visitorStore().getWithMetadata(blobKey, { type: "json", consistency: "strong" });
    if (!meta?.etag) continue;
    const age = now() - Date.parse(meta.data?.at || "");
    const expired = !Number.isFinite(age) || age >= IDEMPOTENCY_TTL_MS || (meta.data?.state === "pending" && age >= IDEMPOTENCY_STALE_MS);
    if (expired) {
      const take = await visitorStore().setJSON(blobKey, pending(), { onlyIfMatch: meta.etag });
      if (take?.modified === true) { claimed = true; break; }
      continue;
    }
    if (meta.data?.state === "done") return { status: meta.data.status, body: { ...(meta.data.body || {}), duplicate: true } };
    if (hooks.idemPollMs) await new Promise((resolve) => setTimeout(resolve, hooks.idemPollMs));
  }
  if (!claimed) return { status: 409, error: "This submission is still being saved. Wait a moment and try again." };
  let result;
  try { result = await run(); }
  catch (error) { await visitorStore().delete(blobKey).catch(() => {}); throw error; }
  if (result.status === 200 && result.body) {
    const { receipt, ...kept } = result.body;
    await visitorStore().setJSON(blobKey, { state: "done", at: new Date(now()).toISOString(), status: 200, body: kept }).catch(() => {});
  } else {
    await visitorStore().delete(blobKey).catch(() => {});
  }
  return result;
}

async function activeNameMatches(name, company) {
  const { blobs } = await visitorStore().list({ prefix: "visit/" });
  const rows = (await Promise.all(blobs.map((blob) => visitorStore().get(blob.key, { type: "json" })))).filter((row) => row && row.id && !row.deleted && !row.signedOutAt);
  return rows.filter((row) => normalizeVisitorMatch(row.name) === name && normalizeVisitorMatch(row.company) === company);
}

function readSignOutIssues(body) {
  return textField(body?.issues, 500, "Issues", false);
}

async function signOutWithName(req, body) {
  const issues = readSignOutIssues(body);
  if (issues.error) return { status: 400, error: issues.error };
  if (body?.cardReturned !== true) return { status: 400, error: "Confirm that the Shell card was returned to the lockbox." };
  const name = textField(body?.name, 80, "Visitor name", true);
  const company = textField(body?.company, 80, "Company", true);
  const fieldError = [name, company].find((item) => item.error);
  if (fieldError) return { status: 400, error: fieldError.error };
  const wantedName = normalizeVisitorMatch(name.text);
  const wantedCompany = normalizeVisitorMatch(company.text);
  if (!wantedName || !wantedCompany) return { status: 400, error: "Visitor name is required." };
  const gate = await limited(req, "match");
  if (gate) return gate;
  const hits = await activeNameMatches(wantedName, wantedCompany);
  if (hits.length !== 1) {
    await audit(hits.length > 1 ? "sign-out-ambiguous" : "sign-out-unmatched", "public", "");
    return { status: 400, error: NEUTRAL_SIGN_OUT };
  }
  const id = hits[0].id;
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await visitorStore().getWithMetadata("visit/" + id, { type: "json", consistency: "strong" });
    if (!meta?.etag || meta.data.deleted) return { status: 400, error: NEUTRAL_SIGN_OUT };
    if (meta.data.signedOutAt) {
      return { status: 200, body: { ok: true, alreadySignedOut: true, signedOutAt: meta.data.signedOutAt, signedOutMelbourne: melbourne(meta.data.signedOutAt), cardReturned: meta.data.cardReturned === true } };
    }
    const active = await activeNameMatches(wantedName, wantedCompany);
    if (active.length !== 1 || active[0].id !== id) {
      await audit(active.length > 1 ? "sign-out-ambiguous" : "sign-out-unmatched", "public", "");
      return { status: 400, error: NEUTRAL_SIGN_OUT };
    }
    const atMs = now();
    const signedOutAt = new Date(atMs).toISOString();
    const openExpired = signInPhotoDeadline(meta.data) <= atMs;
    const next = { ...meta.data, signedOutAt, cardReturned: true, signOutIssues: issues.text, sheetSync: "pending", generation: (meta.data.generation || 0) + 1 };
    if (openExpired || meta.data.photoStatus === "purged") {
      next.photoStatus = "purged";
      next.photoExpiredAt = meta.data.photoExpiredAt || new Date(signInPhotoDeadline(meta.data)).toISOString();
      next.review = meta.data.review || "open-photo-expired";
    }
    const write = await visitorStore().setJSON("visit/" + id, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) {
      if (next.photoStatus === "purged") await visitorStore().delete("photo/" + id);
      await audit("sign-out", "public", id);
      await syncVisit(next);
      await notify(next, "out");
      return { status: 200, body: { ok: true, signedOutAt, signedOutMelbourne: melbourne(signedOutAt), cardReturned: true } };
    }
    if (write?.modified !== false) return { status: 503, error: "Visitor log is temporarily unavailable." };
  }
  return { status: 409, error: "Sign-out could not be saved. Try again." };
}

export async function signOut(req, body) {
  const receipt = String(body?.receipt || "");
  if (!receipt) return signOutWithName(req, body);
  const issues = readSignOutIssues(body);
  if (issues.error) return { status: 400, error: issues.error };
  const gate = await limited(req, "out");
  if (gate) return gate;
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(receipt)) return { status: 401, error: "That receipt was not accepted." };
  if (body?.cardReturned !== true) return { status: 400, error: "Confirm that the Shell card was returned to the lockbox." };
  const digest = hashReceipt(receipt);
  const pointer = await visitorStore().get("receipt/" + digest, { type: "json" });
  if (!pointer?.visitId) return { status: 401, error: "That receipt was not accepted." };
  const match = await visitorStore().get("visit/" + pointer.visitId, { type: "json" });
  if (!match || !sameHex(match.receiptHash, digest)) return { status: 401, error: "That receipt was not accepted." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await visitorStore().getWithMetadata("visit/" + match.id, { type: "json", consistency: "strong" });
    if (!meta?.etag || !sameHex(meta.data.receiptHash, digest)) return { status: 401, error: "That receipt was not accepted." };
    if (meta.data.deleted) return { status: 404, error: "That receipt was not accepted." };
    if (meta.data.signedOutAt) {
      return { status: 200, body: { ok: true, alreadySignedOut: true, signedOutAt: meta.data.signedOutAt, signedOutMelbourne: melbourne(meta.data.signedOutAt), cardReturned: meta.data.cardReturned === true } };
    }
    const atMs = now();
    const signedOutAt = new Date(atMs).toISOString();
    const openExpired = signInPhotoDeadline(meta.data) <= atMs;
    const next = { ...meta.data, signedOutAt, cardReturned: true, signOutIssues: issues.text, sheetSync: "pending", generation: (meta.data.generation || 0) + 1 };
    if (openExpired || meta.data.photoStatus === "purged") {
      next.photoStatus = "purged";
      next.photoExpiredAt = meta.data.photoExpiredAt || new Date(signInPhotoDeadline(meta.data)).toISOString();
      next.review = meta.data.review || "open-photo-expired";
    }
    const write = await visitorStore().setJSON("visit/" + match.id, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) {
      if (next.photoStatus === "purged") await visitorStore().delete("photo/" + match.id);
      await audit("sign-out", "public", match.id);
      await syncVisit(next);
      await notify(next, "out");
      return { status: 200, body: { ok: true, signedOutAt, signedOutMelbourne: melbourne(signedOutAt), cardReturned: true } };
    }
    if (write?.modified !== false) return { status: 503, error: "Visitor log is temporarily unavailable." };
  }
  return { status: 409, error: "Sign-out could not be saved. Try the receipt again." };
}

/**
 * Visitor Log level for this actor: "admin" (Joshua's explicit visitor-log access), or the level set in
 * Admin > Users for an email-code user: "settings" (view, ID photos and settings), "maintenance" (view
 * with ID photos) or "viewer" (view without ID photos). Otherwise "none".
 */
export async function visitorRole(actor) {
  if (visitorCapability(actor)) return "admin";
  if (!actor || actor.kind !== "verified-identity" || actor.provider !== "otp" || !actor.email) return "none";
  if (parseVisitorAccess().error) return "none";
  const level = actor.visitor;
  if (level === "settings") return "settings";
  if (level === "photos") return "maintenance";
  if (level === "view") return "viewer";
  return "none";
}

export async function visitorViewCapability(actor) {
  return (await visitorRole(actor)) !== "none";
}

export async function visitorPhotoCapability(actor) {
  const role = await visitorRole(actor);
  return role === "admin" || role === "settings" || role === "maintenance";
}

export async function visitorSettingsCapability(actor) {
  const role = await visitorRole(actor);
  return role === "admin" || role === "settings";
}

/** Compatibility for the old "Building maintenance access" list: users with Visitor Log view and ID photos and no other role. */
export async function listBuildingMaintenance(actor) {
  if (!visitorCapability(actor)) return { status: 403, error: "Visitor log access is not granted." };
  const { users } = await readUsers();
  return { status: 200, body: { users: users.filter((row) => !row.owner && row.visitor === "photos").map((row) => row.email).sort() } };
}

/** Joshua adds or removes Visitor Log view-with-photos for one address (stored in Users; audited there). */
export async function changeBuildingMaintenance(actor, body) {
  if (!visitorCapability(actor)) return { status: 403, error: "Visitor log access is not granted." };
  const action = body?.action === "add" || body?.action === "remove" ? body.action : "";
  if (!action) return { status: 400, error: "Choose add or remove." };
  const email = buildingMaintenanceEmailOk(body?.email);
  if (!email) return { status: 400, error: "Use one exact @libertyretail.com.au email address." };
  if (action === "add" && email === JOSHUA_EMAIL) return { status: 400, error: "Joshua already has full visitor log access." };
  const before = (await readUsers()).users.find((row) => row.email === email);
  if (action === "add" && before?.visitor === "photos") return { status: 200, body: { users: (await listBuildingMaintenance(actor)).body.users, changed: false } };
  if (action === "remove" && (!before || before.visitor === "none")) return { status: 200, body: { users: (await listBuildingMaintenance(actor)).body.users, changed: false } };
  const result = await setVisitorLevel(actor, email, action === "add" ? "photos" : "none");
  if (result.status !== 200) return result;
  await audit(action === "add" ? "maintenance-user-add" : "maintenance-user-remove", actor.id || "", "", email);
  return { status: 200, body: { users: (await listBuildingMaintenance(actor)).body.users, changed: true } };
}

export async function listVisits(actor, query) {
  if (!(await visitorViewCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const { blobs } = await visitorStore().list({ prefix: "visit/" });
  const rows = (await Promise.all(blobs.map((blob) => visitorStore().get(blob.key, { type: "json" })))).filter((row) => row && row.id && !row.deleted);
  const from = String(query.get("from") || "");
  const to = String(query.get("to") || "");
  const status = String(query.get("status") || "all");
  const location = String(query.get("location") || "").trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (status === "in" && row.signedOutAt) return false;
    if (status === "out" && !row.signedOutAt) return false;
    const day = melbourneDay(row.signedInAt);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (location && !String(row.location || "").toLowerCase().includes(location)) return false;
    return true;
  }).sort((a, b) => String(b.signedInAt).localeCompare(String(a.signedInAt)));
  return { status: 200, body: { visits: filtered.slice(0, 500).map(publicVisit) } };
}

export async function readVisit(actor, id) {
  if (!(await visitorViewCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  if (!/^v[a-f0-9]{32}$/.test(id)) return { status: 404, error: "Not found" };
  const visit = await visitorStore().get("visit/" + id, { type: "json" });
  if (!visit || visit.deleted) return { status: 404, error: "Not found" };
  return { status: 200, body: { visit: publicVisit(visit), recordUrl: recordUrl(id) } };
}

export async function readPhoto(actor, id) {
  const role = await visitorRole(actor);
  if (role === "none") return { status: 403, error: "Visitor log access is not granted." };
  if (role === "viewer") return { status: 403, error: "ID photo access is not granted." };
  if (!/^v[a-f0-9]{32}$/.test(id)) return { status: 404, error: "Not found" };
  const visit = await visitorStore().get("visit/" + id, { type: "json" });
  if (!visit) return { status: 404, error: "Not found" };
  if (!photoReadable(visit)) return { status: 404, error: "Not found" };
  const photo = await visitorStore().get("photo/" + id, { type: "json" });
  if (!photo?.bytes) return { status: 404, error: "Not found" };
  await audit("photo-view", actor.id || "", id, (role === "maintenance" ? "building maintenance " : role === "settings" ? "visitor settings " : "") + String(actor.email || "").toLowerCase());
  return { status: 200, contentType: photo.contentType === "image/png" ? "image/png" : "image/jpeg", bytes: Buffer.from(photo.bytes, "base64") };
}

export async function recoverReceipt(actor, id) {
  if (!visitorCapability(actor)) return { status: 403, error: "Visitor log access is not granted." };
  if (!/^v[a-f0-9]{32}$/.test(id)) return { status: 404, error: "Not found" };
  const receipt = crypto.randomBytes(32).toString("base64url");
  const digest = hashReceipt(receipt);
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await visitorStore().getWithMetadata("visit/" + id, { type: "json", consistency: "strong" });
    if (!meta?.etag) return { status: 404, error: "Not found" };
    if (meta.data.signedOutAt) return { status: 409, error: "That visit is already signed out." };
    const next = { ...meta.data, receiptHash: digest };
    const write = await visitorStore().setJSON("visit/" + id, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) {
      const linked = await visitorStore().setJSON("receipt/" + digest, { visitId: id }, { onlyIfNew: true });
      if (linked?.modified !== true) return { status: 503, error: "Visitor log is temporarily unavailable." };
      await visitorStore().delete("receipt/" + meta.data.receiptHash);
      await audit("receipt-recovery", actor.id || "", id);
      return { status: 200, body: { ok: true, receipt } };
    }
    if (write?.modified !== false) return { status: 503, error: "Visitor log is temporarily unavailable." };
  }
  return { status: 409, error: "The receipt could not be replaced." };
}

export function csvEscape(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  const safe = /^[=+\-@\t]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export async function exportVisits(actor) {
  if (!visitorCapability(actor)) return { status: 403, error: "Visitor log access is not granted." };
  const listed = await listVisits(actor, new URLSearchParams());
  const header = ["id", "location", "name", "phone", "company", "issues", "sign_out_issues", "signed_in_melbourne", "signed_out_melbourne", "card_returned", "photo_status"];
  const lines = [header.join(",")];
  for (const visit of listed.body.visits) {
    lines.push([
      visit.id, visit.location, visit.name, visit.phone, visit.company, visit.issues, visit.signOutIssues,
      visit.signedInMelbourne, visit.signedOutMelbourne, visit.cardReturned ? "yes" : "", visit.photoStatus,
    ].map(csvEscape).join(","));
  }
  await audit("export", actor.id || "", "");
  return { status: 200, body: lines.join("\n") + "\n" };
}

export async function notificationSettings(actor) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const stored = await visitorStore().get("notify/settings", { type: "json" });
  return { status: 200, body: { enabled: stored?.enabled === true, events: stored?.events || "both", recipients: effectiveRecipients(stored), max: NOTIFY_RECIPIENTS_MAX, domain: NOTIFY_DOMAIN } };
}

export async function sheetConnectionCheck(actor) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const result = await runSheetConnectionProbe();
  const stage = result.stage;
  await audit("sheet-probe", actor.id || "", "");
  await visitorStore().setJSON("sheet-probe/last", {
    ok: result.ok === true,
    stage,
    at: new Date(now()).toISOString(),
    actorId: String(actor.id || "").slice(0, 80),
  });
  return { status: 200, body: { ok: result.ok === true, stage } };
}

export async function saveNotificationSettings(actor, body) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const asked = body?.recipient !== undefined ? body.recipient : body?.email;
  if (asked !== undefined && asked !== null && String(asked).trim() !== "") {
    if (!notifyRecipientOk(asked)) return { status: 400, error: "Use one exact @" + NOTIFY_DOMAIN + " email address." };
    return { status: 400, error: "Add or remove recipients in the recipient list." };
  }
  const events = body?.events === "in" || body?.events === "out" || body?.events === "both" ? body.events : "";
  if (body?.enabled === true && !events) return { status: 400, error: "Choose sign-in, sign-out, or both." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await visitorStore().getWithMetadata("notify/settings", { type: "json", consistency: "strong" });
    const recipients = effectiveRecipients(stored?.data);
    const next = { enabled: body?.enabled === true, events: events || "both", recipients, updatedAt: new Date(now()).toISOString() };
    const write = await visitorStore().setJSON("notify/settings", next, stored?.etag ? { onlyIfMatch: stored.etag } : { onlyIfNew: true });
    if (write?.modified !== true) continue;
    await audit("notify-settings", actor.id || "", "");
    return { status: 200, body: { enabled: next.enabled, events: next.events, recipients } };
  }
  return { status: 409, error: "Settings changed. Try again." };
}

/** Joshua adds or removes one notification recipient. The list keeps at least one address. Audited with the address. */
export async function changeNotificationRecipients(actor, body) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const action = body?.action === "add" || body?.action === "remove" ? body.action : "";
  if (!action) return { status: 400, error: "Choose add or remove." };
  const email = typeof body?.email === "string" ? notifyRecipientOk(body.email) : "";
  if (!email) return { status: 400, error: "Use one exact @" + NOTIFY_DOMAIN + " email address." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await visitorStore().getWithMetadata("notify/settings", { type: "json", consistency: "strong" });
    const data = stored?.data || {};
    const current = effectiveRecipients(data);
    const has = current.includes(email);
    if ((action === "add" && has) || (action === "remove" && !has)) return { status: 200, body: { recipients: current, changed: false } };
    if (action === "add" && current.length >= NOTIFY_RECIPIENTS_MAX) return { status: 400, error: "Up to " + NOTIFY_RECIPIENTS_MAX + " recipients." };
    if (action === "remove" && current.length <= 1) return { status: 400, error: "Keep at least one recipient." };
    const recipients = action === "add" ? [...current, email] : current.filter((row) => row !== email);
    const next = { enabled: data.enabled === true, events: data.events === "in" || data.events === "out" ? data.events : "both", recipients, updatedAt: new Date(now()).toISOString() };
    const write = await visitorStore().setJSON("notify/settings", next, stored?.etag ? { onlyIfMatch: stored.etag } : { onlyIfNew: true });
    if (write?.modified !== true) continue;
    await audit(action === "add" ? "notify-recipient-add" : "notify-recipient-remove", actor.id || "", "", email);
    return { status: 200, body: { recipients, changed: true } };
  }
  return { status: 409, error: "The list changed. Try again." };
}

export const MAINTENANCE_SLOTS = 4;
const MAINTENANCE_KEY = "maintenance/contacts";

/**
 * One maintenance phone number. Blank is allowed (slot unused). Display text keeps the readable
 * spacing; the tel: href is digits with an optional leading +.
 */
export function maintenancePhone(value) {
  const display = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!display) return { blank: true, display: "", href: "" };
  if (display.length > 24) return { error: "too-long" };
  if (!/^\+?[0-9 ()\-.]+$/.test(display)) return { error: "invalid" };
  const digits = display.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return { error: "invalid" };
  return { display, href: "tel:" + (display.startsWith("+") ? "+" : "") + digits };
}

async function readMaintenanceNumbers() {
  const stored = await visitorStore().get(MAINTENANCE_KEY, { type: "json" });
  const numbers = Array.isArray(stored?.numbers) ? stored.numbers : [];
  return Array.from({ length: MAINTENANCE_SLOTS }, (_, i) => {
    const phone = maintenancePhone(numbers[i]);
    return phone.error || phone.blank ? "" : phone.display;
  });
}

/** Public: only labels, display text and tel: links for the slots that are set. Same for every site and form. */
export async function publicMaintenanceContacts() {
  const numbers = await readMaintenanceNumbers();
  const contacts = [];
  numbers.forEach((value, i) => {
    if (!value) return;
    const phone = maintenancePhone(value);
    contacts.push({ label: "Maintenance line " + (i + 1), display: phone.display, href: phone.href });
  });
  return { contacts };
}

export async function maintenanceSettings(actor) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  return { status: 200, body: { numbers: await readMaintenanceNumbers() } };
}

export async function saveMaintenanceSettings(actor, body) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const incoming = Array.isArray(body?.numbers) ? body.numbers : null;
  if (!incoming || incoming.length > MAINTENANCE_SLOTS) return { status: 400, error: "Send up to " + MAINTENANCE_SLOTS + " maintenance numbers." };
  const numbers = [];
  for (let i = 0; i < MAINTENANCE_SLOTS; i++) {
    const raw = incoming[i];
    if (raw !== undefined && raw !== null && typeof raw !== "string") return { status: 400, error: "Maintenance line " + (i + 1) + " is not a phone number." };
    const phone = maintenancePhone(raw);
    if (phone.error) return { status: 400, error: "Maintenance line " + (i + 1) + " is not a valid phone number." };
    numbers.push(phone.display);
  }
  await visitorStore().setJSON(MAINTENANCE_KEY, { numbers, updatedAt: new Date(now()).toISOString() });
  await audit("maintenance-numbers", actor.id || "", "");
  return { status: 200, body: { numbers } };
}

async function purgePhoto(visit) {
  try {
    if (faults.failPhotoDelete > 0) {
      faults.failPhotoDelete -= 1;
      throw new Error("delete-failed");
    }
    await visitorStore().delete("photo/" + visit.id);
  } catch {
    await audit("photo-purge-failed", "cleanup", visit.id);
    return false;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await visitorStore().getWithMetadata("visit/" + visit.id, { type: "json", consistency: "strong" });
    if (!meta?.etag) return;
    if (meta.data.photoStatus === "purged" || meta.data.deleted) return true;
    const next = {
      ...meta.data,
      photoStatus: "purged",
      sheetSync: "pending",
      generation: (meta.data.generation || 0) + 1,
      photoExpiredAt: meta.data.photoExpiredAt || new Date(meta.data.signedOutAt ? Date.parse(meta.data.signedOutAt) + PHOTO_RETENTION_MS : signInPhotoDeadline(meta.data)).toISOString(),
    };
    if (!meta.data.signedOutAt) next.review = "open-photo-expired";
    const write = await visitorStore().setJSON("visit/" + visit.id, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) {
      await audit("photo-purged", "cleanup", visit.id);
      await syncVisit(next);
      return true;
    }
  }
  return false;
}

async function suppressNotifications(visitId) {
  for (const event of ["in", "out"]) {
    const key = "notify/" + visitId + "/" + event;
    const meta = await visitorStore().getWithMetadata(key, { type: "json", consistency: "strong" });
    const row = { status: "suppressed", at: new Date(now()).toISOString() };
    if (!meta?.etag) {
      await visitorStore().setJSON(key, row, { onlyIfNew: true });
      continue;
    }
    if (meta.data.status === "pending" || meta.data.status === "sending") {
      await visitorStore().setJSON(key, row, { onlyIfMatch: meta.etag });
    }
  }
}

export async function deleteVisit(actor, id) {
  if (!visitorCapability(actor)) return { status: 403, error: "Visitor log access is not granted." };
  if (!/^v[a-f0-9]{32}$/.test(id)) return { status: 404, error: "Not found" };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await visitorStore().getWithMetadata("visit/" + id, { type: "json", consistency: "strong" });
    if (!meta?.etag) return { status: 404, error: "Not found" };
    if (meta.data.deleted) return { status: 200, body: { ok: true, alreadyDeleted: true } };
    const tombstone = {
      id,
      deleted: true,
      deletedAt: new Date(now()).toISOString(),
      photoStatus: "purged",
      sheetRow: meta.data.sheetRow || null,
      sheetSync: "pending",
      generation: (meta.data.generation || 0) + 1,
    };
    const write = await visitorStore().setJSON("visit/" + id, tombstone, { onlyIfMatch: meta.etag });
    if (write?.modified !== true) {
      if (write?.modified === false) continue;
      return { status: 503, error: "Visitor log is temporarily unavailable." };
    }
    await visitorStore().delete("photo/" + id);
    if (meta.data.receiptHash) await visitorStore().delete("receipt/" + meta.data.receiptHash);
    await suppressNotifications(id);
    await syncVisit(tombstone);
    await audit("record-deleted", actor.id || "", id);
    return { status: 200, body: { ok: true } };
  }
  return { status: 409, error: "The record could not be deleted." };
}

const ID_PHOTO_MIGRATION = "sheet-migration/id-photo-v1";

/**
 * Fill the sheet's "ID photo" column (P) for rows synced before it existed. Runs once from the daily
 * cleanup, or when Joshua presses the admin button. Writes column P cells only. The stored result has
 * row numbers and outcomes, no visitor details.
 */
export async function runIdPhotoBackfill({ force = false, actorId = "cleanup" } = {}) {
  const marker = await visitorStore().get(ID_PHOTO_MIGRATION, { type: "json" });
  if (marker?.done && !force) return { status: "already-done", written: 0, rows: marker.rows || [] };
  const { blobs } = await visitorStore().list({ prefix: "visit/" });
  const visits = (await Promise.all(blobs.map((blob) => visitorStore().get(blob.key, { type: "json" })))).filter((row) => row && row.id);
  const result = await backfillIdPhotoColumn(visits);
  if (result.status === "busy" || result.status === "not-configured") return result;
  await visitorStore().setJSON(ID_PHOTO_MIGRATION, {
    done: result.status === "ok",
    status: result.status,
    header: result.header || "",
    written: result.written,
    rows: result.rows,
    at: new Date(now()).toISOString(),
    trigger: actorId === "cleanup" ? "cleanup" : "admin",
  });
  await audit("sheet-photo-backfill", actorId, "");
  return result;
}

export async function idPhotoBackfill(actor, body) {
  if (!(await visitorSettingsCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  if (body?.confirm !== "BACKFILL") return { status: 400, error: "Confirm the ID photo column fill." };
  const result = await runIdPhotoBackfill({ force: true, actorId: actor.id || "" });
  return { status: 200, body: { status: result.status, header: result.header || "", written: result.written || 0, rows: result.rows || [] } };
}

export async function runVisitorCleanup(at = now()) {
  let idPhotoColumn = "skipped";
  try { idPhotoColumn = (await runIdPhotoBackfill()).status; } catch { idPhotoColumn = "unknown"; }
  const { blobs } = await visitorStore().list({ prefix: "visit/" });
  let purged = 0;
  for (const blob of blobs) {
    const visit = await visitorStore().get(blob.key, { type: "json" });
    if (!visit?.id) continue;
    if (photoDue(visit, at)) {
      if (await purgePhoto(visit)) purged += 1;
    } else if (visit.sheetSync === "pending" || visit.sheetSync === "unknown") {
      await syncVisit(visit);
    }
  }
  const idem = await visitorStore().list({ prefix: "idem/" });
  for (const blob of idem.blobs) {
    const row = await visitorStore().get(blob.key, { type: "json" });
    const age = at - Date.parse(row?.at || "");
    if (!Number.isFinite(age) || age >= IDEMPOTENCY_TTL_MS) await visitorStore().delete(blob.key);
  }
  const photos = await visitorStore().list({ prefix: "photo/" });
  let orphans = 0;
  for (const blob of photos.blobs) {
    const id = blob.key.slice("photo/".length);
    const visit = await visitorStore().get("visit/" + id, { type: "json" });
    const photo = await visitorStore().get(blob.key, { type: "json" });
    if (visit?.photoStatus === "stored") continue;
    const storedAt = Date.parse(photo?.storedAt || "");
    if (!visit && Number.isFinite(storedAt) && at - storedAt < ORPHAN_GRACE_MS) continue;
    await visitorStore().delete(blob.key);
    orphans += 1;
  }
  return { purged, orphans, idPhotoColumn };
}

