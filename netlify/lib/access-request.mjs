import { conditionalIncrement, publicBase, rateStore } from "./lib.mjs";
import { deliver, mailAvailable } from "./mail.mjs";
import { emailKey, now } from "./credentials.mjs";
import { footerHtml, footerText } from "./footer.mjs";
import { emailLogoHtml } from "./brand.mjs";
import { OWNER_EMAIL } from "./users.mjs";
import { ticketAccess } from "./tickets.mjs";
import { tabsFor } from "../../public/admin/permissions.mjs";

/**
 * "Request access": a signed-in email-code user who lacks a tool asks Joshua for it. It sends one email and changes nothing.
 * Access is only ever granted by the owner in Admin > Users.
 */
export const REQUEST_TOOLS = {
  home: "Home", links: "Links", qrcodes: "QR Codes", pages: "Pages", analytics: "Analytics", competitions: "Competitions",
  pos: "POS setup", assets: "Asset Barcodes", warehouse: "Warehouse Stickers", visitors: "Visitor Log", tickets: "Support",
  users: "Users", sites: "Sites", domains: "Custom domains", settings: "Settings",
};
/** Tools Joshua can tick for an email-code user in Admin > Users. The rest are head-office only. */
export const GRANTABLE = new Set(["pos", "sites", "assets", "warehouse", "visitors", "tickets"]);
export const REASON_MAX = 500;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const PER_DAY = 5;

export const REQUEST_SENT = "Request sent. Joshua has been emailed. Nothing changes until he approves it.";
export const REQUEST_FAILED = "The request could not be sent right now. Try again shortly.";
export const REQUEST_LIMIT_TOOL = "You've already asked for this tool. Joshua has been emailed, so there's no need to ask again yet.";
export const REQUEST_LIMIT_DAY = "You've sent the most requests allowed today. Try again tomorrow.";

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function cleanReason(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, REASON_MAX);
}

export function melbourneTime(ms) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(ms));
}

export function editLink(email) {
  return publicBase() + "/admin/#/users?edit=" + encodeURIComponent(email);
}

export function requestMessage(email, tool, reason, at) {
  const name = REQUEST_TOOLS[tool];
  const grantable = GRANTABLE.has(tool);
  const link = editLink(email);
  const when = melbourneTime(at);
  const note = grantable
    ? "To approve, open the link, tick " + name + " (and any finer options) and Save. Nothing has been changed."
    : name + " is a head-office tool and cannot be ticked for email-code users in Users. Nothing has been changed.";
  const text = [
    "[Express Help] Access request: " + name,
    "",
    "Requester: " + email,
    "Tool: " + name,
    "Time: " + when,
    "Reason: " + (reason || "(none given)"),
    "",
    "Edit this user: " + link,
    note,
    "",
    footerText(),
  ].join("\n");
  const row = (k, v) => '<tr><td style="padding:4px 14px 4px 0;color:#667085;vertical-align:top;white-space:nowrap">' + k + '</td><td style="padding:4px 0;word-break:break-word;overflow-wrap:anywhere">' + v + '</td></tr>';
  const html = '<!doctype html><html><body style="margin:0;background:#f2f4f8;padding:24px 12px;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;color:#101828">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px"><tr><td style="padding:28px 22px;overflow-wrap:anywhere">'
    + emailLogoHtml()
    + '<h1 style="font-size:20px;margin:0 0 10px">Access request: ' + esc(name) + '</h1>'
    + '<p style="font-size:15px;line-height:1.5;margin:0 0 14px"><strong style="word-break:break-word;overflow-wrap:anywhere">' + esc(email) + '</strong> would like access to <strong>' + esc(name) + '</strong>.</p>'
    + '<table role="presentation" width="100%" style="font-size:14px;line-height:1.5;margin:0 0 18px;table-layout:auto">'
    + row("Requester", esc(email)) + row("Tool", esc(name)) + row("Time", esc(when))
    + row("Reason", reason ? '<span data-testid="request-reason" style="white-space:pre-wrap">' + esc(reason) + '</span>' : '<span style="color:#667085">(none given)</span>')
    + '</table>'
    + '<p style="margin:0 0 18px"><a href="' + esc(link) + '" data-testid="request-link" style="display:inline-block;max-width:100%;box-sizing:border-box;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;text-align:center;word-break:break-word;overflow-wrap:anywhere">Open in Users</a></p>'
    + '<p style="font-size:13px;line-height:1.5;color:#475467;margin:0">' + esc(note) + '</p>'
    + '</td></tr></table>' + footerHtml() + '</td></tr></table></body></html>';
  return { to: OWNER_EMAIL, replyTo: email, subject: "[Express Help] Access request: " + name + " (" + email + ")", text, html };
}

