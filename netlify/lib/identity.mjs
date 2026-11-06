import crypto from "node:crypto";
import { clearCookie, env, identities, json, sitesStore } from "./lib.mjs";
import { actorFrom, clearStaffCookie, hashPassword, jsonCookies, verifyPassword } from "./access.mjs";
import { APPROVER_FACTS, PREPARER_CLASSES } from "./pos-approval.mjs";
import { actorFromSession, readSession, rotateSession, sessionCookie } from "./entra.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function cookieBase(req) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* local http */ }
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function sessionSecret() {
  return env("IDENTITY_SESSION_SECRET");
}

function sign(id, exp) {
  return crypto.createHmac("sha256", sessionSecret()).update(`${id}.${exp}`).digest("hex");
}

export function sessionConfigured() {
  return sessionSecret().length >= 16;
}

export function bindConfigured() {
  return env("IDENTITY_BIND_TOKEN").length >= 16;
}

function tokenMatches(supplied) {
  const expected = env("IDENTITY_BIND_TOKEN");
  if (expected.length < 16) return false;
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function makeIdentityCookie(req, id) {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const sig = sign(id, exp);
  return `qr_ident=${id}.${exp}.${sig}; ${cookieBase(req)}; Max-Age=43200`;
}

export function clearIdentityCookie(req) {
  return `qr_ident=; ${cookieBase(req)}; Max-Age=0`;
}

export function publicIdentity(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.kind,
    kind: "verified-identity",
    name: row.displayName || APPROVER_FACTS[row.approverKey]?.name || "Verified identity",
    approverKey: row.approverKey || "",
    preparerClass: row.preparerClass || "",
    emailFact: row.emailFact || "",
    siteIds: Array.isArray(row.siteIds) ? row.siteIds : [],
    unassigned: row.unassigned === true,
  };
}

export async function identityFromCookie(req) {
  if (!sessionConfigured()) return null;
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_ident=(i[a-f0-9]{16})\.(\d+)\.([a-f0-9]+)/);
  if (!match || +match[2] < Date.now()) return null;
  const sig = sign(match[1], match[2]);
  try {
    if (sig.length !== match[3].length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(match[3]))) return null;
  } catch { return null; }
  const row = await identities().get(match[1], { type: "json" }).catch(() => null);
  if (!row || row.disabled || row.id !== match[1]) return null;
  return publicIdentity(row);
}

/** A current Entra sign-in wins, then a verified fixture identity, then the shared password. */
export async function actorFromRequest(req) {
  const entra = await entraActor(req);
  if (entra.actor) return entra.actor;
  const ident = await identityFromCookie(req);
  if (ident) return ident;
  return actorFrom(req);
}

export async function entraActor(req) {
  const row = await readSession(req);
  if (!row) return { actor: null, cookie: "" };
  const rotated = await rotateSession(row);
  const current = rotated || row;
  return { actor: actorFromSession(current), cookie: rotated ? sessionCookie(req, rotated.id, rotated.exp) : "" };
}

async function allIdentities() {
  const { blobs } = await identities().list();
  return (await Promise.all(blobs.map((blob) => identities().get(blob.key, { type: "json" })))).filter((row) => row && row.id);
}

async function knownSites(ids) {
  const wanted = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (wanted.length > 50) return { error: "Too many sites" };
  for (const id of wanted) {
    if (!/^s[a-f0-9]{8}$/.test(id)) return { error: "Unknown site" };
    const site = await sitesStore().get(id, { type: "json" });
    if (!site) return { error: "Unknown site" };
  }
  return { siteIds: wanted };
}

export async function identityStatus() {
  const rows = await allIdentities();
  return {
    bindConfigured: bindConfigured(),
    sessionConfigured: sessionConfigured(),
    approvers: Object.values(APPROVER_FACTS).map((fact) => ({
      key: fact.key,
      name: fact.name,
      email: fact.email,
      bound: rows.some((row) => row.kind === "approver" && row.approverKey === fact.key && !row.disabled),
    })),
    preparerClasses: PREPARER_CLASSES,
    note: "Emails are configuration facts. They do not authenticate anyone. The shared head-office password cannot approve.",
  };
}

