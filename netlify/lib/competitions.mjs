import crypto from "node:crypto";
import { validUrl, validSlug, validColor, addDays } from "./lib.mjs";

export const MELBOURNE = "Australia/Melbourne";
export const FIELD_TYPES = ["text", "email", "phone", "dropdown", "checkbox", "textarea", "file"];
export const FIELD_ROLES = ["", "name", "email", "phone", "rego", "receipt", "receiptPhoto", "over18", "consent", "site"];
export const LIBERTY_COLORS = {
  background: "#f4f6fb",
  text: "#1c2434",
  accent: "#0e1b4d",
  button: "#1f4bdb",
  buttonText: "#ffffff",
};

export function melbourneDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function melbourneStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE, dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normaliseEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalisePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("61")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function normaliseRego(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normaliseReceipt(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function periodCount(comp) {
  if (comp?.schedule?.type === "single") return 1;
  const count = Number(comp?.schedule?.count) || 1;
  return Math.max(1, Math.min(52, Math.round(count)));
}

export function nextDrawDate(comp) {
  if (!comp?.start) return "";
  const done = (comp.winners || []).filter((w) => !w.superseded).length;
  if (done >= periodCount(comp)) return "";
  if (comp.schedule?.type === "single") return comp.end || comp.start;
  return addDays(comp.start, (done + 1) * 7 - 1);
}

export function accepting(comp, today = melbourneDate()) {
  if (!comp || comp.status !== "active") return false;
  if ((comp.currentPeriod || 1) > periodCount(comp)) return false;
  if (comp.end && today > comp.end) return false;
  return true;
}

/** Shown above the form. A future open date does not remove the form. */
export function entryNotice(comp, today = melbourneDate()) {
  if (!comp || comp.status !== "active") return "This competition is not open.";
  if ((comp.currentPeriod || 1) > periodCount(comp)) return "All draws for this competition are complete.";
  if (comp.end && today > comp.end) return "This competition is closed.";
  if (comp.start && today < comp.start) return "Entries open " + comp.start + ".";
  return "";
}

export function validImage(data) {
  if (data == null || data === "") return true;
  return typeof data === "string" && /^data:image\/(png|jpeg);base64,/.test(data) && data.length <= 180000;
}

export function defaultFields() {
  return [
    { id: "name", type: "text", label: "Name", required: true, role: "name", options: [] },
    { id: "email", type: "email", label: "Email", required: false, role: "email", options: [] },
    { id: "phone", type: "phone", label: "Mobile", required: false, role: "phone", options: [] },
    { id: "rego", type: "text", label: "Vehicle rego", required: false, role: "rego", options: [] },
    { id: "receipt", type: "text", label: "Receipt number", required: false, role: "receipt", options: [] },
    { id: "photo", type: "file", label: "Receipt photo", required: false, role: "receiptPhoto", options: [] },
    { id: "over18", type: "checkbox", label: "I am 18 or older", required: true, role: "over18", options: [] },
    { id: "consent", type: "checkbox", label: "I agree to the terms", required: true, role: "consent", options: [] },
  ];
}

export function defaultCompetition(partial = {}) {
  return {
    slug: partial.slug || "",
    name: partial.name || "",
    sites: [],
    prize: "",
    status: "draft",
    start: partial.start || melbourneDate(),
    end: "",
    schedule: { type: "weekly", count: 8 },
    fields: defaultFields(),
    eligibility: { onePerPerson: true, dedupeEmail: true, dedupePhone: true, dedupeRego: false, dedupeReceipt: true },
    terms: "",
    termsUrl: "",
    heading: "",
    body: "",
    heroUrl: "",
    heroData: "",
    logoData: "",
    submitLabel: "Enter",
    thankYou: "You're in the draw. Good luck.",
    colors: { ...LIBERTY_COLORS },
    codeSlug: "",
    currentPeriod: 1,
    winners: [],
    created: partial.created || new Date().toISOString(),
    updated: null,
  };
}

function cleanColors(input, base) {
  const colors = { ...LIBERTY_COLORS, ...(base || {}) };
  for (const key of Object.keys(LIBERTY_COLORS)) {
    if (input && input[key] !== undefined) {
      if (!validColor(input[key])) return { error: "Colours must be hex values like #112233" };
      colors[key] = input[key];
    }
  }
  return { colors };
}

export function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return { error: "Fields must be a list" };
  if (fields.length > 30) return { error: "Up to 30 form fields" };
  const out = [];
  const seen = new Set();
  for (const raw of fields) {
    const type = String(raw?.type || "");
    if (!FIELD_TYPES.includes(type)) return { error: "Unknown field type" };
    const label = String(raw?.label || "").trim().slice(0, 80);
    if (!label) return { error: "Each field needs a label" };
    const role = FIELD_ROLES.includes(raw?.role) ? raw.role : "";
    if (role === "receiptPhoto" && type !== "file") return { error: "Receipt photo must be a file field" };
    let id = String(raw?.id || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
    if (!id || seen.has(id)) id = crypto.randomBytes(4).toString("hex");
    seen.add(id);
    let options = [];
    if (type === "dropdown") {
      const source = Array.isArray(raw.options) ? raw.options : String(raw.options || "").split(",");
      options = source.map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 30);
      if (!options.length) return { error: "Dropdown fields need at least one option" };
    }
    out.push({ id, type, label, required: !!raw?.required, role, options });
  }
  return { fields: out };
}

function cleanSites(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const sites = [];
  const seen = new Set();
  for (const raw of source) {
    const site = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const key = site.toLowerCase();
    if (!site || seen.has(key)) continue;
    seen.add(key);
    sites.push(site);
    if (sites.length >= 20) break;
  }
  return sites;
}

export function applyCompetitionPatch(comp, body) {
  const next = {
    ...comp,
    colors: { ...comp.colors },
    eligibility: { ...comp.eligibility },
    schedule: { ...comp.schedule },
    fields: (comp.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] })),
    sites: [...(comp.sites || [])],
    winners: comp.winners || [],
  };
  if (body.name !== undefined) {
    const name = String(body.name || "").trim().slice(0, 140);
    if (!name) return { error: "Name is required" };
    next.name = name;
  }
  if (body.sites !== undefined) next.sites = cleanSites(body.sites);
  if (body.prize !== undefined) next.prize = String(body.prize || "").trim().slice(0, 160);
  if (body.heading !== undefined) next.heading = String(body.heading || "").trim().slice(0, 180);
  if (body.body !== undefined) next.body = String(body.body || "").slice(0, 8000);
  if (body.terms !== undefined) next.terms = String(body.terms || "").slice(0, 8000);
  if (body.submitLabel !== undefined) next.submitLabel = String(body.submitLabel || "Enter").trim().slice(0, 40) || "Enter";
  if (body.thankYou !== undefined) next.thankYou = String(body.thankYou || "").trim().slice(0, 1000) || "You're in the draw. Good luck.";
  if (body.start !== undefined) {
    if (body.start && !/^\d{4}-\d{2}-\d{2}$/.test(body.start)) return { error: "Start date must be YYYY-MM-DD" };
    next.start = body.start || "";
  }
  if (body.end !== undefined) {
    if (body.end && !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) return { error: "End date must be YYYY-MM-DD" };
    next.end = body.end || "";
  }
  if (body.schedule !== undefined) {
    const type = body.schedule?.type === "single" ? "single" : "weekly";
    const count = type === "single" ? 1 : Math.max(1, Math.min(52, Math.round(Number(body.schedule?.count) || 8)));
    next.schedule = { type, count };
  }
  if (body.eligibility !== undefined) {
    const e = body.eligibility || {};
    next.eligibility = {
      onePerPerson: e.onePerPerson !== undefined ? !!e.onePerPerson : next.eligibility.onePerPerson,
      dedupeEmail: !!e.dedupeEmail,
      dedupePhone: !!e.dedupePhone,
      dedupeRego: !!e.dedupeRego,
      dedupeReceipt: !!e.dedupeReceipt,
    };
  }
  if (body.termsUrl !== undefined) {
    const url = String(body.termsUrl || "").trim();
    if (url && !validUrl(url)) return { error: "Terms link must be an http(s) URL" };
    next.termsUrl = url;
  }
  if (body.heroUrl !== undefined) {
    const url = String(body.heroUrl || "").trim();
    if (url && !validUrl(url)) return { error: "Hero image URL must be an http(s) URL" };
    next.heroUrl = url;
  }
  if (body.heroData !== undefined) {
    if (!validImage(body.heroData)) return { error: "Hero image must be a PNG or JPEG under 120 KB" };
    next.heroData = body.heroData || "";
  }
  if (body.logoData !== undefined) {
    if (!validImage(body.logoData)) return { error: "Logo must be a PNG or JPEG under 120 KB" };
    next.logoData = body.logoData || "";
  }
  if (body.colors !== undefined) {
    const colors = cleanColors(body.colors, next.colors);
    if (colors.error) return colors;
    next.colors = colors.colors;
  }
  if (body.fields !== undefined) {
    const fields = sanitizeFields(body.fields);
    if (fields.error) return fields;
    next.fields = fields.fields;
  }
  if (body.status !== undefined) {
    if (!["draft", "active", "ended"].includes(body.status)) return { error: "Status must be draft, active, or ended" };
    next.status = body.status;
  }
  if (body.codeSlug !== undefined) {
    const slug = String(body.codeSlug || "").trim().toLowerCase();
    if (slug && !validSlug(slug)) return { error: "Linked code is invalid" };
    next.codeSlug = slug;
  }
  if (body.currentPeriod !== undefined) {
    const period = Math.round(Number(body.currentPeriod));
    if (!period || period < 1 || period > periodCount(next) + 1) return { error: "Current period is out of range" };
    next.currentPeriod = period;
  }
  next.updated = new Date().toISOString();
  return { competition: next };
}

