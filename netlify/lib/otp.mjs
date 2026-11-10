import crypto from "node:crypto";
import { conditionalIncrement, env, otpStore, rateStore } from "./lib.mjs";
import { deliver, mailMode } from "./mail.mjs";
import { APPROVER_FACTS, PREPARER_CLASSES } from "./pos-approval.mjs";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ROTATE_AFTER_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Explicit site ids only. 200 covers the current 90 imported sites with room for a few additions. It is not all-sites access. */
export const OTP_EXPLICIT_SITE_CAP = 200;
const START_PER_EMAIL = 3;
const START_PER_IP = 8;
const START_UNTRUSTED = 8;
const VERIFY_PER_EMAIL = 8;
const VERIFY_PER_IP = 20;
const VERIFY_UNTRUSTED = 20;

export const OTP_SETUP = "Email codes are not operational. Set OTP_SESSION_SECRET (at least 32 characters), OTP_ALLOWLIST, RESEND_API_KEY, and RESEND_FROM. No code is sent and no session is created.";
export const OTP_ACCEPTED = "If this address is approved for an email code, a message will arrive shortly. If nothing arrives, the address is not approved or the message could not be sent.";
export const OTP_REJECTED = "That code was not accepted.";
export const OTP_LIMIT = "Too many attempts. Wait and try again.";
export const OTP_UNAVAILABLE = "Email codes are temporarily unavailable.";

let testDeliver = null;
let clock = () => Date.now();

/** In-process test hook. No environment variable can turn this on. */
export function setOtpTestHooks({ deliver: deliverImpl = null, now = null } = {}) {
  testDeliver = typeof deliverImpl === "function" ? deliverImpl : null;
  clock = typeof now === "function" ? now : () => Date.now();
}

function now() {
  return clock();
}

function secret() {
  return env("OTP_SESSION_SECRET");
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) return "";
  return email;
}

