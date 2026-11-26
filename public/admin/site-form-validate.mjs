/**
 * Client-side checks for the Sites add/edit dialog and the VEA Retail company form.
 * Messages and ABN, phone, email and coordinate rules match netlify/lib/site-details.mjs.
 * The temporary 1111 placeholder ABN is allowed, as on the server.
 */
export const PLACEHOLDER_ABN = "1111";
export const ABN_ERROR = "That ABN is not valid. It needs 11 digits that pass the ABN check.";
export const PHONE_ERROR = "That phone number is not valid.";
export const EMAIL_ERROR = "That contact email is not valid.";
export const DEFAULT_EMAIL_ERROR = "That email is not valid.";
export const COORDS_ERROR = "lat/lng must both be set to a point in Australia (for example -37.8136, 144.9631).";
export const NAME_ERROR = "A site name is required.";
export const TYPE_ERROR = "Type must be VEA Retail, LOC CA or Unattended.";
export const TYPE_REQUIRED = "Choose a site type.";
export const SITE_TYPES = ["company", "commission_agent", "unattended"];
export const SITE_FORM_FIELD_ORDER = ["name", "loc", "siteType", "address", "lat", "lng", "phone", "contactEmail", "tradingName", "abn"];
const CONTACT_EMAIL_HIDDEN = "HIDE";
const CONTACT_EMAIL_RE = /^[a-z0-9._%+'’-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Undo the leading apostrophe csvCell adds so Excel will not treat a value like -33.1 as a formula. */
export function unguardCsvCell(value) {
  const text = String(value ?? "");
  if (text.charAt(0) === "'" && /^[=+\-@\t]/.test(text.slice(1))) return text.slice(1);
  return text;
}

/** ABN: 11 digits that pass the ATO checksum, or the temporary placeholder 1111. Returns the formatted ABN, "1111", "" for blank, or null when invalid. */
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

/** Australian phone in one tidy shape. "" for blank, null when not a phone. */
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

/** Contact email: a valid address, the word HIDE, "" for blank, or null when invalid. */
export function normaliseContactEmail(value) {
  const text = unguardCsvCell(String(value ?? "")).trim();
  if (!text) return "";
  if (["HIDE", "NONE", "HIDDEN"].includes(text.toUpperCase())) return CONTACT_EMAIL_HIDDEN;
  if (text.length > 120 || text.includes(" ") || !CONTACT_EMAIL_RE.test(text)) return null;
  return text.toLowerCase();
}

/** A map point in Australia, or null when missing or outside the accepted range. */
export function validCoords(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === "" || lng === "" || lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -45 || la > -9 || ln < 110 || ln > 155) return null;
  return { lat: Math.round(la * 10000) / 10000, lng: Math.round(ln * 10000) / 10000 };
}

export function validateSiteForm(body) {
  const fields = {};
  if (!String(body?.name ?? "").trim()) fields.name = NAME_ERROR;
  const type = String(body?.siteType ?? "").trim();
  if (!type) fields.siteType = TYPE_REQUIRED;
  else if (!SITE_TYPES.includes(type)) fields.siteType = TYPE_ERROR;
  if (normaliseAbn(body?.abn) === null) fields.abn = ABN_ERROR;
  if (normaliseSitePhone(body?.phone) === null) fields.phone = PHONE_ERROR;
  if (!body?.hideContactEmail && normaliseContactEmail(body?.contactEmail) === null) fields.contactEmail = EMAIL_ERROR;
  const latBlank = body?.lat == null || String(body.lat).trim() === "";
  const lngBlank = body?.lng == null || String(body.lng).trim() === "";
  if (!latBlank || !lngBlank) {
    if (!validCoords(body?.lat, body?.lng)) {
      fields.lat = COORDS_ERROR;
      fields.lng = COORDS_ERROR;
    }
  }
  return { fields, summary: "" };
}

export function validateCompanyForm(body) {
  const fields = {};
  if (normaliseAbn(body?.abn) === null) fields.abn = ABN_ERROR;
  return { fields, summary: "" };
}

export function validateDefaultContactEmail(value) {
  const fields = {};
  if (normaliseContactEmail(value) === null) fields.email = DEFAULT_EMAIL_ERROR;
  return { fields, summary: "" };
}

/** Map server error strings onto form fields when the API did not send a fields object. */
export function fieldsFromMessages(messages) {
  const fields = {};
  for (const msg of messages || []) {
    if (!msg) continue;
    if (/ABN is not valid/i.test(msg)) fields.abn = msg;
    else if (/phone number is not valid/i.test(msg)) fields.phone = msg;
    else if (/contact email is not valid/i.test(msg)) fields.contactEmail = msg;
    else if (/^That email is not valid/i.test(msg)) fields.email = msg;
    else if (/lat\/lng must both/i.test(msg)) { fields.lat = msg; fields.lng = msg; }
    else if (/site name is required|already uses that name|name already exists/i.test(msg)) fields.name = msg;
    else if (/already uses that site number|site number already exists|site number was taken/i.test(msg)) fields.loc = msg;
    else if (/Type must be|Choose a site type/i.test(msg)) fields.siteType = msg;
  }
  return fields;
}

/** Turn an API error (message, optional errors[] and fields{}) into inline field errors plus a summary for anything else. */
export function issuesFromApiError(err) {
  const error = err && err.message ? String(err.message) : "";
  const provided = err && err.fields && typeof err.fields === "object" && !Array.isArray(err.fields) ? { ...err.fields } : null;
  const fields = provided && Object.keys(provided).length ? provided : fieldsFromMessages([...(err && err.errors ? err.errors : []), error]);
  const shown = new Set(Object.values(fields));
  const summary = error && !shown.has(error) ? error : "";
  return { fields, summary };
}
