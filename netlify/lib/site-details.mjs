/**
 * Site details shown on the public visitor sign-in form: site type (VEA Retail, LOC CA or Unattended),
 * trading name, ABN, physical address, phone and map point.
 *
 * - One master site list (the existing `sites` store). The detail fields live on each site record.
 * - VEA Retail sites show Liberty's ABN and trading name from one central setting.
 * - LOC CA and Unattended sites show their own per-site ABN and trading name.
 * - Empty fields are simply left out, so nothing half-filled is shown.
 * - Visitor coordinates never reach this module: "Use my location" is worked out in the visitor's browser.
 * - Hide and remove are soft: the record stays, past sign-in snapshots are never rewritten.
 */
import crypto from "node:crypto";
import { settingsStore, sitesStore } from "./lib.mjs";
import { proposedUnattendedSites } from "./proposed-unattended-sites.mjs";
import { suburbFromAddress, validCoords } from "./tv.mjs";

export const SITE_TYPES = ["company", "commission_agent", "unattended"];
/** Visitor sign-in/sign-out picker: only these types. Retail sites stay in the master list. */
export const PICKER_SITE_TYPES = ["unattended"];
export const PICKER_SITE_TYPE = "unattended";
export const SITE_TYPE_LABEL = { company: "VEA Retail", commission_agent: "LOC CA", unattended: "Unattended" };
/** Only VEA Retail (and untyped sites, which count as VEA Retail) use the central trading name and ABN. LOC CA and Unattended use their own. */
export const usesCompanyDetails = (type) => type !== "commission_agent" && type !== "unattended";
export const DEFAULT_SITE_PHONE = "03 9113 7191";
export const COMPANY_KEY = "company-details";
export const PICKER_TYPES_KEY = "visitor-picker-types";
export const DEFAULT_PICKER_TYPES = ["unattended"];
export const CSV_COLUMNS = ["loc", "site_name", "site_type", "trading_name", "abn", "phone", "address", "lat", "lng"];
const SITE_ID = /^s[a-f0-9]{8}$/;
const CACHE_MS = 60 * 1000;
const GEOCODE_UA = "ExpressHelp-site-manager/1.0 (https://expresshelp.site; admin address geocode only; no visitor data)";
let cache = null;
let clock = () => Date.now();
let geocodeFetch = (...args) => fetch(...args);
let lastGeocodeAt = 0;
export function setSiteDetailHooks({ now = null, geocode = null } = {}) {
  clock = typeof now === "function" ? now : () => Date.now();
  if (geocode) geocodeFetch = geocode;
  lastGeocodeAt = 0;
  cache = null;
}
export function clearSiteDirectoryCache() { cache = null; }

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "commission agent", "Agent", "CA", "commission_agent" -> commission_agent; "Liberty", "company", "corporate" -> company. */
export function normaliseSiteType(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!text) return "";
  if (["company", "liberty", "corporate", "company_run", "company_site", "co", "vea", "vea_retail", "vea_retail_site"].includes(text)) return "company";
  if (["commission_agent", "agent", "commission", "ca", "commissionagent", "commission_agents", "loc_ca", "locca", "loc_ca_site"].includes(text)) return "commission_agent";
  if (["unattended", "unattended_site", "unattended_sites", "unmanned", "unattended_service_station", "unattended_service_stations"].includes(text)) return "unattended";
  return null;
}

/** Temporary placeholder Joshua asked to use for the shared VIVA Unattended ABN until the real number is known. Not a valid ABN. */
export const PLACEHOLDER_ABN = "1111";

/** Undo the leading apostrophe csvCell adds so Excel will not treat a value like -33.1 or +61… as a formula. */
export function unguardCsvCell(value) {
  const text = String(value ?? "");
  if (text.charAt(0) === "'" && /^[=+\-@\t]/.test(text.slice(1))) return text.slice(1);
  return text;
}