/** Active pages with no saved fields still collect name, email, phone, and enabled eligibility fields. */
export function publicFields(comp) {
  const configured = (comp?.fields || []).filter((f) => f && f.type && String(f.label || "").trim());
  if (configured.length) return configured;
  const eligibility = comp?.eligibility || {};
  const fields = [
    { id: "name", type: "text", label: "Name", required: true, role: "name", options: [] },
    { id: "email", type: "email", label: "Email", required: true, role: "email", options: [] },
    { id: "phone", type: "phone", label: "Mobile", required: false, role: "phone", options: [] },
  ];
  if (eligibility.dedupeRego) fields.push({ id: "rego", type: "text", label: "Vehicle rego", required: false, role: "rego", options: [] });
  if (eligibility.dedupeReceipt !== false) {
    fields.push({ id: "receipt", type: "text", label: "Receipt number", required: false, role: "receipt", options: [] });
    fields.push({ id: "photo", type: "file", label: "Receipt photo", required: false, role: "receiptPhoto", options: [] });
  }
  fields.push(
    { id: "over18", type: "checkbox", label: "I am 18 or older", required: true, role: "over18", options: [] },
    { id: "consent", type: "checkbox", label: "I agree to the terms", required: true, role: "consent", options: [] },
  );
  return fields;
}

