import crypto from "node:crypto";
import { validUrl, validSlug, validColor, addDays, dayKey } from "./lib.mjs";

export const FIELD_TYPES = ["text", "email", "phone", "dropdown", "checkbox", "textarea"];
export const LIBERTY_COLORS = {
  background: "#f4f6fb",
  text: "#1c2434",
  accent: "#0e1b4d",
  button: "#1f4bdb",
  buttonText: "#ffffff",
};

const COLOR_KEYS = Object.keys(LIBERTY_COLORS);

export function blankFields() {
  return [
    { id: "name", type: "text", label: "Name", required: true, options: [] },
    { id: "email", type: "email", label: "Email", required: true, options: [] },
  ];
}

export function defaultPage(partial = {}) {
  return {
    slug: partial.slug || "",
    name: partial.name || "",
    title: partial.title || "",
    heading: partial.heading || "",
    body: partial.body || "",
    heroUrl: "",
    heroData: "",
    buttonLabel: "",
    buttonUrl: "",
    colors: { ...LIBERTY_COLORS },
    fields: blankFields(),
    submitLabel: "Send",
    thankYou: "Thanks, we have your message.",
    status: "draft",
    codeSlug: "",
    created: partial.created || new Date().toISOString(),
    updated: null,
  };
}

export function validHero(data) {
  if (data == null || data === "") return true;
  return typeof data === "string" && /^data:image\/(png|jpeg);base64,/.test(data) && data.length <= 180000;
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
    let id = String(raw?.id || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
    if (!id || seen.has(id)) id = crypto.randomBytes(4).toString("hex");
    seen.add(id);
    let options = [];
    if (type === "dropdown") {
      const source = Array.isArray(raw.options) ? raw.options : String(raw.options || "").split(",");
      options = source.map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 30);
      if (!options.length) return { error: "Dropdown fields need at least one option" };
    }
    out.push({ id, type, label, required: !!raw?.required, options });
  }
  return { fields: out };
}

function cleanColors(input, base) {
  const colors = { ...LIBERTY_COLORS, ...(base || {}) };
  for (const key of COLOR_KEYS) {
    if (input && input[key] !== undefined) {
      if (!validColor(input[key])) return { error: "Colours must be hex values like #112233" };
      colors[key] = input[key];
    }
  }
  return { colors };
}

export function applyPagePatch(page, body) {
  const next = {
    ...page,
    colors: { ...page.colors },
    fields: (page.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] })),
  };
  if (body.name !== undefined) {
    const name = String(body.name || "").trim().slice(0, 140);
    if (!name) return { error: "Name is required" };
    next.name = name;
  }
  if (body.title !== undefined) next.title = String(body.title || "").trim().slice(0, 140);
  if (body.heading !== undefined) next.heading = String(body.heading || "").trim().slice(0, 180);
  if (body.body !== undefined) next.body = String(body.body || "").slice(0, 8000);
  if (body.submitLabel !== undefined) next.submitLabel = String(body.submitLabel || "Send").trim().slice(0, 40) || "Send";
  if (body.thankYou !== undefined) next.thankYou = String(body.thankYou || "").trim().slice(0, 1000) || "Thanks, we have your message.";
  if (body.buttonLabel !== undefined) next.buttonLabel = String(body.buttonLabel || "").trim().slice(0, 40);
  if (body.heroUrl !== undefined) {
    const url = String(body.heroUrl || "").trim();
    if (url && !validUrl(url)) return { error: "Hero image URL must be an http(s) URL" };
    next.heroUrl = url;
  }
  if (body.heroData !== undefined) {
    if (!validHero(body.heroData)) return { error: "Hero image must be a PNG or JPEG under 120 KB" };
    next.heroData = body.heroData || "";
  }
  if (body.buttonUrl !== undefined) {
    const url = String(body.buttonUrl || "").trim();
    if (url && !validUrl(url)) return { error: "Button URL must be an http(s) URL" };
    next.buttonUrl = url;
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
    if (body.status !== "draft" && body.status !== "published") return { error: "Status must be draft or published" };
    next.status = body.status;
  }
  if (body.codeSlug !== undefined) {
    const slug = String(body.codeSlug || "").trim().toLowerCase();
    if (slug && !validSlug(slug)) return { error: "Linked code is invalid" };
    next.codeSlug = slug;
  }
  next.updated = new Date().toISOString();
  return { page: next };
}