/** ABN: 11 digits that pass the ATO checksum, or the temporary placeholder 1111. Returns "12 345 678 901", "1111", "" for blank, or null when invalid. Spaces, dots and hyphens are ignored. Excel scientific notation for an 11-digit number is accepted. */
export function normaliseAbn(value) {
  let text = unguardCsvCell(String(value ?? "")).trim();
  const compact = text.replace(/\s/g, "");
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(compact)) {
    const n = Number(compact);
    if (Number.isFinite(n) && n >= 0 && Number.isInteger(n) && n <= 99999999999) text = String(Math.round(n));
  }
  const digits = text.replace(/[\s.\-]/g, "");
  if (!digits) return "";
  if (digits === PLACEHOLDER_ABN) return PLACEHOLDER_ABN;
  if (!/^\d{11}$/.test(digits)) return null;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = digits.split("").reduce((total, d, i) => total + (Number(d) - (i === 0 ? 1 : 0)) * weights[i], 0);
  if (sum % 89 !== 0) return null;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4");
}

/** Australian phone in one tidy shape ("03 9113 7191", "0412 345 678", "1300 123 456"). "" for blank, null when not a phone. */
export function normaliseSitePhone(value) {
  const text = unguardCsvCell(String(value ?? "")).trim();
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
 * What a visitor sees for one site. A site with no type yet counts as a VEA Retail site.
 * VEA Retail sites always use the central Liberty ABN / trading name (never a per-site one).
 * LOC CA and Unattended sites use the ABN and trading name stored on the site.
 */
export function displaySite(site, company, defaultPhone = DEFAULT_SITE_PHONE) {
  const f = siteDetailFields(site);
  const type = f.siteType || "company";
  const central = usesCompanyDetails(type);
  const tradingName = central ? company.tradingName : f.tradingName;
  const abn = central ? company.abn : f.abn;
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

function directoryBody(sites, extra = {}) {
  return { sites, total: sites.length, withCoordinates: sites.filter((s) => s.lat != null).length, ...extra };
}

/** Hidden or removed sites, and source-held sites, stay out of the visitor picker. Past sign-ins keep their snapshot. */
export function siteVisibility(site) {
  if (site?.hold) return "held";
  if (site?.visitorArchived) return "removed";
  if (site?.visitorHidden) return "hidden";
  return "visible";
}
export function isOfferedToVisitors(site) {
  return !!(site && site.name && !site.hold && !site.visitorHidden && !site.visitorArchived);
}

/** Which types appear in the visitor picker. Missing setting: Unattended only. An explicit empty list means none (typed entry only). */
export function normalisePickerTypes(value, { allowEmpty = false } = {}) {
  const raw = Array.isArray(value) ? value : Array.isArray(value?.types) ? value.types : value == null || value === "" ? null : String(value).split(",");
  if (raw == null) return allowEmpty ? [] : [...DEFAULT_PICKER_TYPES];
  const types = [...new Set(raw.map((item) => normaliseSiteType(item)).filter((t) => SITE_TYPES.includes(t)))];
  if (!types.length) return allowEmpty ? [] : [...DEFAULT_PICKER_TYPES];
  return types;
}
export async function readPickerTypes() {
  const raw = await settingsStore().get(PICKER_TYPES_KEY, { type: "json" }).catch(() => null);
  if (raw == null) return [...DEFAULT_PICKER_TYPES];
  return normalisePickerTypes(raw, { allowEmpty: true });
}
export async function savePickerTypes(body) {
  const types = normalisePickerTypes(body?.types ?? body, { allowEmpty: true });
  const next = { types, updatedAt: new Date(clock()).toISOString() };
  await settingsStore().setJSON(PICKER_TYPES_KEY, next);
  cache = null;
  return { status: 200, body: { types } };
}

/** Public directory: active sites only, display fields only. Cached for a minute.
 *  Pass picker:true for the visitor sign-in/sign-out list (types from the admin setting; Unattended only by default).
 *  Admin callers omit picker so the master list, including retail sites, is unchanged.
 *  Pass includeProposed:true on deploy previews to overlay the proposed Unattended list (never written). */
export async function publicSiteDirectory({ readFirstMaintenance, picker = false, includeProposed = false } = {}) {
  if (!(cache && clock() - cache.at < CACHE_MS)) {
    const [records, company, defaultPhone, pickerTypes] = await Promise.all([allSiteRecords(), readCompany(), defaultSitePhone(readFirstMaintenance), readPickerTypes()]);
    const sites = records.filter((r) => !r.hold && !r.visitorArchived).map((r) => displaySite(r, company, defaultPhone)).sort((a, b) => a.name.localeCompare(b.name));
    const offeredIds = new Set(records.filter(isOfferedToVisitors).map((r) => r.id));
    cache = { at: clock(), body: directoryBody(sites), offeredIds, company, defaultPhone, pickerTypes };
  }
  let body = cache.body;
  if (picker) {
    const types = cache.pickerTypes;
    const sites = body.sites.filter((s) => types.includes(s.type) && cache.offeredIds.has(s.id));
    body = directoryBody(sites, { picker: types.join(",") });
    if (includeProposed && types.includes("unattended")) body = mergeProposedUnattended(body, cache.body.sites, cache.company, cache.defaultPhone);
  }
  return body;
}

function loadProposedUnattendedRaw() {
  return Array.isArray(proposedUnattendedSites) ? proposedUnattendedSites : [];
}
function proposedId(index) {
  const hex = (0xe000000 + index).toString(16).slice(-8);
  return "s" + hex;
}
function mergeProposedUnattended(pickerBody, allLive, company, defaultPhone) {
  const taken = new Set((allLive || []).map((s) => (s.name || "").trim().toLowerCase()));
  const raw = loadProposedUnattendedRaw();
  const extra = [];
  raw.forEach((row, i) => {
    const name = clean(row.name, 120);
    if (!name || taken.has(name.toLowerCase())) return;
    const id = SITE_ID.test(String(row.id || "")) ? row.id : proposedId(i + 1);
    const view = displaySite({ ...row, siteType: "unattended", name, id }, company || {}, defaultPhone || DEFAULT_SITE_PHONE);
    view.proposed = true;
    extra.push(view);
    taken.add(name.toLowerCase());
  });
  const sites = pickerBody.sites.concat(extra).sort((a, b) => a.name.localeCompare(b.name));
  return directoryBody(sites, { picker: PICKER_SITE_TYPE, proposed: extra.length });
}

/** The snapshot stored on a sign-in: the site as shown at that moment, so later edits never rewrite history. */
export async function siteSnapshot(siteId, { readFirstMaintenance } = {}) {
  const id = String(siteId || "").trim();
  if (!SITE_ID.test(id)) return null;
  const record = await sitesStore().get(id, { type: "json" }).catch(() => null);
  if (!record || !isOfferedToVisitors(record)) return null;
  const view = displaySite(record, await readCompany(), await defaultSitePhone(readFirstMaintenance));
  return { siteId: view.id, loc: view.loc, name: view.name, siteType: view.type, tradingName: view.tradingName, abn: view.abn };
}
export const siteLabel = (snap) => snap ? snap.name + (snap.loc ? " (" + snap.loc + ")" : "") : "";

/* ---------- admin: CSV of the detail fields, dry run first ---------- */

/** Delimiter for a CSV body: comma, or semicolon / tab when the header has no commas (Excel in some locales). */
function detectCsvDelimiter(src) {
  let comma = 0, semi = 0, tab = 0, quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "\n" || ch === "\r") break;
    else if (ch === ",") comma++;
    else if (ch === ";") semi++;
    else if (ch === "\t") tab++;
  }
  if (comma === 0 && semi > 0 && semi >= tab) return ";";
  if (comma === 0 && tab > 0) return "\t";
  return ",";
}