export function parseAllowlist(raw = env("OTP_ALLOWLIST")) {
  if (!raw || raw.length > 20000) return { entries: new Map(), error: raw ? "OTP_ALLOWLIST is too large" : "OTP_ALLOWLIST is missing" };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { entries: new Map(), error: "OTP_ALLOWLIST is not valid JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { entries: new Map(), error: "OTP_ALLOWLIST must be an object keyed by email" };
  const entries = new Map();
  for (const [rawEmail, value] of Object.entries(parsed)) {
    const email = normalizeEmail(rawEmail);
    if (!email || !value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value.allSites === true || value.unassigned === true || value.role === "head" || value.role === "manager") continue;
    if (value.disabled === true) continue;
    let approverKey = "";
    if (value.approverKey != null && value.approverKey !== "") {
      const key = String(value.approverKey);
      const fact = APPROVER_FACTS[key];
      if (!fact || fact.email !== email) continue;
      approverKey = key;
    }
    let preparerClass = "";
    if (value.preparerClass != null && value.preparerClass !== "") {
      const preparer = String(value.preparerClass);
      if (!PREPARER_CLASSES.includes(preparer)) continue;
      if (email === APPROVER_FACTS.neil.email) continue;
      if (preparer === "joshua" && email !== APPROVER_FACTS.joshua.email) continue;
      if ((preparer === "jeremy" || preparer === "regional-business-manager") && email === APPROVER_FACTS.joshua.email) continue;
      preparerClass = preparer;
    }
    if (!approverKey && !preparerClass) continue;
    if (value.siteIds != null && !Array.isArray(value.siteIds)) continue;
    const siteIds = [];
    let sitesOk = true;
    for (const id of value.siteIds || []) {
      if (typeof id !== "string" || !/^s[a-f0-9]{8}$/.test(id)) { sitesOk = false; break; }
      siteIds.push(id);
    }
    const unique = [...new Set(siteIds)];
    if (!sitesOk || unique.length > OTP_EXPLICIT_SITE_CAP) continue;
    entries.set(email, { email, approverKey, preparerClass, siteIds: unique, allSites: false, disabled: false });
  }
  return { entries, error: "" };
}

export function allowlist() {
  return parseAllowlist().entries;
}

function mailReady() {
  return testDeliver != null || mailMode() === "resend";
}

export function otpStatus() {
  const map = parseAllowlist();
  const secretOk = secret().length >= 32;
  const listOk = !map.error && map.entries.size > 0;
  const mock = testDeliver != null;
  const resend = mailMode() === "resend";
  const operational = secretOk && listOk && (mock || resend);
  return {
    configured: operational,
    operational,
    mock,
    resend,
    secretConfigured: secretOk,
    allowlistConfigured: listOk,
    mailMode: mock ? "mock" : mailMode(),
    setup: operational ? "" : OTP_SETUP,
  };
}

export function otpOperational() {
  return otpStatus().operational;
}

function emailHash(email) {
  return crypto.createHash("sha256").update("otp-email\n" + email).digest("hex");
}

function codeMac(id, code) {
  return crypto.createHmac("sha256", secret()).update(`otp-v1\n${id}\n${code}`).digest("hex");
}

function sameHex(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export function trustedClientKey(req) {
  const netlifyIp = String(req.headers.get("x-nf-client-connection-ip") || "").trim();
  if (netlifyIp && netlifyIp.length <= 64 && /^[0-9a-f:.]+$/i.test(netlifyIp)) {
    return crypto.createHash("sha256").update("otp-nf\n" + netlifyIp).digest("hex").slice(0, 24);
  }
  return "untrusted";
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
  const account = await conditionalIncrement(store, `otp/${kind}/email/${hash}/${windowId}`, emailMax);
  const network = await conditionalIncrement(store, `otp/${kind}/ip/${ip}/${windowId}`, ipMax);
  if (!account.ok && account.reason === "unsupported") return { status: 503, error: OTP_UNAVAILABLE };
  if (!network.ok && network.reason === "unsupported") return { status: 503, error: OTP_UNAVAILABLE };
  if (account.reason === "limit" || network.reason === "limit") return { status: 429, error: OTP_LIMIT };
  return null;
}

function uniform() {
  return { status: 200, body: { ok: true, message: OTP_ACCEPTED } };
}

function newCode() {
  return crypto.randomInt(0, 100000000).toString().padStart(8, "0");
}

async function patchChallenge(id, patch) {
  const key = "ch/" + id;
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
  const key = "active/" + hash;
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

async function acquireLock(hash) {
  const key = "lock/" + hash;
  const created = await otpStore().setJSON(key, { exp: now() + 30000 }, { onlyIfNew: true });
  if (created?.modified === true) return true;
  const meta = await otpStore().getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!meta?.etag || !meta.data) return false;
  if (meta.data.exp > now()) return false;
  const replaced = await otpStore().setJSON(key, { exp: now() + 30000 }, { onlyIfMatch: meta.etag });
  return replaced?.modified === true;
}

async function releaseLock(hash) {
  await otpStore().delete("lock/" + hash);
}

export async function sendOtpCode(email, code, id) {
  const message = {
    to: email,
    subject: "Express Help sign-in code",
    idempotencyKey: "otp-" + id,
    text: [
      "Your Express Help sign-in code is " + code + ".",
      "It expires in 10 minutes and works once.",
      "Enter it on the Express Help sign-in page. This message is not a link and it does not approve a request.",
      "If you did not ask for a code, ignore this message.",
    ].join("\n"),
  };
  if (testDeliver) return testDeliver(message);
  return deliver(message);
}

export async function startOtp(req, email) {
  if (!otpOperational()) return { status: 403, error: OTP_SETUP };
  const normalized = normalizeEmail(email);
  if (!normalized) return { status: 400, error: "Enter an email address." };
  const gate = await limited(req, "start", normalized);
  if (gate) return gate;
  const entry = allowlist().get(normalized);
  if (!entry) return uniform();
  const hash = emailHash(normalized);
  if (!(await acquireLock(hash))) return uniform();
  const id = "c" + crypto.randomBytes(16).toString("hex");
  try {
    const code = newCode();
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
    const created = await otpStore().setJSON("ch/" + id, record, { onlyIfNew: true });
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
  const active = await otpStore().get("active/" + hash, { type: "json" });
  const id = active?.id || "";
  if (!id) return { ok: false };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await otpStore().getWithMetadata("ch/" + id, { type: "json", consistency: "strong" });
    if (!meta?.etag || !meta.data) return { ok: false };
    const row = meta.data;
    if (row.consumed || row.pending || row.superseded || row.exp < now() || row.emailHash !== hash) return { ok: false };
    const matches = sameHex(codeMac(id, code), row.digest);
    if (!matches) {
      const attempts = Number(row.attempts) + 1;
      const next = { ...row, attempts, consumed: attempts >= MAX_ATTEMPTS };
      const write = await otpStore().setJSON("ch/" + id, next, { onlyIfMatch: meta.etag });
      if (write?.modified === true) return { ok: false };
      if (write?.modified === false) continue;
      return { ok: false };
    }
    const write = await otpStore().setJSON("ch/" + id, { ...row, consumed: true, attempts: Number(row.attempts) + 1 }, { onlyIfMatch: meta.etag });
    if (write?.modified === true) return { ok: true, emailHash: hash };
    if (write?.modified === false) continue;
    return { ok: false };
  }
  return { ok: false };
}

function cookieBase(req) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* local http */ }
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function sign(id, exp) {
  return crypto.createHmac("sha256", secret()).update(`otp-session:${id}.${exp}`).digest("hex");
}

export function otpCookie(req, id, exp) {
  const maxAge = Math.max(0, Math.floor((exp - now()) / 1000));
  return `qr_otp=${id}.${exp}.${sign(id, exp)}; ${cookieBase(req)}; Max-Age=${maxAge}`;
}

export function clearOtpCookie(req) {
  return `qr_otp=; ${cookieBase(req)}; Max-Age=0`;
}

export function actorFromOtp(email) {
  const entry = allowlist().get(email);
  if (!entry) return null;
  const fact = entry.approverKey ? APPROVER_FACTS[entry.approverKey] : null;
  return {
    id: "otp:" + emailHash(email).slice(0, 16),
    kind: "verified-identity",
    provider: "otp",
    email: entry.email,
    name: fact?.name || "Preparer",
    role: entry.approverKey ? "approver" : "preparer",
    approverKey: entry.approverKey,
    preparerClass: entry.preparerClass,
    siteIds: entry.siteIds,
    allSites: false,
    unassigned: false,
  };
}

async function readSession(req) {
  if (secret().length < 32) return null;
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_otp=(o[a-f0-9]{32})\.(\d+)\.([a-f0-9]+)/);
  if (!match || +match[2] < now()) return null;
  const sig = sign(match[1], match[2]);
  if (!sameHex(sig, match[3])) return null;
  const row = await otpStore().get("sess/" + match[1], { type: "json" });
  if (!row || row.id !== match[1] || row.exp < now()) return null;
  return row;
}