async function readJson(key) {
  return rateStore().get(key, { type: "json" }).catch(() => null);
}

/** Which tools this person lacks (the server's own view, same as the menu). */
export async function missingTools(actor) {
  const access = await ticketAccess(actor).catch(() => ({ queues: [] }));
  const has = new Set(tabsFor(actor, access.queues || []));
  if (has.has("pos")) has.add("sites");
  return Object.keys(REQUEST_TOOLS).filter((tool) => !has.has(tool));
}

function eligible(actor) {
  return !!actor && actor.kind === "verified-identity" && actor.provider === "otp" && !!actor.email && actor.owner !== true;
}

/** { sent, at, until } for the "Request sent" state; survives a refresh until the cooldown ends. */
export async function requestStatus(actor, tool) {
  if (!eligible(actor)) return { status: 403, error: "Not available." };
  if (!Object.hasOwn(REQUEST_TOOLS, tool)) return { status: 400, error: "Unknown tool." };
  const last = await readJson(`arq/last/${emailKey(actor.email)}/${tool}`);
  const until = last ? last.at + HOUR : 0;
  if (last && until > now()) return { status: 200, body: { sent: true, at: last.at, until } };
  return { status: 200, body: { sent: false } };
}

export async function submitRequest(actor, body) {
  if (!eligible(actor)) return { status: 403, error: "Not available." };
  const tool = typeof body?.tool === "string" ? body.tool : "";
  if (!Object.hasOwn(REQUEST_TOOLS, tool)) return { status: 400, error: "Unknown tool." };
  if (body?.reason != null && typeof body.reason !== "string") return { status: 400, error: "The reason must be text." };
  if (typeof body?.reason === "string" && body.reason.length > REASON_MAX * 4) return { status: 400, error: "The reason is too long." };
  if (!(await missingTools(actor)).includes(tool)) return { status: 409, error: "You already have access to " + REQUEST_TOOLS[tool] + "." };
  const ek = emailKey(actor.email);
  const status = (await requestStatus(actor, tool)).body;
  if (status?.sent) return { status: 429, error: REQUEST_LIMIT_TOOL, body: { error: REQUEST_LIMIT_TOOL, sent: true, at: status.at, until: status.until } };
  if (!mailAvailable()) return { status: 503, error: REQUEST_FAILED };
  const t = now();
  const hourKey = `arq/h/${ek}/${tool}/${Math.floor(t / HOUR)}`;
  const dayKey = `arq/d/${ek}/${Math.floor(t / DAY)}`;
  const hour = await conditionalIncrement(rateStore(), hourKey, 1);
  if (!hour.ok) return hour.reason === "limit" ? { status: 429, error: REQUEST_LIMIT_TOOL } : { status: 503, error: REQUEST_FAILED };
  const day = await conditionalIncrement(rateStore(), dayKey, PER_DAY);
  if (!day.ok) {
    await rateStore().delete(hourKey);
    return day.reason === "limit" ? { status: 429, error: REQUEST_LIMIT_DAY } : { status: 503, error: REQUEST_FAILED };
  }
  const reason = cleanReason(body?.reason);
  const message = { ...requestMessage(actor.email, tool, reason, t), idempotencyKey: "arq-" + ek.slice(0, 16) + "-" + tool + "-" + Math.floor(t / HOUR) };
  let result;
  try { result = await deliver(message); } catch { result = { status: "unknown" }; }
  if (result?.status !== "sent") {
    // Give the attempt back so a mail hiccup does not lock the person out.
    await rateStore().delete(hourKey);
    const row = await rateStore().getWithMetadata(dayKey, { type: "json", consistency: "strong" }).catch(() => null);
    if (row?.etag && row.data?.n > 0) await rateStore().setJSON(dayKey, { n: row.data.n - 1 }, { onlyIfMatch: row.etag }).catch(() => null);
    return { status: 502, error: REQUEST_FAILED };
  }
  await rateStore().setJSON(`arq/last/${ek}/${tool}`, { at: t });
  return { status: 200, body: { ok: true, sent: true, at: t, until: t + HOUR, message: REQUEST_SENT } };
}
