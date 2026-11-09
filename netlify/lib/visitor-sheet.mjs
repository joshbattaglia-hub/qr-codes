import crypto from "node:crypto";
import { env, publicBase, visitorStore } from "./lib.mjs";

export const SHEET_HEADERS = [
  "visit_id", "location", "visitor_name", "phone", "company", "issues",
  "signed_in_at_utc", "signed_in_melbourne", "signed_out_at_utc", "signed_out_melbourne",
  "card_returned", "record_url", "photo_status", "review", "updated_at",
];

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

export function sheetConfigured() {
  return !!(env("VISITOR_SHEETS_SPREADSHEET_ID") && env("VISITOR_SHEETS_CLIENT_EMAIL") && env("VISITOR_SHEETS_PRIVATE_KEY").includes("PRIVATE KEY"));
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
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), env("VISITOR_SHEETS_PRIVATE_KEY")).toString("base64url");
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

export function sheetRowValues(visit, melbourne) {
  return [
    visit.id,
    sheetSafe(visit.location),
    sheetSafe(visit.name),
    sheetSafe(visit.phone),
    sheetSafe(visit.company),
    sheetSafe(visit.issues || ""),
    visit.signedInAt || "",
    melbourne(visit.signedInAt),
    visit.signedOutAt || "",
    visit.signedOutAt ? melbourne(visit.signedOutAt) : "",
    visit.cardReturned === true ? "yes" : "",
    recordUrl(visit.id),
    visit.photoStatus || "",
    sheetSafe(visit.review || ""),
    new Date().toISOString(),
  ];
}

export function deletedRowValues(visitId) {
  return [visitId, "", "", "", "", "", "", "", "", "", "", "", "deleted", "", ""];
}

function rowNumber(range) {
  const match = String(range || "").match(/![A-Z]+(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function ensureHeader() {
  const current = await sheets("GET", "Visits!A1");
  if (current.ok && current.body.values?.[0]?.[0] === "visit_id") return true;
  const wrote = await sheets("PUT", "Visits!A1:O1", "valueInputOption=RAW", { values: [SHEET_HEADERS] });
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
  return sheets("PUT", "Visits!A" + row + ":O" + row, "valueInputOption=RAW", { values: [values] });
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
      const appended = await sheets("POST", "Visits!A:O", "valueInputOption=RAW&insertDataOption=INSERT_ROWS", { values: [values] }, ":append");
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
    const drifted = !!after && (after.deleted !== !!latest?.deleted || (!after.deleted && sheetRowValues(after, melbourne).slice(0, -1).join("\n") !== writing.slice(0, -1).join("\n")));
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