export async function otpFromRequest(req) {
  const row = await readSession(req);
  if (!row) return null;
  return actorFromOtp(row.email) || {
    id: "otp:revoked",
    kind: "verified-identity",
    provider: "otp",
    email: "",
    name: "Email code",
    role: "",
    approverKey: "",
    preparerClass: "",
    siteIds: [],
    allSites: false,
    unassigned: false,
  };
}

export async function otpSessionView(req) {
  const row = await readSession(req);
  if (!row) return { actor: null, cookie: "" };
  const actor = actorFromOtp(row.email);
  if (!actor) {
    await otpStore().delete("sess/" + row.id);
    return { actor: null, cookie: clearOtpCookie(req) };
  }
  if (now() - row.iat < ROTATE_AFTER_MS) return { actor, cookie: "" };
  await otpStore().delete("sess/" + row.id);
  const created = await createSession(row.email, row.iat);
  return { actor, cookie: otpCookie(req, created.id, created.exp) };
}

async function createSession(email, iat = now()) {
  const id = "o" + crypto.randomBytes(16).toString("hex");
  const exp = iat + SESSION_TTL_MS;
  const record = { id, email, iat, exp };
  await otpStore().setJSON("sess/" + id, record);
  return record;
}

export async function verifyOtp(req, email, code) {
  if (!otpOperational()) return { status: 403, error: OTP_SETUP };
  const normalized = normalizeEmail(email);
  const digits = String(code || "").trim();
  if (!normalized || !/^\d{8}$/.test(digits)) return { status: 401, error: OTP_REJECTED };
  const gate = await limited(req, "verify", normalized);
  if (gate) return gate;
  const entry = allowlist().get(normalized);
  if (!entry) return { status: 401, error: OTP_REJECTED };
  const won = await consume(emailHash(normalized), digits);
  if (!won.ok) return { status: 401, error: OTP_REJECTED };
  const session = await createSession(normalized);
  const actor = actorFromOtp(normalized);
  if (!actor) return { status: 401, error: OTP_REJECTED };
  return { status: 200, actor, cookie: otpCookie(req, session.id, session.exp) };
}

export async function deleteOtpSession(req) {
  const row = await readSession(req);
  if (row) await otpStore().delete("sess/" + row.id);
}
