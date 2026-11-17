import crypto from "node:crypto";
import { promisify } from "node:util";
import { conditionalIncrement, credStore, publicBase, rateStore } from "./lib.mjs";
import { deliver, mailAvailable } from "./mail.mjs";
import { footerHtml, footerText } from "./footer.mjs";

/**
 * Password credentials and set-password / reset links for Users (email-code users).
 * - Passwords: scrypt (per-user random salt), stored only as a hash. Never logged.
 * - Links: 32 random bytes; only a SHA-256 of the secret is stored; compared in constant time;
 *   single use (conditional write), expiring, and replaced by a newer link of the same kind.
 * - Permissions are not stored here: the session is the existing email-code session, and access comes from the Users list.
 */
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_PER_EMAIL = 8;
const LOGIN_PER_SOURCE = 20;
const FORGOT_PER_EMAIL = 3;
const FORGOT_PER_SOURCE = 8;
const TOKEN_PER_SOURCE = 30;
const INVITE_RESEND_PER_HOUR = 5;
const DUMMY_SALT = "00000000000000000000000000000000";

let clock = () => Date.now();
export function setCredentialsTestHooks({ now = null } = {}) { clock = typeof now === "function" ? now : () => Date.now(); }
export const now = () => clock();

export function emailKey(email) {
  return crypto.createHash("sha256").update("cred-email\n" + String(email || "").trim().toLowerCase()).digest("hex");
}

/* ---------- password policy and hashing ---------- */

const COMMON = new Set(["password", "password1", "password12", "password123", "passw0rd123", "1234567890", "12345678910", "123456789012", "qwertyuiop", "qwerty12345", "qwerty123456", "1q2w3e4r5t", "iloveyou123", "letmein1234", "welcome123", "welcome1234", "admin12345", "administrator", "changeme123", "abc1234567", "abcdefghij", "0123456789", "1111111111", "0000000000", "liberty123", "liberty1234", "libertyretail", "expresshelp", "expresshelp1", "express1234", "shell123456", "shellexpress", "monkey12345", "football123", "baseball123", "dragon12345", "sunshine123", "princess123", "trustno1234", "p@ssw0rd123", "p@ssword123", "password!23", "summer2026", "spring2026", "winter2026", "autumn2026", "november2026"]);

/** Returns "" when acceptable, otherwise a short instruction. */
export function passwordProblem(password, email = "") {
  const value = typeof password === "string" ? password : "";
  if (value.length < PASSWORD_MIN) return "Use at least " + PASSWORD_MIN + " characters.";
  if (value.length > PASSWORD_MAX) return "Use at most " + PASSWORD_MAX + " characters.";
  const lower = value.toLowerCase();
  const address = String(email || "").trim().toLowerCase();
  const local = address.split("@")[0];
  if (address && (lower === address || (local.length >= 4 && lower === local))) return "The password cannot be your email address.";
  if (local.length >= 5 && lower.includes(local)) return "The password cannot contain your email name.";
  if (new Set(value).size < 4) return "Use a less repetitive password.";
  const squashed = lower.replace(/[^a-z0-9@!]/g, "");
  if (COMMON.has(lower) || COMMON.has(squashed)) return "That password is too common. Choose another.";
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower) && value.length <= 12) return "That password is too easy to guess. Choose another.";
  return "";
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(String(password), salt, 32, SCRYPT)).toString("hex");
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

/** Always does one scrypt, so a missing account takes about as long as a wrong password. */
export async function verifyPasswordHash(password, stored) {
  const parts = String(stored || "").split("$");
  const ok = parts.length === 6 && parts[0] === "scrypt";
  const [N, r, p] = ok ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : [SCRYPT.N, SCRYPT.r, SCRYPT.p];
  const salt = ok ? parts[4] : DUMMY_SALT;
  const want = ok ? parts[5] : "0".repeat(64);
  const have = (await scrypt(String(password), salt, 32, { N, r, p, maxmem: SCRYPT.maxmem })).toString("hex");
  const same = have.length === want.length && crypto.timingSafeEqual(Buffer.from(have), Buffer.from(want));
  return ok && same;
}

export async function hasPassword(email) {
  const row = await credStore().get("pw/" + emailKey(email), { type: "json" });
  return !!row?.hash;
}

export async function storedHash(email) {
  const row = await credStore().get("pw/" + emailKey(email), { type: "json" });
  return row?.hash || "";
}

export async function writePassword(email, password) {
  const hash = await hashPassword(password);
  await credStore().setJSON("pw/" + emailKey(email), { hash, setAt: new Date(now()).toISOString(), v: 1 });
}

/* ---------- rate limits (Blobs counters; the source is hashed, never stored raw) ---------- */

