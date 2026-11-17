import crypto from "node:crypto";
import { warehouseStore } from "./lib.mjs";
import { isOwner } from "./users.mjs";

/**
 * Warehouse Stickers: sequential Code 39 codes WH1000, WH1001, ... issued a full A4 sheet at a time.
 * The counter lives in Blobs and only moves with a conditional (etag) write, so concurrent presses never share a number.
 * Each press carries an idempotency key, so a double click or a retry returns the same sheet instead of burning another.
 */
export const WAREHOUSE_PREFIX = "WH";
export const WAREHOUSE_START = 1000;
export const LABEL_SHEET = {
  name: "Avery L7160",
  perSheet: 21,
  columns: 3,
  rows: 7,
  labelWidthMm: 63.5,
  labelHeightMm: 38.1,
  topMarginMm: 15.15,
  sideMarginMm: 7.21,
  columnPitchMm: 66.04,
  columnGapMm: 2.54,
  rowPitchMm: 38.1,
};
export const NEXT_MAX = 999999999;
const COUNTER_KEY = "counter";
const MAX_ATTEMPTS = 60;

let clock = () => Date.now();
let pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function setWarehouseTestHooks({ now = null, sleep = null } = {}) {
  clock = typeof now === "function" ? now : () => Date.now();
  pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}
const nowIso = () => new Date(clock()).toISOString();

export function codeFor(n) { return WAREHOUSE_PREFIX + String(n); }
export function codesFor(from, to) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(codeFor(n));
  return out;
}

export function canUseWarehouse(actor) {
  if (!actor) return false;
  if (actor.role === "head") return true;
  if (isOwner(actor)) return true;
  return actor.kind === "verified-identity" && actor.provider === "otp" && actor.warehouse === true && !!actor.email;
}
export function canAdminWarehouse(actor) {
  return !!actor && (actor.role === "head" || isOwner(actor));
}
function who(actor) {
  if (actor?.role === "head") return { by: "Head office", byId: "head-office" };
  return { by: String(actor?.email || actor?.name || "unknown").slice(0, 254), byId: String(actor?.id || "").slice(0, 80) };
}

function sheetKey(from) { return "sheet/" + String(from).padStart(12, "0"); }
function publicSheet(row) {
  return { id: String(row.from), from: row.from, to: row.to, first: codeFor(row.from), last: codeFor(row.to), count: row.to - row.from + 1, by: row.by, at: row.at, reprints: row.reprints || 0, lastReprintAt: row.lastReprintAt || "" };
}

export async function readCounter() {
  const meta = await warehouseStore().getWithMetadata(COUNTER_KEY, { type: "json", consistency: "strong" });
  const next = Number.isSafeInteger(meta?.data?.next) ? meta.data.next : WAREHOUSE_START;
  return { next, etag: meta?.etag || "", exists: !!meta?.etag };
}

/** Reserve the next perSheet numbers with a compare-and-swap loop. Returns the reserved range. */
async function reserveRange(count, meta) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await warehouseStore().getWithMetadata(COUNTER_KEY, { type: "json", consistency: "strong" });
    if (!current?.etag) {
      await warehouseStore().setJSON(COUNTER_KEY, { next: WAREHOUSE_START, createdAt: nowIso() }, { onlyIfNew: true });
      continue;
    }
    const from = Number.isSafeInteger(current.data?.next) ? current.data.next : WAREHOUSE_START;
    const to = from + count - 1;
    const write = await warehouseStore().setJSON(COUNTER_KEY, { ...current.data, next: to + 1, updatedAt: nowIso(), lastBy: meta.by }, { onlyIfMatch: current.etag });
    if (write?.modified === true) return { from, to };
    await pause(5 + Math.floor(Math.random() * 20 * Math.min(attempt + 1, 8)));
  }
  return null;
}

function idemKeyFor(actor, key) {
  return "idem/" + crypto.createHash("sha256").update(String(actor?.id || actor?.role || "") + "\n" + key).digest("hex").slice(0, 40);
}