function fieldByRole(comp, role) {
  return publicFields(comp).find((f) => f.role === role);
}

export function buildIncoming(comp, body) {
  const values = {};
  let photo = "";
  for (const field of publicFields(comp)) {
    let raw = body?.[field.id];
    if (Array.isArray(raw)) raw = raw[0];
    const value = raw == null ? "" : String(raw).trim();
    if (field.type === "file") {
      if (field.required && !value) return { error: field.label + " is required" };
      if (value && !/^data:image\/(png|jpeg);base64,/.test(value)) return { error: field.label + " must be a PNG or JPEG" };
      if (value && value.length > 180000) return { error: field.label + " is too large" };
      values[field.id] = value ? "uploaded" : "";
      if (field.role === "receiptPhoto") photo = value;
      continue;
    }
    if (field.type === "checkbox") {
      const on = ["yes", "on", "true", "1"].includes(value.toLowerCase());
      if (field.required && !on) return { error: field.label + " is required" };
      values[field.id] = on ? "yes" : "";
      continue;
    }
    const text = value.slice(0, 5000);
    if (field.required && !text) return { error: field.label + " is required" };
    if (text && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { error: field.label + " must be an email" };
    if (text && field.type === "phone" && !/^[0-9+().\-\s]{6,40}$/.test(text)) return { error: field.label + " must be a phone number" };
    if (text && field.type === "dropdown" && !(field.options || []).includes(text)) return { error: field.label + " has an invalid choice" };
    values[field.id] = text;
  }
  const email = normaliseEmail(values[fieldByRole(comp, "email")?.id] || "");
  const phone = normalisePhone(values[fieldByRole(comp, "phone")?.id] || "");
  const rego = normaliseRego(values[fieldByRole(comp, "rego")?.id] || "");
  const receipt = normaliseReceipt(values[fieldByRole(comp, "receipt")?.id] || "");
  const name = values[fieldByRole(comp, "name")?.id] || "";
  const siteField = fieldByRole(comp, "site");
  const site = siteField ? (values[siteField.id] || "") : ((comp.sites || []).length === 1 ? comp.sites[0] : (body?.__site || ""));
  if ((comp.sites || []).length > 1 && !site) return { error: "Choose a site" };
  if ((comp.sites || []).length > 1 && !(comp.sites || []).includes(site)) return { error: "Choose a site" };
  const contactType = email ? "email" : phone ? "phone" : "";
  const contact = email ? (values[fieldByRole(comp, "email").id] || "") : (values[fieldByRole(comp, "phone")?.id] || "");
  const contactNorm = email || phone;
  if (comp.eligibility?.onePerPerson && !contactNorm && (fieldByRole(comp, "email") || fieldByRole(comp, "phone"))) {
    return { error: "Add an email or mobile so we can keep one entry per person" };
  }
  const over18 = values[fieldByRole(comp, "over18")?.id] === "yes";
  const consent = values[fieldByRole(comp, "consent")?.id] === "yes";
  const photoHash = photo ? sha256(Buffer.from(photo.split(",")[1] || "", "base64")) : "";
  const receiptHash = receipt ? sha256(receipt) : "";
  return {
    values, photo, photoHash, receiptHash, emailNorm: email, phoneNorm: phone, regoNorm: rego,
    name, contact, contactNorm, contactType, site, over18, consent, receiptNumber: receipt,
  };
}

export function classifyEntry(comp, existing, incoming) {
  const period = comp.currentPeriod || 1;
  const eligibility = comp.eligibility || {};
  const reasons = [];
  let matched = "";
  const note = (reason, id) => { reasons.push(reason); if (!matched) matched = id; };
  const periodEntries = (existing || []).filter((e) => e.period === period && e.status !== "duplicate");
  const accepted = (existing || []).filter((e) => e.status !== "duplicate");
  if (eligibility.dedupeEmail && incoming.emailNorm) {
    const hit = periodEntries.find((e) => e.emailNorm === incoming.emailNorm);
    if (hit) note("Same email in this period", hit.id);
  }
  if (eligibility.dedupePhone && incoming.phoneNorm) {
    const hit = periodEntries.find((e) => e.phoneNorm === incoming.phoneNorm);
    if (hit) note("Same phone in this period", hit.id);
  }
  if (eligibility.dedupeRego && incoming.regoNorm) {
    const hit = periodEntries.find((e) => e.regoNorm === incoming.regoNorm);
    if (hit) note("Same rego in this period", hit.id);
  }
  if (eligibility.dedupeReceipt && incoming.receiptHash) {
    const hit = accepted.find((e) => e.receiptHash && e.receiptHash === incoming.receiptHash);
    if (hit) note("Same receipt", hit.id);
  }
  if (eligibility.dedupeReceipt && incoming.photoHash) {
    const hit = accepted.find((e) => e.photoHash && e.photoHash === incoming.photoHash);
    if (hit) note("Same receipt photo", hit.id);
  }
  if (!reasons.length) return { status: "valid", duplicateReason: "", matchedEntryId: "" };
  return { status: "duplicate", duplicateReason: reasons.join("; "), matchedEntryId: matched };
}

export function dashboard(comp, entries) {
  const accepted = (entries || []).filter((e) => e.status === "valid" || e.status === "archived");
  const unique = new Set(accepted.map((e) => e.contactNorm || e.emailNorm || e.phoneNorm || e.id)).size;
  const drawn = (comp.winners || []).filter((w) => !w.superseded);
  return {
    valid: accepted.length,
    unique,
    duplicates: (entries || []).filter((e) => e.status === "duplicate").length,
    winnersDrawn: drawn.length,
    drawsRemaining: Math.max(0, periodCount(comp) - drawn.length),
    currentPeriod: comp.currentPeriod || 1,
    nextDraw: nextDrawDate(comp),
    currentValid: (entries || []).filter((e) => e.period === (comp.currentPeriod || 1) && e.status === "valid").length,
  };
}

export function chooseWinner(entries, period, excludeIds = [], rng = (n) => crypto.randomInt(n)) {
  const pool = (entries || []).filter((e) => e.period === period && !excludeIds.includes(e.id) && (e.status === "valid" || (excludeIds.length && e.status === "archived")));
  const drawable = excludeIds.length ? pool : pool.filter((e) => e.status === "valid");
  if (!drawable.length) return { error: "No valid entries in this period" };
  const index = rng(drawable.length);
  return { winner: drawable[index], poolSize: drawable.length };
}

export function summariseEntry(entry) {
  if (!entry) return entry;
  const copy = { ...entry };
  delete copy.photo;
  return copy;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

export function renderCompetitionPage(comp, { error = "", notice = "", thankYou = false } = {}) {
  const colors = { ...LIBERTY_COLORS, ...(comp.colors || {}) };
  const fields = publicFields(comp).map((field) => {
    const req = field.required ? " required" : "";
    const star = field.required ? " *" : "";
    if (field.type === "checkbox") return '<label class="check"><input type="checkbox" name="' + esc(field.id) + '" value="yes"' + req + "> " + esc(field.label) + star + "</label>";
    if (field.type === "textarea") return "<label>" + esc(field.label) + star + '<textarea name="' + esc(field.id) + '"' + req + "></textarea></label>";
    if (field.type === "dropdown") {
      const options = (field.options || []).map((o) => '<option value="' + esc(o) + '">' + esc(o) + "</option>").join("");
      return "<label>" + esc(field.label) + star + '<select name="' + esc(field.id) + '"' + req + '><option value="">Choose…</option>' + options + "</select></label>";
    }
    if (field.type === "file") return "<label>" + esc(field.label) + star + '<input type="file" accept="image/png,image/jpeg" data-file="' + esc(field.id) + '"' + req + "></label>";
    const type = field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text";
    return "<label>" + esc(field.label) + star + '<input type="' + type + '" name="' + esc(field.id) + '"' + req + "></label>";
  }).join("");
  const site = (comp.sites || []).length > 1
    ? '<label>Site *<select name="__site" required><option value="">Choose…</option>' + comp.sites.map((s) => '<option value="' + esc(s) + '">' + esc(s) + "</option>").join("") + "</select></label>"
    : "";
  const terms = comp.terms ? '<div class="copy terms">' + esc(comp.terms) + "</div>" : "";
  const termsLink = validUrl(comp.termsUrl) ? '<p><a href="' + esc(comp.termsUrl) + '">Terms and conditions</a></p>' : "";
  const form = '<form data-form><p class="err" id="form-error">' + esc(error) + "</p>" +
    (notice ? '<p class="notice">' + esc(notice) + "</p>" : "") +
    site + fields + terms + termsLink +
    '<button class="submit" type="submit">' + esc(comp.submitLabel || "Enter") + "</button></form>";
  const logo = validImage(comp.logoData) && comp.logoData ? comp.logoData : "";
  const hero = (validImage(comp.heroData) && comp.heroData) ? comp.heroData : (validUrl(comp.heroUrl) ? comp.heroUrl : "");
  const mark = logo
    ? '<img class="logo" alt="" src="' + esc(logo) + '">'
    : '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="' + colors.accent + '"/><path fill="#e7c98a" d="M9.5 8h13v3.2h-9.2V24H9.5z"/></svg>';
  const style = ":root{--bg:" + colors.background + ";--ink:" + colors.text + ";--accent:" + colors.accent + ";--btn:" + colors.button + ";--btntext:" + colors.buttonText + "}" +
    "body{margin:0;font-family:Inter,Segoe UI,system-ui,sans-serif;background:var(--bg);color:var(--ink)}" +
    ".wrap{max-width:560px;margin:0 auto;padding:28px 18px 72px}h1{font-size:2rem;line-height:1.15;letter-spacing:-.03em;margin:14px 0;color:var(--accent)}" +
    ".copy{white-space:pre-wrap;font-size:1.05rem;line-height:1.5}.prize{font-weight:700;color:var(--accent)}" +
    "button.submit{display:block;width:100%;box-sizing:border-box;text-align:center;background:var(--btn);color:var(--btntext);border:0;border-radius:12px;padding:14px 16px;font:inherit;font-weight:700;margin-top:16px}" +
    "label{display:block;font-weight:700;margin:14px 0 6px}input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;padding:12px;font:inherit;background:#fff;color:#1c2434}" +
    "textarea{min-height:110px}.check{display:flex;gap:10px;align-items:center}.check input{width:auto}.err{color:#b42318;min-height:1.2em}.notice{background:#fff;border-radius:12px;padding:12px 14px}.thanks{background:#fff;border-radius:16px;padding:18px}" +
    ".mark{width:28px;height:28px}.logo{width:76px;height:76px;object-fit:contain;border-radius:16px;background:#fff}.hero{width:100%;max-height:240px;object-fit:cover;border-radius:16px;display:block;margin:14px 0}.terms{font-size:.95rem;margin-top:12px}";
  return "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>" + esc(comp.name || "Competition") + "</title><style>" + style + "</style><body><main class=wrap>" +
    mark +
    (hero ? '<img class="hero" alt="" src="' + esc(hero) + '">' : "") +
    "<h1>" + esc(comp.heading || comp.name) + "</h1>" +
    (comp.prize ? '<p class="prize">' + esc(comp.prize) + "</p>" : "") +
    (comp.body ? '<div class="copy">' + esc(comp.body) + "</div>" : "") +
    '<div id="form-wrap"' + (thankYou ? " hidden" : "") + ">" + form + "</div>" +
    '<div id="thanks"' + (thankYou ? "" : " hidden") + '><div class="thanks">' + esc(comp.thankYou || "You're in the draw. Good luck.") + "</div></div>" +
    "</main><script>" + fileScript + "</script>";
}

const fileScript = `
document.querySelector('[data-form]')?.addEventListener('submit', async function (e) {
  e.preventDefault();
  var form = e.target;
  var err = document.getElementById('form-error');
  err.textContent = 'Sending…';
  var body = {};
  new FormData(form).forEach(function (v, k) { if (typeof v === 'string') body[k] = v; });
  var files = form.querySelectorAll('input[type=file]');
  for (var i = 0; i < files.length; i++) {
    var input = files[i];
    var file = input.files && input.files[0];
    if (!file) continue;
    body[input.getAttribute('data-file')] = await resizeImage(file);
  }
  try {
    var res = await fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { err.textContent = data.error || 'Could not enter'; return; }
    document.getElementById('form-wrap').hidden = true;
    document.getElementById('thanks').hidden = false;
  } catch (x) { err.textContent = 'Could not enter'; }
});
function resizeImage(file) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      var max = 900, scale = Math.min(1, max / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = function () { reject(new Error('image')); };
    img.src = URL.createObjectURL(file);
  });
}
`;

export function unavailableCompetition(message = "This competition is not available.") {
  return "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Competition unavailable</title><body style=\"margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f4f6fb;color:#1c2434;text-align:center;padding:24px\"><main><h1>" + esc(message) + "</h1></main>";
}

export function publicCompetition(comp) {
  const copy = { ...comp, colors: { ...LIBERTY_COLORS, ...(comp.colors || {}) }, winners: comp.winners || [] };
  return copy;
}

export function parseImportRows(rows) {
  return (rows || []).map((raw) => {
    const get = (...keys) => {
      for (const key of keys) {
        const found = Object.keys(raw).find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
        if (found && raw[found] != null && raw[found] !== "") return raw[found];
      }
      return "";
    };
    return {
      id: String(get("entryid", "id") || "").trim(),
      at: String(get("timestamp", "at", "entrydate") || ""),
      name: String(get("name") || ""),
      contact: String(get("contact") || ""),
      contactNorm: String(get("normalisedcontact", "normalizedcontact", "contactnorm") || ""),
      contactType: String(get("contacttype") || "").toLowerCase(),
      receiptUrl: String(get("receipturl") || ""),
      receiptHash: String(get("receipthashkey", "receipthash", "hash") || ""),
      formDate: String(get("formdate") || ""),
      over18: /^(yes|true|1)$/i.test(String(get("over18") || "")),
      consent: /^(yes|true|1)$/i.test(String(get("consent") || "")),
      note: String(get("note") || ""),
      status: String(get("status") || "").toLowerCase(),
      duplicateReason: String(get("duplicatereason") || ""),
      matchedEntryId: String(get("matchedentryid", "matchedentryrowid") || ""),
      period: Number(get("period") || "") || 0,
      site: String(get("site") || ""),
    };
  });
}