export function sourceKey(req) {
  const ip = String(req.headers.get("x-nf-client-connection-ip") || "").trim();
  if (ip && ip.length <= 64 && /^[0-9a-f:.]+$/i.test(ip)) return crypto.createHash("sha256").update("cred-src\n" + ip).digest("hex").slice(0, 24);
  return "untrusted";
}

/** Returns null when allowed, or { status, error }. */
export async function limit(req, kind, email) {
  const windowId = Math.floor(now() / WINDOW_MS);
  const src = sourceKey(req);
  const perEmail = { login: LOGIN_PER_EMAIL, forgot: FORGOT_PER_EMAIL }[kind];
  const perSource = { login: LOGIN_PER_SOURCE, forgot: FORGOT_PER_SOURCE, token: TOKEN_PER_SOURCE }[kind];
  const store = rateStore();
  const checks = [];
  if (perEmail && email) checks.push(await conditionalIncrement(store, `pw/${kind}/email/${emailKey(email)}/${windowId}`, perEmail));
  checks.push(await conditionalIncrement(store, `pw/${kind}/src/${src}/${windowId}`, perSource));
  if (checks.some((c) => !c.ok && c.reason === "unsupported")) return { status: 503, error: "Password sign-in is temporarily unavailable." };
  if (checks.some((c) => c.reason === "limit")) return { status: 429, error: "Too many attempts. Wait a few minutes and try again." };
  return null;
}

/* ---------- single-use links ---------- */