export async function issueSheet(actor, body) {
  if (!canUseWarehouse(actor)) return { status: 403, error: "Warehouse Stickers access is not granted." };
  const key = String(body?.idempotencyKey || "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return { status: 400, error: "Missing request key. Reload the page and try again." };
  const idem = idemKeyFor(actor, key);
  const claim = await warehouseStore().setJSON(idem, { state: "pending", at: nowIso() }, { onlyIfNew: true });
  if (claim?.modified !== true) {
    for (let wait = 0; wait < 40; wait++) {
      const row = await warehouseStore().get(idem, { type: "json" });
      if (row?.state === "done") {
        const sheet = await warehouseStore().get(sheetKey(row.from), { type: "json" });
        if (sheet) return { status: 200, body: { sheet: publicSheet(sheet), codes: codesFor(sheet.from, sheet.to), replay: true } };
      }
      if (row?.state === "failed") break;
      await pause(150);
    }
    return { status: 409, error: "That press is still being processed. Refresh the history before pressing again." };
  }
  const meta = who(actor);
  const range = await reserveRange(LABEL_SHEET.perSheet, meta);
  if (!range) {
    await warehouseStore().setJSON(idem, { state: "failed", at: nowIso() });
    return { status: 503, error: "Busy. No numbers were used. Try again." };
  }
  const sheet = { from: range.from, to: range.to, by: meta.by, byId: meta.byId, at: nowIso(), layout: LABEL_SHEET.name, reprints: 0 };
  await warehouseStore().setJSON(sheetKey(range.from), sheet);
  await warehouseStore().setJSON(idem, { state: "done", from: range.from, at: sheet.at });
  return { status: 200, body: { sheet: publicSheet(sheet), codes: codesFor(sheet.from, sheet.to), replay: false } };
}

export async function listSheets(limit = 100) {
  const { blobs } = await warehouseStore().list({ prefix: "sheet/" });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  const rows = (await Promise.all(keys.map((k) => warehouseStore().get(k, { type: "json" })))).filter(Boolean);
  return { sheets: rows.map(publicSheet), total: blobs.length };
}

async function highestIssued() {
  const { blobs } = await warehouseStore().list({ prefix: "sheet/" });
  const keys = blobs.map((b) => b.key).sort();
  let top = 0;
  for (const k of keys.slice(-5)) {
    const row = await warehouseStore().get(k, { type: "json" });
    if (row && row.to > top) top = row.to;
  }
  return top;
}

async function audit(actor, action, detail) {
  const meta = who(actor);
  const row = { id: "a" + crypto.randomBytes(6).toString("hex"), at: nowIso(), action, by: meta.by, byId: meta.byId, ...detail };
  await warehouseStore().setJSON("audit/" + row.at + "-" + row.id, row);
  return row;
}

export async function listChanges(limit = 30) {
  const { blobs } = await warehouseStore().list({ prefix: "audit/" });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  return (await Promise.all(keys.map((k) => warehouseStore().get(k, { type: "json" })))).filter(Boolean);
}

/** Reprint regenerates exactly the stored range. The counter is not read or written. */
export async function reprintSheet(actor, id) {
  if (!canUseWarehouse(actor)) return { status: 403, error: "Warehouse Stickers access is not granted." };
  const from = Number(id);
  if (!Number.isSafeInteger(from) || from < 0) return { status: 404, error: "That sheet is not in the history." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await warehouseStore().getWithMetadata(sheetKey(from), { type: "json", consistency: "strong" });
    if (!meta?.etag) return { status: 404, error: "That sheet is not in the history." };
    const next = { ...meta.data, reprints: (meta.data.reprints || 0) + 1, lastReprintAt: nowIso(), lastReprintBy: who(actor).by };
    const write = await warehouseStore().setJSON(sheetKey(from), next, { onlyIfMatch: meta.etag });
    if (write?.modified !== true) continue;
    await audit(actor, "reprint", { first: codeFor(next.from), last: codeFor(next.to) });
    return { status: 200, body: { sheet: publicSheet(next), codes: codesFor(next.from, next.to), reprint: true } };
  }
  return { status: 409, error: "Try again." };
}

/** Admin: set the next number. Forward only, unless confirmBackward is true; every change is logged. */
export async function setNextNumber(actor, body) {
  if (!canAdminWarehouse(actor)) return { status: 403, error: "Only an admin can change the next number." };
  const raw = String(body?.next ?? "").trim().toUpperCase().replace(/^WH/, "");
  if (!/^\d{1,9}$/.test(raw)) return { status: 400, error: "Enter a whole number, for example 1500 or WH1500." };
  const target = Number(raw);
  if (target > NEXT_MAX) return { status: 400, error: "That number is too large." };
  for (let attempt = 0; attempt < 10; attempt++) {
    let current = await warehouseStore().getWithMetadata(COUNTER_KEY, { type: "json", consistency: "strong" });
    if (!current?.etag) {
      await warehouseStore().setJSON(COUNTER_KEY, { next: WAREHOUSE_START, createdAt: nowIso() }, { onlyIfNew: true });
      continue;
    }
    const was = Number.isSafeInteger(current.data?.next) ? current.data.next : WAREHOUSE_START;
    if (target === was) return { status: 200, body: { next: was, nextCode: codeFor(was), changed: false } };
    const backward = target < was;
    const issuedTop = await highestIssued();
    if (backward && body?.confirmBackward !== true) {
      return { status: 409, error: "The next number can only move forward. Moving back from " + codeFor(was) + " to " + codeFor(target) + (issuedTop >= target ? " would reissue codes already printed (up to " + codeFor(issuedTop) + ")" : " is not allowed without confirmation") + ". Tick the override and confirm to do it anyway.", needsConfirm: true, issuedTop: issuedTop ? codeFor(issuedTop) : "" };
    }
    const write = await warehouseStore().setJSON(COUNTER_KEY, { ...current.data, next: target, updatedAt: nowIso(), lastBy: who(actor).by }, { onlyIfMatch: current.etag });
    if (write?.modified !== true) continue;
    await audit(actor, "set-next", { fromCode: codeFor(was), toCode: codeFor(target), override: backward, reissueRisk: backward && issuedTop >= target });
    return { status: 200, body: { next: target, nextCode: codeFor(target), changed: true, override: backward } };
  }
  return { status: 409, error: "The number changed while saving. Try again." };
}

export async function warehouseOverview(actor) {
  if (!canUseWarehouse(actor)) return { status: 403, error: "Warehouse Stickers access is not granted." };
  const counter = await readCounter();
  const { sheets, total } = await listSheets(100);
  const admin = canAdminWarehouse(actor);
  return {
    status: 200,
    body: {
      next: counter.next,
      nextCode: codeFor(counter.next),
      prefix: WAREHOUSE_PREFIX,
      start: WAREHOUSE_START,
      layout: LABEL_SHEET,
      sheets,
      totalSheets: total,
      canAdmin: admin,
      changes: admin ? await listChanges(30) : [],
    },
  };
}