export function readSubmission(fields, body) {
  const values = {};
  for (const field of fields || []) {
    let raw = body?.[field.id];
    if (Array.isArray(raw)) raw = raw[0];
    const value = raw == null ? "" : String(raw).trim().slice(0, 5000);
    if (field.type === "checkbox") {
      const on = ["yes", "on", "true", "1"].includes(value.toLowerCase());
      if (field.required && !on) return { error: field.label + " is required" };
      values[field.id] = on ? "yes" : "";
      continue;
    }
    if (field.required && !value) return { error: field.label + " is required" };
    if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { error: field.label + " must be an email" };
    if (value && field.type === "phone" && !/^[0-9+().\-\s]{6,40}$/.test(value)) return { error: field.label + " must be a phone number" };
    if (value && field.type === "dropdown" && !(field.options || []).includes(value)) return { error: field.label + " has an invalid choice" };
    values[field.id] = value;
  }
  return { values };
}

export function emptyViews() {
  return { total: 0, last: null, daily: {}, visitors: {} };
}

export function recordView(raw, { day, at, visitor }) {
  const s = {
    total: raw?.total || 0,
    last: raw?.last || null,
    daily: { ...(raw?.daily || {}) },
    visitors: { ...(raw?.visitors || {}) },
  };
  s.total += 1;
  s.last = at || new Date().toISOString();
  s.daily[day] = (s.daily[day] || 0) + 1;
  if (visitor) {
    const list = Array.isArray(s.visitors[day]) ? s.visitors[day].slice() : [];
    if (!list.includes(visitor) && list.length < 500) list.push(visitor);
    s.visitors[day] = list;
  }
  const cutoff = addDays(day || dayKey(), -420);
  for (const key of Object.keys(s.daily)) if (key < cutoff) delete s.daily[key];
  for (const key of Object.keys(s.visitors)) if (key < cutoff) delete s.visitors[key];
  return s;
}

export function viewsIn(stats, keys) {
  const seen = new Set();
  let total = 0;
  for (const key of keys) {
    total += stats?.daily?.[key] || 0;
    for (const hash of stats?.visitors?.[key] || []) seen.add(hash);
  }
  return { total, unique: seen.size };
}

export function publicPage(page, { hero = false } = {}) {
  const copy = {
    ...page,
    colors: { ...LIBERTY_COLORS, ...(page.colors || {}) },
    fields: (page.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] })),
    hasHero: !!(page.heroData || page.heroUrl),
  };
  if (!hero) copy.heroData = "";
  return copy;
}

