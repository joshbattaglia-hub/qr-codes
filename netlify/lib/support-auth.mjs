import crypto from "node:crypto";
import { conditionalIncrement, env, otpStore, rateStore } from "./lib.mjs";
import { OTP_LIMIT, OTP_REJECTED, OTP_UNAVAILABLE, sendOtpCode, setOtpTestHooks, trustedClientKey } from "./otp.mjs";
import { emailOf } from "./tickets.mjs";

export const PORTAL_DOMAIN = "libertyretail.com.au";

/** Requester portal identity: exact @libertyretail.com.au only (case-insensitive). No subdomains, no other lists. */
export function portalScope(value) {
  const email = emailOf(value);
  if (!email || email.split("@")[1] !== PORTAL_DOMAIN) return null;
  return { email };
}

const WINDOW_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const START_PER_EMAIL = 3;
const START_PER_IP = 8;
const START_UNTRUSTED = 8;
const VERIFY_PER_EMAIL = 8;
const VERIFY_PER_IP = 20;
const VERIFY_UNTRUSTED = 20;

export const SUPPORT_ACCEPTED = "If this address can open the support portal, a code will arrive shortly. If nothing arrives, the address is not approved or the message could not be sent.";
export const SUPPORT_SETUP = "Support sign-in is not operational.";

let clock = () => Date.now();

export function setSupportTestHooks({ deliver, now = null } = {}) {
  if (typeof deliver === "function") setOtpTestHooks({ deliver });
  clock = typeof now === "function" ? now : () => Date.now();
}

function now() { return clock(); }
function secret() { return env("OTP_SESSION_SECRET"); }
function supportReady() {
  return secret().length >= 32;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return "";
  return email;
}

function emailHash(email) {
  return crypto.createHash("sha256").update("support-email\n" + email).digest("hex");
}

function codeMac(id, code) {
  return crypto.createHmac("sha256", secret()).update(`support-v1\n${id}\n${code}`).digest("hex");
}

function sign(id, exp) {
  return crypto.createHmac("sha256", secret()).update(`support-session:${id}.${exp}`).digest("hex");
}

function sameHex(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function cookieBase(req) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* local http */ }
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function supportCookie(req, id, exp) {
  const maxAge = Math.max(0, Math.floor((exp - now()) / 1000));
  return `qr_support=${id}.${exp}.${sign(id, exp)}; ${cookieBase(req)}; Max-Age=${maxAge}`;
}

export function clearSupportCookie(req) {
  return `qr_support=; ${cookieBase(req)}; Max-Age=0`;
}

function uniform() {
  return { status: 200, body: { ok: true, message: SUPPORT_ACCEPTED } };
}

async function limited(req, kind, email) {
  const windowId = Math.floor(now() / WINDOW_MS);
  const hash = emailHash(email);
  const ip = trustedClientKey(req);
  const emailMax = kind === "start" ? START_PER_EMAIL : VERIFY_PER_EMAIL;
  const ipMax = ip === "untrusted"
    ? (kind === "start" ? START_UNTRUSTED : VERIFY_UNTRUSTED)
    : (kind === "start" ? START_PER_IP : VERIFY_PER_IP);
  const store = rateStore();
  const account = await conditionalIncrement(store, `support/${kind}/email/${hash}/${windowId}`, emailMax);
  const network = await conditionalIncrement(store, `support/${kind}/ip/${ip}/${windowId}`, ipMax);
  if (!account.ok && account.reason === "unsupported") return { status: 503, error: OTP_UNAVAILABLE };
  if (!network.ok && network.reason === "unsupported") return { status: 503, error: OTP_UNAVAILABLE };
  if (account.reason === "limit" || network.reason === "limit") return { status: 429, error: OTP_LIMIT };
  return null;
}

async function acquireLock(hash) {
  const key = "support/lock/" + hash;
  const created = await otpStore().setJSON(key, { exp: now() + 30000 }, { onlyIfNew: true });
  if (created?.modified === true) return true;
  const meta = await otpStore().getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!meta?.etag || !meta.data) return false;
  if (meta.data.exp > now()) return false;
  const replaced = await otpStore().setJSON(key, { exp: now() + 30000 }, { onlyIfMatch: meta.etag });
  return replaced?.modified === true;
}

async function releaseLock(hash) {
  await otpStore().delete("support/lock/" + hash);
}

async function patchChallenge(id, patch) {
  const key = "support/ch/" + id;
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await otpStore().getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!meta?.etag || !meta.data) return null;
    const next = { ...meta.data, ...patch };
    const write = await otpStore().setJSON(key, next, { onlyIfMatch: meta.etag });
    if (write?.modified === true) return next;
    if (write?.modified !== false) return null;
  }
  return null;
}