/** Small RFC 4180 CSV reader: quotes, doubled quotes, commas and new lines inside quotes, CRLF, BOM. Semicolon or tab if the header has no commas. */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^\ufeff/, "");
  const delim = detectCsvDelimiter(src);
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
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
 * A blank cell leaves the field alone; the word CLEAR empties it. Existing sites are not renamed.
 * A row that matches no site is planned as a new site when it has a site_name (preview first, then Apply).
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
    const get = (key) => { const i = keys.indexOf(key); return i < 0 ? "" : unguardCsvCell(String(cells[i] ?? "")).trim(); };
    const errors = [], warnings = [];
    const loc = get("loc").toUpperCase();
    const name = get("site_name");
    const site = (loc && byLoc.get(loc)) || (!loc && name && byName.get(clean(name, 200).toLowerCase())) || null;
    let action = "update";
    if (!site) {
      const named = name ? byName.get(clean(name, 200).toLowerCase()) : null;
      if (!name) errors.push(loc ? "No site with LOC " + loc + "." : "No LOC or site name.");
      else if (loc && named) errors.push("LOC " + loc + " is new, but the name already belongs to \"" + named.name + "\"" + (named.loc ? " (" + named.loc + ")" : "") + ". Not added or changed.");
      else if (seen.has("name:" + clean(name, 200).toLowerCase())) errors.push("A new site with this name is already in an earlier row.");
      else if (loc && seen.has("loc:" + loc)) errors.push("A new site with this LOC is already in an earlier row.");
      else action = "add";
    } else if (seen.has(site.id)) errors.push("This site is already in an earlier row.");
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
      if (type === null) errors.push("site_type must be company, commission_agent or unattended.");
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
    if ((nextType || "company") === "company" && (tn && tn.toUpperCase() !== CLEAR || abnRaw && abnRaw.toUpperCase() !== CLEAR)) warnings.push("VEA Retail sites show the central company ABN and trading name; this row's own ABN / trading name are saved but not shown.");
    if ((nextType === "commission_agent" || nextType === "unattended") && (!nextTn || !nextAbn)) warnings.push((nextType === "unattended" ? "Unattended" : "LOC CA") + " site without " + (!nextTn && !nextAbn ? "trading name or ABN" : !nextTn ? "trading name" : "ABN") + " yet; the missing part is hidden on the form.");
    if (action === "add" && !nextType) warnings.push("This new site has no site_type; it will be shown as VEA Retail and will not appear in the visitor picker.");
    if (site) seen.add(site.id);
    else if (action === "add") {
      if (name) seen.add("name:" + clean(name, 200).toLowerCase());
      if (loc) seen.add("loc:" + loc);
    }
    const ref = site ? { id: site.id, loc: site.loc || "", name: site.name } : action === "add" ? { id: "", loc: loc || "", name: clean(name, 120), added: true } : null;
    plan.push({ line, action, site: ref, changes, patch: errors.length ? {} : patch, errors, warnings });
  });
  const summary = {
    rows: plan.length,
    matched: plan.filter((p) => p.site && !p.site.added).length,
    added: plan.filter((p) => p.action === "add" && !p.errors.length).length,
    changed: plan.filter((p) => p.action !== "add" && !p.errors.length && Object.keys(p.changes).length).length,
    unchanged: plan.filter((p) => !p.errors.length && p.site && !p.site.added && !Object.keys(p.changes).length).length,
    errors: plan.filter((p) => p.errors.length).length,
  };
  summary.willWrite = summary.added + summary.changed;
  return { plan, summary, ignoredColumns: unknown };
}