export function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function submissionsCsv(page, items) {
  const headers = ["submitted_at", ...(page.fields || []).map((f) => f.label)];
  const lines = [headers.map(csvEscape).join(",")];
  for (const item of items) {
    const row = [item.at, ...(page.fields || []).map((f) => item.values?.[f.id] || "")];
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

export function renderPublicPage(page, { thankYou = false, error = "" } = {}) {
  const colors = { ...LIBERTY_COLORS, ...(page.colors || {}) };
  const hero = validHero(page.heroData) && page.heroData ? page.heroData : (validUrl(page.heroUrl) ? page.heroUrl : "");
  const button = page.buttonLabel && validUrl(page.buttonUrl)
    ? '<a class="cta" href="' + esc(page.buttonUrl) + '">' + esc(page.buttonLabel) + "</a>"
    : "";
  const fields = (page.fields || []).map((field) => {
    const req = field.required ? " required" : "";
    const star = field.required ? " *" : "";
    if (field.type === "checkbox") {
      return '<label class="check"><input type="checkbox" name="' + esc(field.id) + '" value="yes"' + req + "> " + esc(field.label) + star + "</label>";
    }
    if (field.type === "textarea") {
      return "<label>" + esc(field.label) + star + '<textarea name="' + esc(field.id) + '"' + req + "></textarea></label>";
    }
    if (field.type === "dropdown") {
      const options = (field.options || []).map((o) => '<option value="' + esc(o) + '">' + esc(o) + "</option>").join("");
      return "<label>" + esc(field.label) + star + '<select name="' + esc(field.id) + '"' + req + '><option value="">Choose…</option>' + options + "</select></label>";
    }
    const type = field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text";
    return "<label>" + esc(field.label) + star + '<input type="' + type + '" name="' + esc(field.id) + '"' + req + "></label>";
  }).join("");
  const form = '<form data-form method="post"><p class="err" id="form-error">' + esc(error) + "</p>" + fields +
    '<button class="submit" type="submit">' + esc(page.submitLabel || "Send") + "</button></form>";
  const thanks = '<div id="thanks"' + (thankYou ? "" : " hidden") + '><div class="thanks">' + esc(page.thankYou || "Thanks, we have your message.") + "</div></div>";
  const style = ":root{--bg:" + colors.background + ";--ink:" + colors.text + ";--accent:" + colors.accent + ";--btn:" + colors.button + ";--btntext:" + colors.buttonText + "}" +
    "body{margin:0;font-family:Inter,Segoe UI,system-ui,sans-serif;background:var(--bg);color:var(--ink)}" +
    ".wrap{max-width:560px;margin:0 auto;padding:32px 18px 72px}" +
    ".hero{width:76px;height:76px;object-fit:contain;border-radius:16px;background:#fff}" +
    "h1{font-size:2rem;line-height:1.15;letter-spacing:-.03em;margin:14px 0;color:var(--accent)}" +
    ".copy{white-space:pre-wrap;font-size:1.05rem;line-height:1.5}" +
    "a.cta,button.submit{display:block;width:100%;box-sizing:border-box;text-align:center;background:var(--btn);color:var(--btntext);text-decoration:none;border:0;border-radius:12px;padding:14px 16px;font:inherit;font-weight:700;margin-top:16px}" +
    "form{margin-top:22px}label{display:block;font-weight:700;margin:14px 0 6px}" +
    "input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;padding:12px;font:inherit;background:#fff}" +
    "textarea{min-height:110px}.check{display:flex;gap:10px;align-items:center;font-weight:600}" +
    ".check input{width:auto}.err{color:#b42318;min-height:1.2em}.thanks{background:#fff;border-radius:16px;padding:18px;font-size:1.05rem}" +
    ".mark{width:28px;height:28px}";
  return "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">" +
    "<title>" + esc(page.title || page.name || "Liberty") + "</title><style>" + style + "</style><body><main class=wrap>" +
    '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="' + colors.accent + '"/><path fill="#e7c98a" d="M9.5 8h13v3.2h-9.2V24H9.5z"/></svg>' +
    (hero ? '<div><img class="hero" alt="" src="' + esc(hero) + '"></div>' : "") +
    (page.heading ? "<h1>" + esc(page.heading) + "</h1>" : "") +
    (page.body ? '<div class="copy">' + esc(page.body) + "</div>" : "") +
    button +
    '<div id="form-wrap"' + (thankYou ? " hidden" : "") + ">" + form + "</div>" +
    thanks +
    "</main><script>document.querySelector('[data-form]')?.addEventListener('submit',async function(e){e.preventDefault();var fd=new FormData(e.target);var body={};fd.forEach(function(v,k){body[k]=v});var err=document.getElementById('form-error');try{var res=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(body)});var data=await res.json().catch(function(){return {}});if(!res.ok){err.textContent=data.error||'Could not send';return}document.getElementById('form-wrap').hidden=true;document.getElementById('thanks').hidden=false}catch(x){err.textContent='Could not send'}})</script>";
}

export function unavailablePage() {
  return "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Page unavailable</title><body style=\"margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f4f6fb;color:#1c2434;text-align:center;padding:24px\"><main><h1>This page is not available</h1><p>The page is unpublished or does not exist.</p></main>";
}
