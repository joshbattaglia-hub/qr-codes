/** The one Express Help footer for server-rendered pages and emails. Same defaults as public/footer.js. */
import { settingsStore } from "./lib.mjs";

export const FOOTER_EMAIL = "jbattaglia@libertyretail.com.au";
export const FOOTER_LEAD = "Cowabunga - please hesitate to reach out";
export const FOOTER_LINK_TEXT = "email me here";
export const FOOTER_STYLE = "margin:24px auto 16px;padding:0 16px;max-width:960px;text-align:center;font:11px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#667085";
export const FOOTER_KEY = "site-footer";

const EMAIL = /^[a-z0-9._%+'’-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function cleanText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A single contact or footer email. Returns the lower-cased address, "" for blank, or null when invalid. */
export function normaliseFooterEmail(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length > 120 || text.includes(" ") || !EMAIL.test(text)) return null;
  return text.toLowerCase();
}

/** Resolve stored footer fields. Missing or blank fields fall back to the usual wording so the footer never disappears. */
export function resolveFooter(raw) {
  const lead = cleanText(raw?.lead ?? raw?.text, 200) || FOOTER_LEAD;
  const linkText = cleanText(raw?.linkText ?? raw?.link, 80) || FOOTER_LINK_TEXT;
  const parsed = normaliseFooterEmail(raw?.email);
  const email = parsed || FOOTER_EMAIL;
  return { lead, linkText, email };
}

export function footerHtml(raw) {
  const f = resolveFooter(raw);
  return '<footer class="eh-footer" data-testid="eh-footer" style="' + FOOTER_STYLE + '">'
    + esc(f.lead) + ' <a href="mailto:' + esc(f.email) + '" style="color:inherit;text-decoration:underline">' + esc(f.linkText) + '</a></footer>';
}

/** Plain-text emails. */
export function footerText(raw) {
  const f = resolveFooter(raw);
  return f.lead + " " + f.linkText + ": mailto:" + f.email;
}

export async function loadFooter() {
  const raw = await settingsStore().get(FOOTER_KEY, { type: "json" }).catch(() => null);
  return resolveFooter(raw);
}

export async function saveFooter(body) {
  const lead = cleanText(body?.lead ?? body?.text, 200);
  const linkText = cleanText(body?.linkText ?? body?.link, 80);
  const emailRaw = body?.email != null ? String(body.email).trim() : "";
  let email = "";
  if (emailRaw) {
    email = normaliseFooterEmail(emailRaw);
    if (email === null) return { status: 400, error: "That email is not valid." };
  }
  const next = resolveFooter({ lead, linkText, email });
  await settingsStore().setJSON(FOOTER_KEY, { ...next, updatedAt: new Date().toISOString() });
  return { status: 200, body: next };
}
