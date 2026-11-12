import crypto from "node:crypto";
import { env, publicBase, visitorStore } from "./lib.mjs";

export const SHEET_HEADERS = [
  "visit_id", "location", "visitor_name", "phone", "company", "issues",
  "signed_in_at_utc", "signed_in_melbourne", "signed_out_at_utc", "signed_out_melbourne",
  "card_returned", "record_url", "photo_status", "review", "updated_at",
  "ID photo",
];
/** Column P. Private admin record link while the photo exists; never a public/signed URL, embed, or photo bytes. */
export const ID_PHOTO_COLUMN = "P";
export const ID_PHOTO_HEADER = "ID photo";
const ID_PHOTO_INDEX = SHEET_HEADERS.indexOf(ID_PHOTO_HEADER);
const UPDATED_AT_INDEX = SHEET_HEADERS.indexOf("updated_at");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
let sheetFetch = null;
let tokenCache = null;
let afterAppend = null;

export function setVisitorSheetAfterAppend(fn) {
  afterAppend = typeof fn === "function" ? fn : null;
}

export function setVisitorSheetFetch(fn) {
  sheetFetch = typeof fn === "function" ? fn : null;
  tokenCache = null;
}

/** Accept a real multiline PEM or the JSON private_key text, where line breaks are the two characters backslash and n. */
export function sheetPrivateKey(raw = env("VISITOR_SHEETS_PRIVATE_KEY")) {
  let text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (text.includes("-----END") && !text.endsWith("\n")) text += "\n";
  return text;
}

export function sheetConfigured() {
  const key = sheetPrivateKey();
  return !!(env("VISITOR_SHEETS_SPREADSHEET_ID") && env("VISITOR_SHEETS_CLIENT_EMAIL") && key.includes("-----BEGIN") && key.includes("PRIVATE KEY") && key.includes("-----END"));
}

export function sheetSafe(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 500);
  return /^[=+\-@\t]/.test(text) ? "'" + text : text;
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function accessToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: env("VISITOR_SHEETS_CLIENT_EMAIL"),
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = header + "." + claim;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sheetPrivateKey()).toString("base64url");
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + signature });
  const response = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) return "";
  const json = await response.json();
  if (!json.access_token) return "";
  tokenCache = { token: json.access_token, exp: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return json.access_token;
}

async function request(url, init) {
  const fetchImpl = sheetFetch || fetch;
  return fetchImpl(url, init);
}

function spreadsheetId() {
  return env("VISITOR_SHEETS_SPREADSHEET_ID");
}

function valuesUrl(range, suffix, query) {
  const base = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId()) + "/values/" + encodeURIComponent(range) + (suffix || "");
  return query ? base + "?" + query : base;
}

async function sheets(method, range, query, body, suffix) {
  const token = await accessToken();
  if (!token) return { ok: false, status: 401, body: {} };
  const response = await request(valuesUrl(range, suffix, query), {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: json };
}

export function recordUrl(visitId) {
  return publicBase().replace(/\/$/, "") + "/admin#/visitors/" + visitId;
}

/** "ID photo" cell: admin record link (requires Joshua's sign-in) while stored, "Photo deleted" after purge, else "No photo". */
export function idPhotoCell(visit) {
  if (!visit || visit.deleted) return "";
  if (visit.photoStatus === "stored") return recordUrl(visit.id);
  if (visit.photoStatus === "purged") return "Photo deleted";
  return "No photo";
}

/** Spreadsheet link for Joshua's notification email, from the configured ID. Empty when not configured. */
export function sheetUrl(id = env("VISITOR_SHEETS_SPREADSHEET_ID")) {
  const value = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(value)) return "";
  return "https://docs.google.com/spreadsheets/d/" + value + "/edit";
}

export function sheetIssues(visit) {
  const parts = [];
  if (visit?.issues) parts.push("Sign-in: " + sheetSafe(visit.issues));
  if (visit?.signOutIssues) parts.push("Sign-out: " + sheetSafe(visit.signOutIssues));
  return parts.join("\n");
}

export function sheetRowValues(visit, melbourne) {
  return [
    visit.id,
    sheetSafe(visit.location),
    sheetSafe(visit.name),
    sheetSafe(visit.phone),
    sheetSafe(visit.company),
    sheetIssues(visit),
    visit.signedInAt || "",
    melbourne(visit.signedInAt),
    visit.signedOutAt || "",
    visit.signedOutAt ? melbourne(visit.signedOutAt) : "",
    visit.cardReturned === true ? "yes" : "",
    recordUrl(visit.id),
    visit.photoStatus || "",
    sheetSafe(visit.review || ""),
    new Date().toISOString(),
    idPhotoCell(visit),
  ];
}