export function approverBindAllowed() {
  return env("ALLOW_FIXTURE_IDENTITY_BIND") === "1";
}

export async function bindIdentity(body, suppliedToken, { privilegedSession = false } = {}) {
  if (!tokenMatches(suppliedToken)) {
    return { status: 403, error: "Verified identity binding is not configured. Set IDENTITY_BIND_TOKEN. No account was created." };
  }
  if (privilegedSession) {
    return { status: 403, error: "The shared head-office password or a staff session cannot bind an identity. No account was created." };
  }
  const password = String(body?.password || "");
  if (password.length < 10) return { status: 400, error: "Password must be at least 10 characters" };
  const sites = await knownSites(body?.siteIds || []);
  if (sites.error) return { status: 400, error: sites.error };
  const kind = body?.kind === "approver" || body?.kind === "preparer" ? body.kind : "";
  if (!kind) return { status: 400, error: "Kind must be approver or preparer" };
  const rows = await allIdentities();
  const record = {
    id: "i" + crypto.randomBytes(8).toString("hex"),
    kind,
    approverKey: "",
    preparerClass: "",
    emailFact: "",
    displayName: "",
    contactEmail: "",
    passwordHash: hashPassword(password),
    siteIds: sites.siteIds,
    unassigned: false,
    disabled: false,
    created: new Date().toISOString(),
  };
  if (kind === "approver") {
    if (!approverBindAllowed()) {
      return { status: 403, error: "No identity provider is configured. IDENTITY_BIND_TOKEN cannot assign Neil or Joshua. Approver binding stays closed until an external provider asserts the fixed email." };
    }
    const key = String(body?.approverKey || "");
    const fact = APPROVER_FACTS[key];
    if (!fact) return { status: 400, error: "Approver must be neil or joshua" };
    if (body?.email != null && String(body.email).trim().toLowerCase() !== fact.email) {
      return { status: 400, error: "Approver email is fixed configuration and cannot be typed" };
    }
    if (rows.some((row) => row.kind === "approver" && row.approverKey === key && !row.disabled)) {
      return { status: 409, error: "That approver is already bound" };
    }
    record.approverKey = key;
    record.emailFact = fact.email;
    record.displayName = fact.name;
  } else {
    const preparerClass = String(body?.preparerClass || "");
    if (!PREPARER_CLASSES.includes(preparerClass)) return { status: 400, error: "Unknown preparer class" };
    const displayName = String(body?.displayName || "").trim().slice(0, 80);
    if (!displayName) return { status: 400, error: "Display name is required" };
    const contact = String(body?.contactEmail || "").trim().toLowerCase();
    if (contact && !EMAIL.test(contact)) return { status: 400, error: "Requester contact email is not valid" };
    record.preparerClass = preparerClass;
    record.displayName = displayName;
    record.contactEmail = contact;
  }
  await identities().setJSON(record.id, record);
  return { status: 201, identity: publicIdentity(record) };
}

export async function loginIdentity(req, body) {
  if (!sessionConfigured()) {
    return { status: 403, error: "Verified identity sessions are not configured. Set IDENTITY_SESSION_SECRET. The shared password was not accepted." };
  }
  const login = String(body?.login || body?.email || body?.id || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const rows = await allIdentities();
  const row = rows.find((item) => !item.disabled && (item.id === login || (item.kind === "approver" && item.emailFact === login)));
  const match = verifyPassword(password, row?.passwordHash || "scrypt$00$00");
  if (!row || !match) return { status: 401, error: "Invalid identity" };
  return {
    status: 200,
    response: jsonCookies(200, { ok: true, role: row.kind, identity: publicIdentity(row) }, [makeIdentityCookie(req, row.id), clearCookie(req), clearStaffCookie(req)]),
  };
}

export function statusResponse(actor) {
  return identityStatus().then((status) => json(200, { ...status, actor: actor ? { role: actor.role, kind: actor.kind || "", id: actor.role === "head" ? "" : actor.id } : null }));
}