async function swapActive(hash, id) {
  const key = "support/active/" + hash;
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await otpStore().getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!meta) {
      const created = await otpStore().setJSON(key, { id }, { onlyIfNew: true });
      if (created?.modified === true) return "";
      if (created?.modified !== false) return null;
      continue;
    }
    if (!meta.etag) return null;
    const previous = meta.data?.id || "";
    const write = await otpStore().setJSON(key, { id }, { onlyIfMatch: meta.etag });
    if (write?.modified === true) return previous;
    if (write?.modified !== false) return null;
  }
  return null;
}

export async function startSupportCode(req, email) {
  if (!supportReady()) return { status: 503, error: SUPPORT_SETUP };
  const normalized = normalizeEmail(email);
  if (!normalized) return { status: 400, error: "Enter an email address." };
  const gate = await limited(req, "start", normalized);
  if (gate) return gate;
  const scope = portalScope(normalized);
  if (!scope) return uniform();
  const hash = emailHash(normalized);
  if (!(await acquireLock(hash))) return uniform();
  const id = "c" + crypto.randomBytes(16).toString("hex");
  try {
    const code = crypto.randomInt(0, 100000000).toString().padStart(8, "0");
    const record = {
      id,
      emailHash: hash,
      digest: codeMac(id, code),
      exp: now() + CODE_TTL_MS,
      attempts: 0,
      consumed: false,
      pending: true,
      superseded: false,
    };
    const created = await otpStore().setJSON("support/ch/" + id, record, { onlyIfNew: true });
    if (created?.modified !== true) return uniform();
    let result;
    try { result = await sendOtpCode(normalized, code, id); }
    catch { result = { status: "unknown" }; }
    if (result?.status !== "sent") {
      await patchChallenge(id, { consumed: true, pending: true, superseded: true });
      return uniform();
    }
    const activated = await patchChallenge(id, { pending: false });
    if (!activated || activated.pending !== false) {
      await patchChallenge(id, { consumed: true, superseded: true });
      return uniform();
    }
    const previous = await swapActive(hash, id);
    if (previous == null) {
      await patchChallenge(id, { consumed: true, superseded: true });
      return uniform();
    }
    if (previous && previous !== id) await patchChallenge(previous, { consumed: true, superseded: true });
    return uniform();
  } finally {
    await releaseLock(hash);
  }
}

async function consume(hash, code) {
  const active = await otpStore().get("support/active/" + hash, { type: "json" });
  const id = active?.id || "";
  if (!id) return { ok: false };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await otpStore().getWithMetadata("support/ch/" + id, { type: "json", consistency: "strong" });
    if (!meta?.etag || !meta.data) return { ok: false };
    const row = meta.data;
    if (row.consumed || row.pending || row.superseded || row.exp < now() || row.emailHash !== hash) return { ok: false };
    const matches = sameHex(codeMac(id, code), row.digest);
    if (!matches) {
      const attempts = Number(row.attempts) + 1;
      const next = { ...row, attempts, consumed: attempts >= MAX_ATTEMPTS };
      const write = await otpStore().setJSON("support/ch/" + id, next, { onlyIfMatch: meta.etag });
      if (write?.modified === true) return { ok: false };
      if (write?.modified === false) continue;
      return { ok: false };
    }
    const write = await otpStore().setJSON("support/ch/" + id, { ...row, consumed: true, attempts: Number(row.attempts) + 1 }, { onlyIfMatch: meta.etag });
    if (write?.modified === true) return { ok: true };
    if (write?.modified === false) continue;
    return { ok: false };
  }
  return { ok: false };
}

export async function verifySupportCode(req, email, code) {
  if (!supportReady()) return { status: 503, error: SUPPORT_SETUP };
  const normalized = normalizeEmail(email);
  const digits = String(code || "").trim();
  if (!normalized || !/^\d{8}$/.test(digits)) return { status: 401, error: OTP_REJECTED };
  const gate = await limited(req, "verify", normalized);
  if (gate) return gate;
  const scope = portalScope(normalized);
  if (!scope) return { status: 401, error: OTP_REJECTED };
  const won = await consume(emailHash(normalized), digits);
  if (!won.ok) return { status: 401, error: OTP_REJECTED };
  const id = "s" + crypto.randomBytes(16).toString("hex");
  const exp = now() + SESSION_TTL_MS;
  await otpStore().setJSON("support/sess/" + id, { id, email: scope.email, iat: now(), exp });
  return { status: 200, body: { ok: true, email: scope.email }, cookie: supportCookie(req, id, exp) };
}

export async function supportFromRequest(req) {
  if (!supportReady()) return null;
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_support=(s[a-f0-9]{32})\.(\d+)\.([a-f0-9]+)/);
  if (!match || +match[2] < now()) return null;
  if (!sameHex(sign(match[1], match[2]), match[3])) return null;
  const row = await otpStore().get("support/sess/" + match[1], { type: "json" });
  if (!row || row.id !== match[1] || row.exp < now()) return null;
  return portalScope(row.email);
}

export async function deleteSupportSession(req) {
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_support=(s[a-f0-9]{32})\.(\d+)\.([a-f0-9]+)/);
  if (!match) return;
  await otpStore().delete("support/sess/" + match[1]);
}