/** Row values without updated_at, for drift comparison. */
function comparable(values) {
  return values.filter((_, index) => index !== UPDATED_AT_INDEX).join("\n");
}

export function deletedRowValues(visitId) {
  return [visitId, "", "", "", "", "", "", "", "", "", "", "", "deleted", "", "", ""];
}

function rowNumber(range) {
  const match = String(range || "").match(/![A-Z]+(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function ensureHeader() {
  const current = await sheets("GET", "Visits!A1:P1");
  const cells = current.ok ? current.body.values?.[0] || [] : [];
  if (cells[0] !== "visit_id") {
    const wrote = await sheets("PUT", "Visits!A1:P1", "valueInputOption=RAW", { values: [SHEET_HEADERS] });
    return wrote.ok;
  }
  if (cells[ID_PHOTO_INDEX] === ID_PHOTO_HEADER) return true;
  // Existing header: add only the P1 cell, leave A1:O1 untouched.
  const wrote = await sheets("PUT", "Visits!P1", "valueInputOption=RAW", { values: [[ID_PHOTO_HEADER]] });
  return wrote.ok;
}

async function findRow(visitId) {
  const listed = await sheets("GET", "Visits!A:A");
  if (!listed.ok) return { error: listed.status };
  const rows = listed.body.values || [];
  for (let index = 1; index < rows.length; index++) {
    if (rows[index]?.[0] === visitId) return { row: index + 1 };
  }
  return { row: 0 };
}

async function writeRow(row, values) {
  return sheets("PUT", "Visits!A" + row + ":P" + row, "valueInputOption=RAW", { values: [values] });
}

export const SHEET_PROBE_ID = "v00000000000000000000000000000001";
const SHEET_PROBE_STAGES = new Set([
  "verified", "key-invalid", "oauth-failed", "sheet-denied", "sheet-missing", "tab-missing",
  "append-failed", "append-unknown", "read-failed", "readback-mismatch", "clear-failed", "clear-unverified", "busy",
]);
const PROBE_ROW = [SHEET_PROBE_ID, "SYNTHETIC", "PROBE", "0400000000", "PROBE", "", "", "", "", "", "", "", "probe", "", "", ""];

function probeStage(status, fallback) {
  if (status === 401) return "oauth-failed";
  if (status === 403) return "sheet-denied";
  if (status === 404) return "sheet-missing";
  if (status === 400) return "tab-missing";
  return fallback;
}

function probeResult(ok, stage) {
  return { ok: ok === true, stage: SHEET_PROBE_STAGES.has(stage) ? stage : "read-failed" };
}

function rowIsProbe(cells) {
  return cells[0] === SHEET_PROBE_ID && cells[1] === "SYNTHETIC" && cells[2] === "PROBE" && cells[3] === "0400000000" && cells[4] === "PROBE" && cells[12] === "probe";
}

function rowIsClear(cells) {
  return cells[0] === SHEET_PROBE_ID && !cells[1] && !cells[2] && !cells[3] && !cells[4] && cells[12] === "deleted";
}

export async function runSheetConnectionProbe() {
  if (!sheetConfigured()) return probeResult(false, "key-invalid");
  try { crypto.sign("RSA-SHA256", Buffer.from("sheet-probe"), sheetPrivateKey()); }
  catch { return probeResult(false, "key-invalid"); }
  const store = visitorStore();
  const lockKey = "sheet-probe/lock";
  let held = false;
  const acquired = await store.setJSON(lockKey, { at: Date.now() }, { onlyIfNew: true });
  if (acquired?.modified === true) held = true;
  else {
    const meta = await store.getWithMetadata(lockKey, { type: "json", consistency: "strong" });
    const age = Number(meta?.data?.at) ? Date.now() - Number(meta.data.at) : 0;
    if (!meta?.etag || age < 120000) return probeResult(false, "busy");
    await store.delete(lockKey);
    const again = await store.setJSON(lockKey, { at: Date.now() }, { onlyIfNew: true });
    if (again?.modified !== true) return probeResult(false, "busy");
    held = true;
  }
  let sentAppend = false;
  try {
    const header = await sheets("GET", "Visits!A1");
    if (!header.ok) return probeResult(false, probeStage(header.status, "read-failed"));
    if (header.body.values?.[0]?.[0] !== "visit_id") {
      const wrote = await sheets("PUT", "Visits!A1:P1", "valueInputOption=RAW", { values: [SHEET_HEADERS] });
      if (!wrote.ok) return probeResult(false, probeStage(wrote.status, "append-failed"));
    }
    const found = await findRow(SHEET_PROBE_ID);
    if (found.error) return probeResult(false, probeStage(found.error, "read-failed"));
    let row = found.row;
    if (!row) {
      sentAppend = true;
      const appended = await sheets("POST", "Visits!A:P", "valueInputOption=RAW&insertDataOption=INSERT_ROWS", { values: [PROBE_ROW] }, ":append");
      if (!appended.ok) return probeResult(false, probeStage(appended.status, appended.status >= 500 ? "append-unknown" : "append-failed"));
      row = rowNumber(appended.body.updates?.updatedRange);
      if (!row) {
        const again = await findRow(SHEET_PROBE_ID);
        if (again.error || !again.row) return probeResult(false, "append-unknown");
        row = again.row;
      }
    }
    const read = await sheets("GET", "Visits!A" + row + ":P" + row);
    if (!read.ok) return probeResult(false, probeStage(read.status, "read-failed"));
    const cells = read.body.values?.[0] || [];
    if (!rowIsProbe(cells) && !rowIsClear(cells)) return probeResult(false, "readback-mismatch");
    const cleared = await writeRow(row, deletedRowValues(SHEET_PROBE_ID));
    if (!cleared.ok) return probeResult(false, probeStage(cleared.status, "clear-failed"));
    const check = await sheets("GET", "Visits!A" + row + ":P" + row);
    if (!check.ok) return probeResult(false, probeStage(check.status, "clear-unverified"));
    if (!rowIsClear(check.body.values?.[0] || [])) return probeResult(false, "clear-unverified");
    return probeResult(true, "verified");
  } catch {
    return probeResult(false, sentAppend ? "append-unknown" : "read-failed");
  } finally {
    if (held) await store.delete(lockKey);
  }
}

export async function syncVisitRow(visit, melbourne) {
    if (!sheetConfigured()) return { status: "not-configured" };
  const store = visitorStore();
  const lockKey = "sheet-lock/" + visit.id;
  const lock = await store.setJSON(lockKey, { at: Date.now() }, { onlyIfNew: true });
  if (lock?.modified !== true) return { status: "pending" };
  try {
    const current = await store.get("visit/" + visit.id, { type: "json" }) || visit;
    if (!(await ensureHeader())) return { status: "unknown" };
    let row = Number(current.sheetRow) || 0;
    if (!row) {
      const found = await findRow(current.id);
      if (found.error) return { status: found.error >= 500 ? "unknown" : "failed" };
      row = found.row;
    }
    if (current.deleted) {
      if (!row) return { status: "synced", row: 0, deleted: true };
      const cleared = await writeRow(row, deletedRowValues(current.id));
      if (!cleared.ok) return { status: cleared.status >= 500 ? "unknown" : "failed" };
      return { status: "synced", row, deleted: true };
    }
    const values = sheetRowValues(current, melbourne);
    if (!row) {
      const appended = await sheets("POST", "Visits!A:P", "valueInputOption=RAW&insertDataOption=INSERT_ROWS", { values: [values] }, ":append");
      if (!appended.ok) return { status: appended.status >= 500 ? "unknown" : "failed" };
      if (afterAppend) await afterAppend(appended.body);
      row = rowNumber(appended.body.updates?.updatedRange);
      if (!row) {
        const again = await findRow(current.id);
        row = again.row || 0;
      }
      if (!row) return { status: "unknown" };
    }
    let latest = await store.get("visit/" + visit.id, { type: "json" });
    let writing = latest?.deleted ? deletedRowValues(visit.id) : sheetRowValues(latest || current, melbourne);
    let updated = await writeRow(row, writing);
    if (!updated.ok) return { status: updated.status >= 500 ? "unknown" : "failed" };
    const after = await store.get("visit/" + visit.id, { type: "json" });
    const drifted = !!after && (after.deleted !== !!latest?.deleted || (!after.deleted && comparable(sheetRowValues(after, melbourne)) !== comparable(writing)));
    if (drifted) {
      writing = after.deleted ? deletedRowValues(visit.id) : sheetRowValues(after, melbourne);
      updated = await writeRow(row, writing);
      if (!updated.ok) return { status: updated.status >= 500 ? "unknown" : "failed" };
      latest = after;
    }
    return { status: "synced", row, deleted: !!((after || latest)?.deleted) };
  } catch {
    return { status: "unknown" };
  } finally {
    await store.delete(lockKey);
  }
}

const BACKFILL_LOCK = "sheet-photo-backfill/lock";

function cellKind(value, visit) {
  if (value === "Photo deleted" || value === "No photo") return value;
  if (!value) return "blank";
  return value === recordUrl(visit.id) ? "record-link" : "other";
}

/**
 * One-off: fill only column P (and the P1 header) for rows already synced. Each row is matched by its
 * visit_id in column A before writing; rows that do not match are skipped, never appended or reordered.
 * Reads column P back afterwards with the sync's own access. Returns no visitor details.
 */
export async function backfillIdPhotoColumn(visits) {
  if (!sheetConfigured()) return { status: "not-configured", written: 0, rows: [] };
  const store = visitorStore();
  const lock = await store.setJSON(BACKFILL_LOCK, { at: Date.now() }, { onlyIfNew: true });
  if (lock?.modified !== true) {
    const meta = await store.getWithMetadata(BACKFILL_LOCK, { type: "json", consistency: "strong" });
    const age = Number(meta?.data?.at) ? Date.now() - Number(meta.data.at) : 0;
    if (meta?.etag && age < 300000) return { status: "busy", written: 0, rows: [] };
    await store.delete(BACKFILL_LOCK);
    const again = await store.setJSON(BACKFILL_LOCK, { at: Date.now() }, { onlyIfNew: true });
    if (again?.modified !== true) return { status: "busy", written: 0, rows: [] };
  }
  try {
    if (!(await ensureHeader())) return { status: "header-failed", written: 0, rows: [] };
    const ids = await sheets("GET", "Visits!A:A");
    if (!ids.ok) return { status: "read-failed", written: 0, rows: [] };
    const column = (ids.body.values || []).map((row) => row?.[0] || "");
    const current = await sheets("GET", "Visits!P:P");
    const photoColumn = current.ok ? (current.body.values || []).map((row) => row?.[0] || "") : [];
    let written = 0;
    const plan = [];
    for (const visit of visits) {
      if (!visit?.id || visit.deleted || visit.sheetSync !== "synced") continue;
      let row = Number(visit.sheetRow) || 0;
      if (!row || column[row - 1] !== visit.id) {
        const index = column.indexOf(visit.id);
        row = index >= 1 ? index + 1 : 0;
      }
      if (!row) { plan.push({ visit, row: 0, outcome: "not-in-sheet" }); continue; }
      const value = idPhotoCell(visit);
      if (photoColumn[row - 1] === value) { plan.push({ visit, row, outcome: "already-set" }); continue; }
      const wrote = await sheets("PUT", "Visits!P" + row, "valueInputOption=RAW", { values: [[value]] });
      if (!wrote.ok) { plan.push({ visit, row, outcome: "write-failed" }); continue; }
      written += 1;
      plan.push({ visit, row, outcome: "written" });
    }
    const header = await sheets("GET", "Visits!P1");
    const after = await sheets("GET", "Visits!P:P");
    const afterIds = await sheets("GET", "Visits!A:A");
    const readP = after.ok ? (after.body.values || []).map((row) => row?.[0] || "") : [];
    const readA = afterIds.ok ? (afterIds.body.values || []).map((row) => row?.[0] || "") : [];
    const rows = plan.map(({ visit, row, outcome }) => ({
      row,
      outcome,
      idMatches: row ? readA[row - 1] === visit.id : false,
      readBack: row ? cellKind(readP[row - 1] || "", visit) : "",
      expected: cellKind(idPhotoCell(visit), visit),
    }));
    const ok = rows.every((row) => row.outcome === "not-in-sheet" || (row.idMatches && row.readBack === row.expected));
    return {
      status: ok ? "ok" : "partial",
      header: header.ok ? (header.body.values?.[0]?.[0] || "") : "unread",
      written,
      rows,
    };
  } catch {
    return { status: "unknown", written: 0, rows: [] };
  } finally {
    await store.delete(BACKFILL_LOCK);
  }
}