export async function previewDetailImport(csvText) {
  return planDetailImport(await allSiteRecords(), csvText);
}

function locGateKey(loc) {
  return "loc/" + crypto.createHash("sha256").update(String(loc).trim().toUpperCase()).digest("hex");
}
async function allocateSiteId(store) {
  for (let i = 0; i < 8; i++) {
    const id = "s" + crypto.randomBytes(4).toString("hex");
    const existing = await store.get(id, { type: "json" }).catch(() => null);
    if (!existing) return id;
  }
  return "";
}

/** Writes only rows without errors, one site record at a time, keeping every other field on the record. New unmatched rows are created. */
export async function applyDetailImport(csvText) {
  const store = sitesStore();
  const report = planDetailImport(await allSiteRecords(), csvText);
  if (report.error) return report;
  let written = 0;
  for (const row of report.plan) {
    if (row.errors.length) continue;
    if (row.action === "add") {
      const created = await createSiteFromImport(store, row);
      if (created.error) { row.errors.push(created.error); row.patch = {}; continue; }
      row.site = created.site;
      written += 1;
      continue;
    }
    if (!row.site || !Object.keys(row.patch).length) continue;
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
  report.summary.errors = report.plan.filter((p) => p.errors.length).length;
  return { ...report, written };
}

async function createSiteFromImport(store, row) {
  const id = await allocateSiteId(store);
  if (!id) return { error: "Could not allocate a new site id." };
  const loc = row.site?.loc || "";
  const now = new Date(clock()).toISOString();
  const site = { id, name: row.site.name, created: now, loc, detailsUpdatedAt: now };
  for (const [field, value] of Object.entries(row.patch)) {
    if (value === "" || value === null) continue;
    site[field] = value;
  }
  if (loc) {
    const gate = await store.setJSON(locGateKey(loc), { id }, { onlyIfNew: true });
    if (gate && gate.modified === false) return { error: "LOC " + loc + " was taken while applying." };
  }
  const saved = await store.setJSON(id, site, { onlyIfNew: true });
  if (saved && saved.modified === false) {
    if (loc) await store.delete(locGateKey(loc)).catch(() => {});
    return { error: "Could not store the new site." };
  }
  return { site: { id, loc, name: site.name } };
}

function csvCell(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  // Plain numbers such as -37.8136 are safe in Excel (it stores them as numbers). Only guard
  // formula-like values. Import strips this apostrophe so a downloaded file can be uploaded again.
  const plainNumber = /^-?(?:\d+\.?\d*|\.\d+)$/.test(text);
  const safe = !plainNumber && /^[=+\-@\t]/.test(text) ? "'" + text : text;
  return /[",]/.test(safe) || safe !== text ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
/**
 * Types to include in the site-details CSV. Missing/undefined means every type (the previous behaviour).
 * Accepts a string, comma-separated list, or array; labels such as "Unattended" and "LOC CA" are allowed.
 * Untyped sites count as VEA Retail (company), matching how they are shown.
 */
export function parseCsvTypes(raw) {
  if (raw == null) return { types: ["company", "commission_agent", "unattended"] };
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => String(value).split(/[,+]/)).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { error: "Tick at least one site type: Unattended, LOC CA or VEA Retail." };
  const types = [];
  for (const part of parts) {
    const type = normaliseSiteType(part);
    if (!type) return { error: "Site type \"" + part + "\" is not valid. Use unattended, commission_agent (LOC CA) or company (VEA Retail)." };
    if (!types.includes(type)) types.push(type);
  }
  return { types };
}

/** Bucket used when filtering the CSV: a site with no type counts as VEA Retail. */
export function csvTypeBucket(site) {
  return siteDetailFields(site).siteType || "company";
}

/** Current site list as the import CSV, so it can be filled in and brought back. Hidden sites are included; removed and held sites are not. */
export async function detailCsv(types) {
  const parsed = parseCsvTypes(types === undefined ? undefined : types);
  if (parsed.error) return parsed;
  const allow = new Set(parsed.types);
  const records = (await allSiteRecords()).filter((r) => !r.hold && !r.visitorArchived && allow.has(csvTypeBucket(r))).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of records) {
    const f = siteDetailFields(r);
    lines.push([r.loc || "", r.name, f.siteType, f.tradingName, f.abn, f.phone, f.address, f.lat ?? "", f.lng ?? ""].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

function adminSiteView(r, pickerTypes) {
  const f = siteDetailFields(r);
  const visibility = siteVisibility(r);
  const type = f.siteType || "company";
  return {
    ...f,
    id: r.id,
    loc: r.loc || "",
    name: r.name,
    hidden: !!r.visitorHidden,
    archived: !!r.visitorArchived,
    hold: !!r.hold,
    visibility,
    inPicker: isOfferedToVisitors(r) && pickerTypes.includes(type),
  };
}

/** Admin view: every site (including hidden and removed) with stored fields, visibility and picker setting. */
export async function adminSiteDetails({ readFirstMaintenance } = {}) {
  const [records, company, defaultPhone, pickerTypes] = await Promise.all([allSiteRecords(), readCompany(), defaultSitePhone(readFirstMaintenance), readPickerTypes()]);
  const sites = records.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((r) => adminSiteView(r, pickerTypes));
  const active = sites.filter((s) => !s.archived && !s.hold);
  const counts = {
    total: active.length,
    company: active.filter((s) => s.siteType === "company").length,
    agents: active.filter((s) => s.siteType === "commission_agent").length,
    unattended: active.filter((s) => s.siteType === "unattended").length,
    untyped: active.filter((s) => !s.siteType).length,
    withCoordinates: active.filter((s) => s.lat != null).length,
    phoneOverrides: active.filter((s) => s.phone).length,
    hidden: sites.filter((s) => s.visibility === "hidden").length,
    removed: sites.filter((s) => s.visibility === "removed").length,
    held: sites.filter((s) => s.visibility === "held").length,
    all: sites.length,
  };
  return { company, defaultPhone, columns: CSV_COLUMNS, counts, sites, pickerTypes };
}


/* ---------- admin: add, edit, hide, remove, geocode ---------- */

export function parseSiteInput(body) {
  const errors = [];
  const name = clean(body?.name, 120);
  if (!name) errors.push("A site name is required.");
  const loc = clean(body?.loc ?? body?.siteNumber, 40).toUpperCase();
  let siteType = "";
  if (body?.siteType != null && String(body.siteType).trim() !== "") {
    const type = normaliseSiteType(body.siteType);
    if (!type) errors.push("Type must be VEA Retail, LOC CA or Unattended.");
    else siteType = type;
  }
  const tradingName = clean(body?.tradingName, 120);
  let abn = "";
  if (body?.abn != null && String(body.abn).trim() !== "") {
    abn = normaliseAbn(body.abn);
    if (abn === null) errors.push("That ABN is not valid. It needs 11 digits that pass the ABN check.");
    else abn = abn || "";
  }
  let phone = "";
  if (body?.phone != null && String(body.phone).trim() !== "") {
    phone = normaliseSitePhone(body.phone);
    if (phone === null) errors.push("That phone number is not valid.");
    else phone = phone || "";
  }
  const address = clean(body?.address, 240);
  let lat = null, lng = null;
  const latBlank = body?.lat == null || String(body.lat).trim() === "";
  const lngBlank = body?.lng == null || String(body.lng).trim() === "";
  if (!latBlank || !lngBlank) {
    const coords = validCoords(body?.lat, body?.lng);
    if (!coords) errors.push("lat/lng must both be set to a point in Australia (for example -37.8136, 144.9631).");
    else { lat = coords.lat; lng = coords.lng; }
  }
  return { errors, name, loc, fields: { siteType, tradingName, abn, phone, address, lat, lng } };
}

async function uniquenessError(id, name, loc) {
  const records = await allSiteRecords();
  const nameKey = clean(name, 120).toLowerCase();
  const nameClash = records.find((r) => r.id !== id && clean(r.name, 120).toLowerCase() === nameKey);
  if (nameClash) return nameClash.visitorArchived ? "A removed site already uses that name. Restore it or change that site first." : "A site with that name already exists.";
  if (loc) {
    const locClash = records.find((r) => r.id !== id && String(r.loc || "").trim().toUpperCase() === loc);
    if (locClash) return locClash.visitorArchived ? "A removed site already uses that site number. Restore it or change that site first." : "A site with that site number already exists.";
  }
  return "";
}

async function loadManagedSite(id) {
  if (!SITE_ID.test(String(id || ""))) return null;
  const record = await sitesStore().get(id, { type: "json" }).catch(() => null);
  return record && SITE_ID.test(String(record.id || "")) && record.name ? record : null;
}

async function viewed(record) {
  return adminSiteView(record, await readPickerTypes());
}

async function setLocGate(store, id, loc, previous = "") {
  const next = String(loc || "").trim().toUpperCase();
  const prev = String(previous || "").trim().toUpperCase();
  if (next === prev) return "";
  if (next) {
    const gate = await store.setJSON(locGateKey(next), { id }, { onlyIfNew: true });
    if (gate && gate.modified === false) return "That site number was taken while saving.";
  }
  if (prev) await store.delete(locGateKey(prev)).catch(() => {});
  return "";
}

function applyFields(site, parsed) {
  const next = { ...site, name: parsed.name, detailsUpdatedAt: new Date(clock()).toISOString() };
  if (parsed.loc) next.loc = parsed.loc;
  else delete next.loc;
  for (const [field, value] of Object.entries(parsed.fields)) {
    if (value === "" || value == null) delete next[field];
    else next[field] = value;
  }
  return next;
}

/** Create a site on the master list. Never touches visit records. */
export async function createVisitorSite(body) {
  const parsed = parseSiteInput(body);
  if (!parsed.fields.siteType) parsed.errors.push("Choose a site type.");
  if (parsed.errors.length) return { status: 400, error: parsed.errors[0], errors: parsed.errors };
  const clash = await uniquenessError("", parsed.name, parsed.loc);
  if (clash) return { status: 409, error: clash };
  const store = sitesStore();
  const id = await allocateSiteId(store);
  if (!id) return { status: 500, error: "Could not allocate a new site id." };
  const gateError = await setLocGate(store, id, parsed.loc);
  if (gateError) return { status: 409, error: gateError };
  const now = new Date(clock()).toISOString();
  const site = applyFields({ id, created: now }, parsed);
  const saved = await store.setJSON(id, site, { onlyIfNew: true });
  if (saved && saved.modified === false) {
    if (parsed.loc) await store.delete(locGateKey(parsed.loc)).catch(() => {});
    return { status: 500, error: "Could not store the new site." };
  }
  cache = null;
  return { status: 201, body: await viewed(site) };
}

/** Update name, site number, type, address, phone, ABN, trading name and map point. Past sign-ins keep their snapshot. */
export async function updateVisitorSite(id, body) {
  const current = await loadManagedSite(id);
  if (!current) return { status: 404, error: "That site was not found." };
  if (current.hold) return { status: 400, error: "Held sites are managed in the head-office site import, not here." };
  const parsed = parseSiteInput(body);
  if (!parsed.fields.siteType) parsed.errors.push("Choose a site type.");
  if (parsed.errors.length) return { status: 400, error: parsed.errors[0], errors: parsed.errors };
  const clash = await uniquenessError(current.id, parsed.name, parsed.loc);
  if (clash) return { status: 409, error: clash };
  const store = sitesStore();
  const gateError = await setLocGate(store, current.id, parsed.loc, current.loc);
  if (gateError) return { status: 409, error: gateError };
  const next = applyFields(current, parsed);
  await store.setJSON(current.id, next);
  cache = null;
  return { status: 200, body: await viewed(next) };
}

/** Soft hide or unhide. Hidden sites leave the visitor picker; history is unchanged. */
export async function setSiteHidden(id, hidden) {
  const current = await loadManagedSite(id);
  if (!current) return { status: 404, error: "That site was not found." };
  if (current.hold) return { status: 400, error: "Held sites are managed in the head-office site import, not here." };
  if (current.visitorArchived) return { status: 400, error: "Restore the site before hiding or unhiding it." };
  const next = { ...current, detailsUpdatedAt: new Date(clock()).toISOString() };
  if (hidden) { next.visitorHidden = true; next.visitorHiddenAt = new Date(clock()).toISOString(); }
  else { delete next.visitorHidden; delete next.visitorHiddenAt; }
  await sitesStore().setJSON(current.id, next);
  cache = null;
  return { status: 200, body: await viewed(next) };
}

/** Soft remove (archive) or restore. Never deletes the record or any sign-in. */
export async function setSiteArchived(id, { archived, confirm } = {}) {
  const current = await loadManagedSite(id);
  if (!current) return { status: 404, error: "That site was not found." };
  if (current.hold) return { status: 400, error: "Held sites are managed in the head-office site import, not here." };
  if (archived && confirm !== "REMOVE") return { status: 400, error: "Confirm to remove this site. Past sign-ins are not changed." };
  const next = { ...current, detailsUpdatedAt: new Date(clock()).toISOString() };
  if (archived) { next.visitorArchived = true; next.visitorArchivedAt = new Date(clock()).toISOString(); }
  else { delete next.visitorArchived; delete next.visitorArchivedAt; }
  await sitesStore().setJSON(current.id, next);
  cache = null;
  return { status: 200, body: await viewed(next) };
}

/** Look up a map point from an address only (Nominatim, 1 request/s). No visitor data, nothing stored. */
export async function geocodeSiteAddress(address) {
  const q = clean(address, 240);
  if (!q) return { status: 400, error: "Enter an address first." };
  if (lastGeocodeAt) {
    const wait = 1000 - (clock() - lastGeocodeAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastGeocodeAt = clock();
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=" + encodeURIComponent(q);
  let res;
  try { res = await geocodeFetch(url, { headers: { "User-Agent": GEOCODE_UA, Accept: "application/json" } }); }
  catch { return { status: 502, error: "The map lookup could not be reached." }; }
  if (!res || !res.ok) return { status: 502, error: "The map lookup could not be reached." };
  const rows = await res.json().catch(() => []);
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit) return { status: 404, error: "No map point was found for that address." };
  const coords = validCoords(hit.lat, hit.lon ?? hit.lng);
  if (!coords) return { status: 404, error: "That address did not resolve to a point in Australia." };
  return { status: 200, body: { lat: coords.lat, lng: coords.lng, label: clean(hit.display_name, 240) } };
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