function digestOf(secret) { return crypto.createHash("sha256").update("cred-link\n" + secret).digest("hex"); }
function sameHex(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function swapActive(kind, key, id) {
  const slot = `active/${kind}/${key}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const meta = await credStore().getWithMetadata(slot, { type: "json", consistency: "strong" });
    if (!meta) {
      const created = await credStore().setJSON(slot, { id }, { onlyIfNew: true });
      if (created?.modified === true) return "";
      continue;
    }
    const write = await credStore().setJSON(slot, { id }, { onlyIfMatch: meta.etag });
    if (write?.modified === true) return meta.data?.id || "";
  }
  return null;
}

async function markUsed(id, why) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const meta = await credStore().getWithMetadata("tok/" + id, { type: "json", consistency: "strong" });
    if (!meta?.data) return false;
    if (meta.data.used) return false;
    const write = await credStore().setJSON("tok/" + id, { ...meta.data, used: true, usedAt: now(), why }, { onlyIfMatch: meta.etag });
    if (write?.modified === true) return true;
    if (write?.modified !== false) return false;
  }
  return false;
}

/** Makes a link of this kind for this address; any earlier unused link of the same kind stops working. Returns the secret to put in the email. */
export async function issueLink(email, kind) {
  const key = emailKey(email);
  const id = "t" + crypto.randomBytes(12).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  const ttl = kind === "reset" ? RESET_TTL_MS : INVITE_TTL_MS;
  const record = { id, kind, emailKey: key, email, digest: digestOf(secret), createdAt: now(), exp: now() + ttl, used: false };
  await credStore().setJSON("tok/" + id, record, { onlyIfNew: true });
  const previous = await swapActive(kind, key, id);
  if (previous == null) { await markUsed(id, "superseded"); return null; }
  if (previous && previous !== id) await markUsed(previous, "superseded");
  return { id, token: id + "." + secret, exp: record.exp };
}

/** Looks a link up without using it. reason: invalid | expired | used. */
export async function peekLink(token) {
  const match = /^(t[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ""));
  if (!match) return { ok: false, reason: "invalid" };
  const row = await credStore().get("tok/" + match[1], { type: "json" });
  if (!row || !sameHex(digestOf(match[2]), row.digest)) return { ok: false, reason: "invalid" };
  if (row.used) return { ok: false, reason: "used" };
  if (row.exp < now()) return { ok: false, reason: "expired" };
  const active = await credStore().get(`active/${row.kind}/${row.emailKey}`, { type: "json" });
  if (active?.id !== row.id) return { ok: false, reason: "used" };
  return { ok: true, id: row.id, kind: row.kind, email: row.email };
}

/** Uses the link exactly once (conditional write). */
export async function consumeLink(token) {
  const peek = await peekLink(token);
  if (!peek.ok) return peek;
  const won = await markUsed(peek.id, "used");
  return won ? peek : { ok: false, reason: "used" };
}

/** After a password is set, every other link for that address is dead. */
export async function killLinks(email) {
  const key = emailKey(email);
  for (const kind of ["invite", "reset"]) {
    const active = await credStore().get(`active/${kind}/${key}`, { type: "json" });
    if (active?.id) await markUsed(active.id, "password-set");
  }
}

/** Removes the password and every link (used when a user is removed, so a re-added user starts clean). */
export async function clearCredentials(email) {
  const key = emailKey(email);
  await killLinks(email);
  await credStore().delete("pw/" + key);
  for (const kind of ["invite", "reset"]) await credStore().delete(`active/${kind}/${key}`);
}

/** Invite status for the Users list: active | invited | expired | none. */
export async function passwordStatus(email) {
  const key = emailKey(email);
  if (await hasPassword(email)) {
    const row = await credStore().get("pw/" + key, { type: "json" });
    return { state: "active", at: row?.setAt || "" };
  }
  const active = await credStore().get(`active/invite/${key}`, { type: "json" });
  const tok = active?.id ? await credStore().get("tok/" + active.id, { type: "json" }) : null;
  if (!tok) return { state: "none" };
  if (tok.used) return { state: "none", lastInviteAt: new Date(tok.createdAt).toISOString() };
  if (tok.exp < now()) return { state: "expired", sentAt: new Date(tok.createdAt).toISOString(), expiredAt: new Date(tok.exp).toISOString() };
  return { state: "invited", sentAt: new Date(tok.createdAt).toISOString(), expiresAt: new Date(tok.exp).toISOString() };
}

/* ---------- email ---------- */

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function linkUrl(token) {
  return publicBase() + "/set-password#" + token;
}

export function inviteMessage(email, token, kind, exp) {
  const url = linkUrl(token);
  const reset = kind === "reset";
  const hours = Math.round((exp - now()) / 3600000);
  const when = reset ? "1 hour" : hours + " hours (3 days)";
  const subject = reset ? "Reset your Express Help password" : "Set your Express Help password";
  const lead = reset ? "We got a request to reset the password for your Express Help sign-in." : "You have been added to Express Help. Set a password to sign in.";
  const text = [
    lead,
    "",
    (reset ? "Choose a new password: " : "Set your password: ") + url,
    "",
    "The link works once and expires in " + when + ". Your email address is " + email + ".",
    "You can also sign in without a password: on the Express Help sign-in page choose \"Email me a code\".",
    reset ? "If you did not ask for this, ignore this message. Your password has not changed." : "If you were not expecting this, ignore this message. Nothing happens until the link is used.",
    "",
    footerText(),
  ].join("\n");
  const html = '<!doctype html><html><body style="margin:0;background:#f2f4f8;padding:24px 12px;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;color:#101828">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:28px">'
    + '<tr><td><div style="font-weight:700;font-size:18px;color:#0e1b4d;margin-bottom:18px">Express Help</div>'
    + '<h1 style="font-size:20px;margin:0 0 10px">' + esc(subject) + '</h1>'
    + '<p style="font-size:15px;line-height:1.5;margin:0 0 18px">' + esc(lead) + '</p>'
    + '<p style="margin:0 0 20px"><a href="' + esc(url) + '" data-testid="invite-link" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">' + (reset ? "Choose a new password" : "Set your password") + '</a></p>'
    + '<p style="font-size:13px;line-height:1.5;color:#475467;margin:0 0 8px">The link works once and expires in ' + esc(when) + '. Your sign-in email is <strong>' + esc(email) + '</strong>.</p>'
    + '<p style="font-size:13px;line-height:1.5;color:#475467;margin:0 0 8px">If the button does not work, paste this address into your browser:<br><span style="word-break:break-all">' + esc(url) + '</span></p>'
    + '<p style="font-size:13px;line-height:1.5;color:#475467;margin:0 0 8px">You can also sign in without a password: on the sign-in page choose &ldquo;Email me a code&rdquo;.</p>'
    + '<p style="font-size:13px;line-height:1.5;color:#475467;margin:0">' + (reset ? "If you did not ask for this, ignore this message. Your password has not changed." : "If you were not expecting this, ignore this message. Nothing happens until the link is used.") + '</p>'
    + '</td></tr></table>' + footerHtml() + '</td></tr></table></body></html>';
  return { to: email, subject, text, html };
}

/**
 * Sends an invite (kind "invite") or reset (kind "reset") email to one address that is already on the Users list.
 * The caller decides who may ask. Returns { status: "sent" | "not-configured" | "failed" | "unknown" }.
 */
export async function sendLinkEmail(email, kind) {
  if (!mailAvailable()) return { status: "not-configured" };
  const issued = await issueLink(email, kind);
  if (!issued) return { status: "failed" };
  const message = { ...inviteMessage(email, issued.token, kind, issued.exp), idempotencyKey: kind + "-" + issued.id };
  let result;
  try { result = await deliver(message); } catch { result = { status: "unknown" }; }
  const status = result?.status || "failed";
  if (status !== "sent") await markUsed(issued.id, "not-sent");
  return { status, exp: issued.exp };
}

/** Owner "Resend invite": at most 5 per address per hour. */
export async function inviteAllowed(email) {
  const windowId = Math.floor(now() / 3600000);
  const c = await conditionalIncrement(rateStore(), `pw/invite/${emailKey(email)}/${windowId}`, INVITE_RESEND_PER_HOUR);
  return c.ok === true;
}
