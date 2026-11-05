import crypto from "node:crypto";
import { authed, conditionalIncrement, env, json, rateStore, sitesStore, staffStore } from "./lib.mjs";

const secret = () => crypto.createHash("sha256").update("qr-staff-sess:" + env("ADMIN_PASSWORD")).digest();

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 32).toString("hex");
  try {
    return next.length === hash.length && crypto.timingSafeEqual(Buffer.from(next), Buffer.from(hash));
  } catch { return false; }
}

function cookieBase(req) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* local http */ }
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function makeStaffCookie(req, id) {
  const exp = Date.now() + 7 * 864e5;
  const sig = crypto.createHmac("sha256", secret()).update(`${id}.${exp}`).digest("hex");
  return `qr_staff=${id}.${exp}.${sig}; ${cookieBase(req)}; Max-Age=604800`;
}

export function clearStaffCookie(req) {
  return `qr_staff=; ${cookieBase(req)}; Max-Age=0`;
}

export function publicStaff(staff) {
  if (!staff) return null;
  return {
    id: staff.id,
    name: staff.name || "",
    email: staff.email || "",
    role: "manager",
    siteIds: Array.isArray(staff.siteIds) ? staff.siteIds.filter((id) => typeof id === "string" && id) : [],
    disabled: !!staff.disabled,
    created: staff.created || null,
  };
}

async function staffFromCookie(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_staff=([a-z0-9]+)\.(\d+)\.([a-f0-9]+)/i);
  if (!m || +m[2] < Date.now()) return null;
  const sig = crypto.createHmac("sha256", secret()).update(`${m[1]}.${m[2]}`).digest("hex");
  try {
    if (sig.length !== m[3].length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(m[3]))) return null;
  } catch { return null; }
  const staff = await staffStore().get(m[1], { type: "json" }).catch(() => null);
  if (!staff || staff.disabled) return null;
  return publicStaff(staff);
}

/** Head office is the existing ADMIN_PASSWORD session. Managers are explicit staff records. */
export async function actorFrom(req) {
  if (authed(req)) return { role: "head", id: "head-office", siteIds: null, name: "Head office" };
  const staff = await staffFromCookie(req);
  if (!staff) return null;
  return { role: "manager", id: staff.id, siteIds: staff.siteIds, name: staff.name || staff.email };
}

export function canSeeSite(actor, siteId) {
  if (!actor) return false;
  if (actor.role === "head") return true;
  if (!siteId) return false;
  return Array.isArray(actor.siteIds) && actor.siteIds.includes(siteId);
}

export function canAssignSite(actor, siteId) {
  if (!actor) return false;
  if (actor.role === "head") return true;
  return !!siteId && canSeeSite(actor, siteId);
}

export function siteOf(record) {
  return typeof record?.siteId === "string" ? record.siteId : "";
}

/** Cross-site browser requests must not ride a cookie. Missing Origin is allowed for non-browser clients. */
export function originBlocked(req) {
  const method = req.method || "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if ((req.headers.get("sec-fetch-site") || "").toLowerCase() === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host !== new URL(req.url).host; }
  catch { return true; }
}

export const LOGIN_LIMIT = 8;

/** Counts attempts in Blobs. Fails closed when the conditional counter cannot be recorded. */
export async function loginLimited(req, bucket) {
  const windowId = Math.floor(Date.now() / 600000);
  const ip = crypto.createHash("sha256").update("login-ip\n" + (req.headers.get("x-forwarded-for") || "local")).digest("hex").slice(0, 16);
  const store = rateStore();
  const account = await conditionalIncrement(store, `acct/${bucket}/${windowId}`, LOGIN_LIMIT);
  const network = await conditionalIncrement(store, `ip/${ip}/${windowId}`, 80);
  if (!account.ok && account.reason === "unsupported") return true;
  if (!network.ok && network.reason === "unsupported") return true;
  return account.reason === "limit" || network.reason === "limit";
}

/** Keep the current site unless this request assigns one the actor is allowed to use. */
export async function assignSite(actor, record, body) {
  if (!actor) return { error: "forbidden" };
  const current = record ? siteOf(record) : "";
  const changing = !!body && Object.prototype.hasOwnProperty.call(body, "siteId");
  if (!changing) {
    if (record && !canSeeSite(actor, current)) return { error: "forbidden" };
    if (!record && actor.role !== "head") return { error: "forbidden" };
    return { siteId: current };
  }
  if (body.siteId != null && typeof body.siteId !== "string") return { error: "forbidden" };
  const next = typeof body.siteId === "string" ? body.siteId : "";
  if (next && !/^s[a-f0-9]{8}$/.test(next)) return { error: "forbidden" };
  if (!canAssignSite(actor, next)) return { error: "forbidden" };
  if (next) {
    const site = await sitesStore().get(next, { type: "json" });
    if (!site) return { error: "unknown-site" };
  }
  return { siteId: next };
}

export function forbidden() {
  return json(403, { error: "Forbidden" });
}

export function assignmentResponse(assigned) {
  if (!assigned?.error) return null;
  if (assigned.error === "unknown-site") return json(400, { error: "Unknown site" });
  return forbidden();
}

export function jsonCookies(status, body, cookies) {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function unauthorised() {
  return json(401, { error: "Unauthorized" });
}
