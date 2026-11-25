/**
 * Site details shown on the public visitor sign-in form: site type (Liberty company site or commission agent),
 * trading name, ABN, physical address, phone and map point.
 *
 * - One master site list (the existing `sites` store). The detail fields live on each site record.
 * - Company sites show Liberty's ABN and trading name from one central setting; agent sites show their own.
 * - Empty fields are simply left out, so nothing half-filled is shown.
 * - Visitor coordinates never reach this module: "Use my location" is worked out in the visitor's browser.
 */
import { settingsStore, sitesStore } from "./lib.mjs";
import { suburbFromAddress, validCoords } from "./tv.mjs";

export const SITE_TYPES = ["company", "commission_agent"];
export const DEFAULT_SITE_PHONE = "03 9113 7191";
export const COMPANY_KEY = "company-details";
export const CSV_COLUMNS = ["loc", "site_name", "site_type", "trading_name", "abn", "phone", "address", "lat", "lng"];
const SITE_ID = /^s[a-f0-9]{8}$/;
const CACHE_MS = 60 * 1000;
let cache = null;
let clock = () => Date.now();
export function setSiteDetailHooks({ now = null } = {}) { clock = typeof now === "function" ? now : () => Date.now(); cache = null; }
export function clearSiteDirectoryCache() { cache = null; }

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "commission agent", "Agent", "CA", "commission_agent" -> commission_agent; "Liberty", "company", "corporate" -> company. */
export function normaliseSiteType(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!text) return "";
  if (["company", "liberty", "corporate", "company_run", "company_site", "co", "vea", "vea_retail", "vea_retail_site"].includes(text)) return "company";
  if (["commission_agent", "agent", "commission", "ca", "commissionagent", "commission_agents", "loc_ca", "locca", "loc_ca_site"].includes(text)) return "commission_agent";
  return null;
}

/** ABN: 11 digits that pass the ATO checksum. Returns "12 345 678 901", "" for blank, or null when invalid. */
export function normaliseAbn(value) {
  const digits = String(value ?? "").replace(/[\s.\-]/g, "");
  if (!digits) return "";
  if (!/^\d{11}$/.test(digits)) return null;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = digits.split("").reduce((total, d, i) => total + (Number(d) - (i === 0 ? 1 : 0)) * weights[i], 0);
  if (sum % 89 !== 0) return null;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4");
}

