import {
  codes, stats, visitorStore, recordHit, parseUA, readGeo, dayKey, lastNDays, collect, publicBase, DEFAULT_SETTINGS,
} from "./lib.mjs";
import { melbourneDay, visitorViewCapability } from "./visitor-log.mjs";
import { VISIT_SCAN_ENTRIES, visitScanEntry, visitScanReferrer } from "./visit-scan-paths.mjs";

let nowFn = () => new Date();
export function setVisitScanNow(fn) { nowFn = fn || (() => new Date()); }

const CODE_NOTES = "Counts page opens of the printed visitor QR code. This entry cannot be deleted. Sign-in and sign-out pages keep working even if the entry is removed.";

export function normalizeScanPeriod(period) {
  const p = String(period || "today").toLowerCase();
  if (p === "7" || p === "7days" || p === "week") return "7";
  if (p === "30" || p === "30days" || p === "month") return "30";
  return "today";
}

export function visitScanPeriodKeys(period, now = nowFn()) {
  const p = normalizeScanPeriod(period);
  const n = p === "30" ? 30 : p === "7" ? 7 : 1;
  return lastNDays(n, now);
}

function completionRate(completed, scans) {
  if (!scans) return null;
  return Math.round((completed / scans) * 100);
}

export function visitScanCodeRecord(kind, existing) {
  const entry = visitScanEntry(kind);
  if (!entry) return null;
  const created = existing?.created || nowFn().toISOString();
  return {
    slug: entry.slug,
    url: publicBase() + entry.path,
    name: entry.name,
    notes: existing?.notes || CODE_NOTES,
    paused: false,
    created,
    updated: existing?.updated || null,
    tags: Array.isArray(existing?.tags) && existing.tags.length ? existing.tags : ["Visitor Log"],
    hasQr: true,
    hasLink: false,
    qrMarker: false,
    destinationType: "url",
    style: existing?.style || { fg: DEFAULT_SETTINGS.defaultFg, bg: DEFAULT_SETTINGS.defaultBg },
    logoData: typeof existing?.logoData === "string" ? existing.logoData : "",
    rules: [],
    siteId: "",
    protected: true,
  };
}

export async function ensureVisitScanCode(kind) {
  const entry = visitScanEntry(kind);
  if (!entry) return null;
  const store = codes();
  const existing = await store.get(entry.slug, { type: "json" }).catch(() => null);
  if (existing && existing.protected !== true && existing.name !== entry.name) return existing;
  const next = visitScanCodeRecord(kind, existing && (existing.protected === true || existing.name === entry.name) ? existing : null);
  if (!existing || existing.protected !== true || existing.name !== entry.name || existing.url !== next.url) {
    await store.setJSON(entry.slug, next);
  }
  return next;
}

function hitFromRequest(req, context, body) {
  const ua = req.headers.get("user-agent") || "";
  const { os, device, browser } = parseUA(ua);
  const geo = readGeo(body?.geo || context?.geo || {});
  const at = nowFn();
  return {
    at: at.toISOString(),
    day: dayKey(at),
    channel: "scan",
    os,
    device,
    browser,
    country: geo.countryCode || geo.countryName || "Unknown",
    city: geo.city || "Unknown",
    referrer: visitScanReferrer(body?.referrer),
  };
}

/** Record one page open as a QR scan. Never stores an IP or a visitor hash. Failures are swallowed by the caller. */
export async function recordVisitPageScan(req, context, body = {}) {
  const entry = visitScanEntry(body.kind);
  if (!entry) return { status: 400, error: "Unknown visitor page" };
  await ensureVisitScanCode(entry.kind).catch(() => null);
  const prev = await stats().get(entry.slug, { type: "json" }).catch(() => null);
  const next = recordHit(prev, hitFromRequest(req, context, body));
  await stats().setJSON(entry.slug, next);
  return { status: 204 };
}

function countBody(name, scans, completed) {
  return { name, scans, completed, rate: completionRate(completed, scans) };
}

export async function visitScanStats(actor, period, now = nowFn()) {
  if (!(await visitorViewCapability(actor))) return { status: 403, error: "Visitor log access is not granted." };
  const p = normalizeScanPeriod(period);
  const keys = visitScanPeriodKeys(p, now);
  const set = new Set(keys);
  const [inRaw, outRaw, visitList] = await Promise.all([
    stats().get(VISIT_SCAN_ENTRIES["sign-in"].slug, { type: "json" }).catch(() => null),
    stats().get(VISIT_SCAN_ENTRIES["sign-out"].slug, { type: "json" }).catch(() => null),
    visitorStore().list({ prefix: "visit/" }),
  ]);
  let signIns = 0;
  let signOuts = 0;
  const blobs = visitList?.blobs || [];
  const rows = await Promise.all(blobs.map((blob) => visitorStore().get(blob.key, { type: "json" })));
  for (const row of rows) {
    if (!row || !row.id || row.deleted) continue;
    if (row.signedInAt && set.has(melbourneDay(row.signedInAt))) signIns += 1;
    if (row.signedOutAt && set.has(melbourneDay(row.signedOutAt))) signOuts += 1;
  }
  const inScans = collect(inRaw, keys, "scan").total;
  const outScans = collect(outRaw, keys, "scan").total;
  return {
    status: 200,
    body: {
      period: p,
      from: keys[0],
      to: keys[keys.length - 1],
      signIn: countBody(VISIT_SCAN_ENTRIES["sign-in"].name, inScans, signIns),
      signOut: countBody(VISIT_SCAN_ENTRIES["sign-out"].name, outScans, signOuts),
      note: "This counts page opens, which can include refreshes.",
    },
  };
}