/** Australian phone in one tidy shape ("03 9113 7191", "0412 345 678", "1300 123 456"). "" for blank, null when not a phone. */
export function normaliseSitePhone(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^\+?[0-9 ()\-.]+$/.test(text)) return null;
  let digits = text.replace(/^\s*(\+|00)/, "").replace(/\D/g, "");
  const plus = /^\s*(\+|00)/.test(text);
  if (digits.length < 6 || digits.length > 15) return null;
  if (/^61[2-478]\d{8}$/.test(digits) && (plus || digits.length === 11)) digits = "0" + digits.slice(2);
  if (/^04\d{8}$/.test(digits)) return digits.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  if (/^0[2378]\d{8}$/.test(digits)) return digits.replace(/^(\d{2})(\d{4})(\d{4})$/, "$1 $2 $3");
  if (/^1[38]00\d{6}$/.test(digits)) return digits.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  if (/^13\d{4}$/.test(digits)) return digits.replace(/^(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3");
  return (plus ? "+" : "") + digits;
}
export const phoneHref = (display) => display ? "tel:" + (display.startsWith("+") ? "+" : "") + display.replace(/\D/g, "") : "";

export function cleanCompany(raw) {
  const abn = normaliseAbn(raw?.abn);
  return { abn: abn || "", tradingName: clean(raw?.tradingName, 120) };
}
export async function readCompany() {
  return cleanCompany(await settingsStore().get(COMPANY_KEY, { type: "json" }).catch(() => null));
}
export async function saveCompany(body) {
  const abn = normaliseAbn(body?.abn);
  if (abn === null) return { status: 400, error: "That ABN is not valid. It needs 11 digits that pass the ABN check." };
  const tradingName = clean(body?.tradingName, 120);
  const next = { abn, tradingName, updatedAt: new Date(clock()).toISOString() };
  await settingsStore().setJSON(COMPANY_KEY, next);
  cache = null;
  return { status: 200, body: cleanCompany(next) };
}

/** The detail fields as stored on one site record (unknown or bad values are dropped). */
export function siteDetailFields(site) {
  const type = normaliseSiteType(site?.siteType);
  const abn = normaliseAbn(site?.abn);
  const phone = normaliseSitePhone(site?.phone);
  const coords = validCoords(site?.lat ?? site?.latitude, site?.lng ?? site?.lon ?? site?.longitude);
  return {
    siteType: type || "",
    tradingName: clean(site?.tradingName, 120),
    abn: abn || "",
    phone: phone || "",
    address: clean(site?.address, 240),
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
  };
}

/**
 * What a visitor sees for one site. A site with no type yet counts as a Liberty company site.
 * Company sites always use the central Liberty ABN / trading name (never a per-site one).
 */
export function displaySite(site, company, defaultPhone = DEFAULT_SITE_PHONE) {
  const f = siteDetailFields(site);
  const type = f.siteType || "company";
  const tradingName = type === "company" ? company.tradingName : f.tradingName;
  const abn = type === "company" ? company.abn : f.abn;
  const phone = f.phone || defaultPhone || "";
  const out = { id: site.id, loc: clean(site.loc, 40), name: clean(site.name, 120), suburb: suburbFromAddress(site.address), type, address: f.address, tradingName, abn, phone, phoneHref: phoneHref(phone) };
  if (f.lat != null) { out.lat = f.lat; out.lng = f.lng; }
  return out;
}

async function allSiteRecords() {
  const store = sitesStore();
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.filter((b) => SITE_ID.test(b.key)).map((b) => store.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter((r) => r && SITE_ID.test(String(r.id || "")) && r.name);
}

/** The default phone: the first visitor maintenance line when one is set, otherwise 03 9113 7191. */
export async function defaultSitePhone(readFirstMaintenance) {
  const first = readFirstMaintenance ? await readFirstMaintenance().catch(() => "") : "";
  return normaliseSitePhone(first) || DEFAULT_SITE_PHONE;
}

/** Public directory for the visitor forms: active sites only, display fields only. Cached for a minute. */
export async function publicSiteDirectory({ readFirstMaintenance } = {}) {
  if (cache && clock() - cache.at < CACHE_MS) return cache.body;
  const [records, company, defaultPhone] = await Promise.all([allSiteRecords(), readCompany(), defaultSitePhone(readFirstMaintenance)]);
  const sites = records.filter((r) => !r.hold).map((r) => displaySite(r, company, defaultPhone)).sort((a, b) => a.name.localeCompare(b.name));
  const body = { sites, total: sites.length, withCoordinates: sites.filter((s) => s.lat != null).length };
  cache = { at: clock(), body };
  return body;
}

/** The snapshot stored on a sign-in: the site as shown at that moment, so later edits never rewrite history. */
export async function siteSnapshot(siteId, { readFirstMaintenance } = {}) {
  const id = String(siteId || "").trim();
  if (!SITE_ID.test(id)) return null;
  const record = await sitesStore().get(id, { type: "json" }).catch(() => null);
  if (!record || !record.name || record.hold) return null;
  const view = displaySite(record, await readCompany(), await defaultSitePhone(readFirstMaintenance));
  return { siteId: view.id, loc: view.loc, name: view.name, siteType: view.type, tradingName: view.tradingName, abn: view.abn };
}
export const siteLabel = (snap) => snap ? snap.name + (snap.loc ? " (" + snap.loc + ")" : "") : "";

/* ---------- admin: CSV of the detail fields, dry run first ---------- */

/** Small RFC 4180 CSV reader: quotes, doubled quotes, commas and new lines inside quotes, CRLF, BOM. */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^\ufeff/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const HEADER_ALIASES = {
  loc: ["loc", "loc_id", "locid", "site_number", "site_no", "site_code", "number", "code"],
  site_name: ["site_name", "name", "site"],
  site_type: ["site_type", "type"],
  trading_name: ["trading_name", "tradingname", "business_name", "entity_name"],
  abn: ["abn"],
  phone: ["phone", "phone_number", "site_phone"],
  address: ["address", "physical_address", "site_address"],
  lat: ["lat", "latitude"],
  lng: ["lng", "lon", "long", "longitude"],
};
function headerKey(cell) {
  const k = String(cell || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return Object.keys(HEADER_ALIASES).find((key) => HEADER_ALIASES[key].includes(k)) || "";
}
export const CLEAR = "CLEAR";

/**
 * Plans an import without writing. Rows match an existing site by LOC, otherwise by exact site name.
 * A blank cell leaves the field alone; the word CLEAR empties it. Nothing is created or renamed.
 */
export function planDetailImport(records, csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { error: "The CSV is empty." };
  if (rows.length > 501) return { error: "Too many rows (500 at most)." };
  const keys = rows[0].map(headerKey);
  if (!keys.includes("loc") && !keys.includes("site_name")) return { error: "The first row must be the column names, with loc or site_name. Expected: " + CSV_COLUMNS.join(",") };
  const unknown = rows[0].filter((cell, i) => cell.trim() && !keys[i]);
  const byLoc = new Map(), byName = new Map();
  for (const r of records) {
    if (r.loc) byLoc.set(String(r.loc).trim().toUpperCase(), r);
    byName.set(clean(r.name, 200).toLowerCase(), r);
  }
  const seen = new Set();
  const plan = [];
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const get = (key) => { const i = keys.indexOf(key); return i < 0 ? "" : String(cells[i] ?? "").trim(); };
    const errors = [], warnings = [];
    const loc = get("loc").toUpperCase();
    const name = get("site_name");
    const site = (loc && byLoc.get(loc)) || (!loc && name && byName.get(clean(name, 200).toLowerCase())) || null;
    if (!site) errors.push(loc ? "No site with LOC " + loc + "." : name ? "No site named \"" + name + "\"." : "No LOC or site name.");
    else if (seen.has(site.id)) errors.push("This site is already in an earlier row.");
    if (site && loc && name && clean(name, 200).toLowerCase() !== clean(site.name, 200).toLowerCase()) warnings.push("Name differs from the site list (\"" + site.name + "\"); the site is not renamed.");
    const current = site ? siteDetailFields(site) : siteDetailFields({});
    const patch = {}, changes = {};
    const set = (field, next, shown) => {
      const before = current[field] ?? "";
      if (String(before ?? "") !== String(next ?? "")) { patch[field] = next; changes[shown || field] = [before ?? "", next ?? ""]; }
    };
    const typeRaw = get("site_type");
    if (typeRaw) {
      const type = typeRaw.toUpperCase() === CLEAR ? "" : normaliseSiteType(typeRaw);
      if (type === null) errors.push("site_type must be company or commission_agent.");
      else set("siteType", type, "site_type");
    }
    const tn = get("trading_name");
    if (tn) set("tradingName", tn.toUpperCase() === CLEAR ? "" : clean(tn, 120), "trading_name");
    const abnRaw = get("abn");
    if (abnRaw) {
      const abn = abnRaw.toUpperCase() === CLEAR ? "" : normaliseAbn(abnRaw);
      if (abn === null) errors.push("ABN " + abnRaw + " is not valid (11 digits that pass the ABN check).");
      else set("abn", abn);
    }
    const phoneRaw = get("phone");
    if (phoneRaw) {
      const phone = phoneRaw.toUpperCase() === CLEAR ? "" : normaliseSitePhone(phoneRaw);
      if (phone === null) errors.push("Phone " + phoneRaw + " is not valid.");
      else set("phone", phone);
    }
    const address = get("address");
    if (address) set("address", address.toUpperCase() === CLEAR ? "" : clean(address, 240));
    const latRaw = get("lat"), lngRaw = get("lng");
    if (latRaw || lngRaw) {
      if (latRaw.toUpperCase() === CLEAR || lngRaw.toUpperCase() === CLEAR) { set("lat", null); set("lng", null); }
      else {
        const coords = validCoords(latRaw, lngRaw);
        if (!coords) errors.push("lat/lng must both be set to a point in Australia (for example -37.8136, 144.9631).");
        else { set("lat", coords.lat); set("lng", coords.lng); }
      }
    }
    const nextType = "siteType" in patch ? patch.siteType : current.siteType;
    const nextTn = "tradingName" in patch ? patch.tradingName : current.tradingName;
    const nextAbn = "abn" in patch ? patch.abn : current.abn;
    if (nextType !== "commission_agent" && (tn && tn.toUpperCase() !== CLEAR || abnRaw && abnRaw.toUpperCase() !== CLEAR)) warnings.push("VEA Retail sites show the central company ABN and trading name; this row's own ABN / trading name are saved but not shown.");
    if (nextType === "commission_agent" && (!nextTn || !nextAbn)) warnings.push("LOC CA site without " + (!nextTn && !nextAbn ? "trading name or ABN" : !nextTn ? "trading name" : "ABN") + " yet; the missing part is hidden on the form.");
    if (site) seen.add(site.id);
    plan.push({ line, site: site ? { id: site.id, loc: site.loc || "", name: site.name } : null, changes, patch: errors.length ? {} : patch, errors, warnings });
  });
  const summary = {
    rows: plan.length,
    matched: plan.filter((p) => p.site).length,
    changed: plan.filter((p) => !p.errors.length && Object.keys(p.changes).length).length,
    unchanged: plan.filter((p) => !p.errors.length && p.site && !Object.keys(p.changes).length).length,
    errors: plan.filter((p) => p.errors.length).length,
  };
  return { plan, summary, ignoredColumns: unknown };
}

export async function previewDetailImport(csvText) {
  return planDetailImport(await allSiteRecords(), csvText);
}

/** Writes only rows without errors, one site record at a time, keeping every other field on the record. */
export async function applyDetailImport(csvText) {
  const store = sitesStore();
  const report = planDetailImport(await allSiteRecords(), csvText);
  if (report.error) return report;
  let written = 0;
  for (const row of report.plan) {
    if (!row.site || row.errors.length || !Object.keys(row.patch).length) continue;
    const current = await store.get(row.site.id, { type: "json" });
    if (!current) continue;
    const next = { ...current };
    for (const [field, value] of Object.entries(row.patch)) {
      if (value === "" || value === null) delete next[field];
      else next[field] = value;
    }
    next.detailsUpdatedAt = new Date(clock()).toISOString();
    await store.setJSON(row.site.id, next);
    written += 1;
  }
  cache = null;
  return { ...report, written };
}

function csvCell(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  const safe = /^[=+\-@\t]/.test(text) ? "'" + text : text;
  return /[",]/.test(safe) || safe !== text ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
/** Current site list as the import CSV, so it can be filled in and brought back. */
export async function detailCsv() {
  const records = (await allSiteRecords()).filter((r) => !r.hold).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of records) {
    const f = siteDetailFields(r);
    lines.push([r.loc || "", r.name, f.siteType, f.tradingName, f.abn, f.phone, f.address, f.lat ?? "", f.lng ?? ""].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Admin view: every active site with its stored fields and what the form shows. */
export async function adminSiteDetails({ readFirstMaintenance } = {}) {
  const [records, company, defaultPhone] = await Promise.all([allSiteRecords(), readCompany(), defaultSitePhone(readFirstMaintenance)]);
  const sites = records.filter((r) => !r.hold).sort((a, b) => String(a.name).localeCompare(String(b.name))).map((r) => ({ ...siteDetailFields(r), id: r.id, loc: r.loc || "", name: r.name }));
  const counts = { total: sites.length, company: sites.filter((s) => s.siteType === "company").length, agents: sites.filter((s) => s.siteType === "commission_agent").length, untyped: sites.filter((s) => !s.siteType).length, withCoordinates: sites.filter((s) => s.lat != null).length, phoneOverrides: sites.filter((s) => s.phone).length };
  return { company, defaultPhone, columns: CSV_COLUMNS, counts, sites };
}

/* ---------- log filters ---------- */

/** Every visit maps to one bucket. Visits from before site tagging have no type: they are "untagged" and sit with company sites. */
export function visitSiteType(visit) {
  const t = normaliseSiteType(visit?.site?.siteType);
  return t || "untagged";
}
/** Stable key for one commission agent: ABN when known, otherwise the trading name, otherwise the site. */
export function agentKey(snap) {
  if (!snap) return "";
  const abn = String(snap.abn || "").replace(/\D/g, "");
  if (abn) return "abn:" + abn;
  const tn = clean(snap.tradingName, 120).toLowerCase();
  if (tn) return "name:" + tn;
  return snap.siteId ? "site:" + snap.siteId : "";
}
export function agentLabel(snap) {
  return clean(snap?.tradingName, 120) || (snap?.name ? snap.name + " (LOC CA, trading name not set)" : "LOC CA");
}
