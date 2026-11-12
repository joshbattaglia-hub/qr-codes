import crypto from "node:crypto";
import { otpStore, sitesStore, usersStore } from "./lib.mjs";
import { APPROVER_FACTS, PREPARER_CLASSES } from "./pos-approval.mjs";
import { BUILDING_MAINTENANCE_ROLE, readBuildingMaintenance } from "./building-maintenance.mjs";
import { allowlist, normalizeEmail, OTP_EXPLICIT_SITE_CAP } from "./otp.mjs";
import { QUEUES, readSettings as readTicketSettings, setTicketStaffQueues, TICKET_ADMIN_EMAIL } from "./tickets.mjs";

/**
 * Users: the one list of email-code logins and what each can do. Joshua (the owner) manages it in
 * Admin > Users. Until the first save it is derived from the previous sources (OTP_ALLOWLIST and the
 * building maintenance list), so effective access is identical before and after migration. Ticket queue
 * membership stays in the Support Tickets staff lists (the Users tab edits those lists).
 * The head-office password and site-manager password logins are separate and unchanged.
 */
export const OWNER_EMAIL = APPROVER_FACTS.joshua.email;
export const USERS_DOMAIN = "libertyretail.com.au";
export const USERS_MAX = 100;
export const VISITOR_LEVELS = ["none", "view", "photos", "settings"];
export const LIMITED_ROLE = BUILDING_MAINTENANCE_ROLE;
const REGISTRY_KEY = "registry";
const MIGRATION_KEY = "migration/v1";

let clock = () => Date.now();
export function setUsersTestHooks({ now = null } = {}) { clock = typeof now === "function" ? now : () => Date.now(); }
function nowIso() { return new Date(clock()).toISOString(); }

/** One exact @libertyretail.com.au address for new users. */
export function userEmailOk(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 254) return "";
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at || email.slice(at + 1) !== USERS_DOMAIN) return "";
  const local = email.slice(0, at);
  if (!/^[a-z0-9._%+-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "";
  return email;
}

/** The same POS role rules as the old OTP allowlist (approver keys are fixed to their own address). */
export function posRoleError(email, approverKey, preparerClass) {
  if (approverKey) {
    const fact = APPROVER_FACTS[approverKey];
    if (!fact || fact.email !== email) return "That approver role belongs to another address.";
  }
  if (preparerClass) {
    if (!PREPARER_CLASSES.includes(preparerClass)) return "Unknown preparer class.";
    if (email === APPROVER_FACTS.neil.email) return "Neil cannot be a preparer.";
    if (preparerClass === "joshua" && email !== APPROVER_FACTS.joshua.email) return "The Joshua preparer class is Joshua's only.";
    if ((preparerClass === "jeremy" || preparerClass === "regional-business-manager") && email === APPROVER_FACTS.joshua.email) return "Joshua uses the Joshua preparer class.";
  }
  return "";
}

function cleanUser(row) {
  const email = normalizeEmail(row?.email);
  if (!email) return null;
  const approverKey = typeof row.approverKey === "string" ? row.approverKey : "";
  const preparerClass = typeof row.preparerClass === "string" ? row.preparerClass : "";
  if (posRoleError(email, approverKey, preparerClass)) return null;
  const siteIds = [...new Set((Array.isArray(row.siteIds) ? row.siteIds : []).filter((id) => typeof id === "string" && /^s[a-f0-9]{8}$/.test(id)))].slice(0, OTP_EXPLICIT_SITE_CAP);
  const visitor = VISITOR_LEVELS.includes(row.visitor) ? row.visitor : "none";
  return {
    email,
    owner: email === OWNER_EMAIL,
    approverKey,
    preparerClass,
    siteIds: approverKey || preparerClass ? siteIds : [],
    visitor: email === OWNER_EMAIL ? "none" : visitor,
    // Users without a POS role reach Support Tickets only when this is set (the old rules never let them in).
    ticketsEnabled: row.ticketsEnabled === true,
    addedAt: typeof row.addedAt === "string" ? row.addedAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
}

/** The previous sources, as user records: OTP_ALLOWLIST entries keep their POS role and sites; the building maintenance list grants Visitor Log view with ID photos. */
export async function legacyUsers() {
  const users = new Map();
  for (const entry of allowlist().values()) {
    users.set(entry.email, cleanUser({ email: entry.email, approverKey: entry.approverKey, preparerClass: entry.preparerClass, siteIds: entry.siteIds, visitor: "none" }));
  }
  for (const email of (await readBuildingMaintenance()).emails) {
    const existing = users.get(email);
    if (existing) existing.visitor = existing.owner ? "none" : "photos";
    else users.set(email, cleanUser({ email, visitor: "photos" }));
  }
  return [...users.values()].filter(Boolean).sort((a, b) => a.email.localeCompare(b.email));
}

/** Stored list, or the derived one before migration. */
export async function readUsers() {
  const meta = await usersStore().getWithMetadata(REGISTRY_KEY, { type: "json", consistency: "strong" });
  if (meta?.etag && Array.isArray(meta.data?.users)) {
    return { users: meta.data.users.map(cleanUser).filter(Boolean), etag: meta.etag, stored: true };
  }
  return { users: await legacyUsers(), etag: "", stored: false };
}

export async function userFor(email) {
  const address = normalizeEmail(email);
  if (!address) return null;
  return (await readUsers()).users.find((row) => row.email === address) || null;
}

/** Actor fields for a signed-in email-code user. Users without a POS role get the limited role (no POS, sites or identity admin). */
export function userActorFields(user) {
  return {
    role: user.approverKey ? "approver" : user.preparerClass ? "preparer" : LIMITED_ROLE,
    approverKey: user.approverKey,
    preparerClass: user.preparerClass,
    siteIds: [...user.siteIds],
    visitor: user.visitor,
    ticketsEnabled: user.ticketsEnabled === true,
    owner: user.owner === true,
  };
}

export function isOwner(actor) {
  return !!actor && actor.kind === "verified-identity" && actor.provider === "otp" && String(actor.email || "").toLowerCase() === OWNER_EMAIL && actor.owner === true;
}

/* ---------- effective access (used for the migration proof) ---------- */

function ticketView(access) {
  return access.role === "none" ? "none" : access.role + ":" + [...access.queues].sort().join(",");
}
function ticketFor(email, role, settings) {
  if (!email) return { role: "none", queues: [] };
  if (email === TICKET_ADMIN_EMAIL) return { role: "admin", queues: [...QUEUES] };
  const queues = QUEUES.filter((queue) => settings.staff[queue].includes(email));
  return queues.length ? { role: "staff", queues } : { role: "none", queues: [] };
}

/**
 * Effective permissions for one address. legacy=true evaluates the previous rules (env allowlist first,
 * then the building maintenance list; limited users never had tickets); otherwise the Users list.
 */
export async function effectiveAccess(email, { legacy = false, users = null, settings = null, bm = null, visitorOwnerOk = false } = {}) {
  const address = normalizeEmail(email);
  const ticketSettings = settings || await readTicketSettings();
  let user = null;
  if (legacy) {
    const env = allowlist().get(address);
    const bmList = bm || (await readBuildingMaintenance()).emails;
    if (env) user = cleanUser({ email: address, approverKey: env.approverKey, preparerClass: env.preparerClass, siteIds: env.siteIds });
    if (user && bmList.includes(address) && !user.owner) user.visitor = "photos";
    if (!user && bmList.includes(address)) user = cleanUser({ email: address, visitor: "photos" });
  } else {
    user = (users || (await readUsers()).users).find((row) => row.email === address) || null;
  }
  if (!user) return { email: address, login: false, role: "", approverKey: "", preparerClass: "", siteIds: "", visitor: "none", tickets: "none", users: false };
  const fields = userActorFields(user);
  const limited = fields.role === LIMITED_ROLE;
  const tickets = limited && (legacy || !fields.ticketsEnabled) ? { role: "none", queues: [] } : ticketFor(address, fields.role, ticketSettings);
  return {
    email: address,
    login: true,
    role: fields.role,
    approverKey: fields.approverKey,
    preparerClass: fields.preparerClass,
    siteIds: [...fields.siteIds].sort().join(","),
    visitor: user.owner ? (visitorOwnerOk ? "owner" : "none") : fields.visitor,
    tickets: ticketView(tickets),
    users: user.owner === true,
  };
}

async function candidateEmails(extra = []) {
  const settings = await readTicketSettings();
  const set = new Set([OWNER_EMAIL, ...allowlist().keys(), ...(await readBuildingMaintenance()).emails, ...QUEUES.flatMap((q) => settings.staff[q]), ...extra]);
  return [...set].map(normalizeEmail).filter(Boolean).sort();
}

/** Before/after comparison over every address any source knows about. */
export async function compareAccess(users, { visitorOwnerOk = false } = {}) {
  const settings = await readTicketSettings();
  const bm = (await readBuildingMaintenance()).emails;
  const emails = await candidateEmails(users.map((row) => row.email));
  const rows = [];
  for (const email of emails) {
    const before = await effectiveAccess(email, { legacy: true, settings, bm, visitorOwnerOk });
    const after = await effectiveAccess(email, { users, settings, visitorOwnerOk });
    rows.push({ email, before, after, same: JSON.stringify(before) === JSON.stringify(after) });
  }
  const count = (side, fn) => rows.filter((row) => fn(row[side])).length;
  const summary = (side) => ({
    logins: count(side, (a) => a.login),
    approvers: count(side, (a) => a.role === "approver"),
    preparers: count(side, (a) => a.preparerClass !== ""),
    limited: count(side, (a) => a.login && a.role === LIMITED_ROLE),
    visitorPhotos: count(side, (a) => a.visitor === "photos"),
    visitorOwner: count(side, (a) => a.visitor === "owner"),
    ticketStaff: count(side, (a) => a.tickets !== "none"),
    owners: count(side, (a) => a.users),
  });
  return { checked: rows.length, same: rows.every((row) => row.same), diffs: rows.filter((row) => !row.same).map((row) => row.email), before: summary("before"), after: summary("after"), logins: rows.filter((row) => row.after.login).map((row) => row.email) };
}

/** Write the derived list once (no-op when already stored), with the before/after proof. */
export async function migrateUsers({ trigger = "lazy", visitorOwnerOk = false } = {}) {
  const current = await readUsers();
  if (current.stored) return { status: "already", report: await usersStore().get(MIGRATION_KEY, { type: "json" }) };
  const at = nowIso();
  const users = current.users.map((row) => ({ ...row, addedAt: row.addedAt || at, updatedAt: row.updatedAt || at }));
  const proof = await compareAccess(users, { visitorOwnerOk });
  if (!proof.same) {
    await usersStore().setJSON(MIGRATION_KEY + "-blocked", { at, trigger, ...proof });
    return { status: "blocked", report: proof };
  }
  const write = await usersStore().setJSON(REGISTRY_KEY, { version: 1, users, migratedAt: at, updatedAt: at }, { onlyIfNew: true });
  if (write?.modified !== true) return { status: "already", report: await usersStore().get(MIGRATION_KEY, { type: "json" }) };
  const report = { at, trigger, users: users.length, ...proof };
  await usersStore().setJSON(MIGRATION_KEY, report);
  await audit({ id: "migration", email: "" }, "migrate", "", "users " + users.length + ", same " + proof.same);
  return { status: "migrated", report };
}

/* ---------- owner actions ---------- */

async function audit(actor, action, target, detail) {
  const row = { id: "u" + crypto.randomBytes(8).toString("hex"), at: nowIso(), actorId: String(actor?.id || "").slice(0, 80), actorEmail: String(actor?.email || "").slice(0, 254), action, target: String(target || ""), detail: String(detail || "").slice(0, 2000) };
  await usersStore().setJSON("audit/" + row.at + "-" + row.id, row);
  return row;
}

async function siteNames() {
  const { blobs } = await sitesStore().list();
  const rows = await Promise.all(blobs.map((blob) => sitesStore().get(blob.key, { type: "json" }).catch(() => null)));
  return rows.filter((row) => row && typeof row.id === "string" && typeof row.name === "string").map((row) => ({ id: row.id, name: row.name })).sort((a, b) => a.name.localeCompare(b.name));
}

function publicUser(user, settings) {
  const limited = !user.approverKey && !user.preparerClass && !user.owner;
  const queues = user.email === TICKET_ADMIN_EMAIL ? [...QUEUES] : limited && !user.ticketsEnabled ? [] : QUEUES.filter((q) => settings.staff[q].includes(user.email));
  return { ...user, tickets: queues, ticketAdmin: user.email === TICKET_ADMIN_EMAIL, posRole: user.approverKey ? "approver" : user.preparerClass ? "preparer" : "none" };
}

export async function listUsers(actor) {
  if (!isOwner(actor)) return { status: 403, error: "Only the owner can manage users." };
  await migrateUsers({ trigger: "owner-open", visitorOwnerOk: true });
  const { users } = await readUsers();
  const settings = await readTicketSettings();
  const { blobs } = await usersStore().list({ prefix: "audit/" });
  const keys = blobs.map((blob) => blob.key).sort().reverse().slice(0, 60);
  const history = (await Promise.all(keys.map((key) => usersStore().get(key, { type: "json" })))).filter(Boolean);
  return {
    status: 200,
    body: {
      users: users.map((row) => publicUser(row, settings)),
      sites: await siteNames(),
      options: { approvers: Object.values(APPROVER_FACTS).map((f) => ({ key: f.key, email: f.email, name: f.name })), preparerClasses: PREPARER_CLASSES, visitorLevels: VISITOR_LEVELS, queues: QUEUES, domain: USERS_DOMAIN, owner: OWNER_EMAIL },
      migration: await usersStore().get(MIGRATION_KEY, { type: "json" }),
      history,
    },
  };
}

function describe(user, queues) {
  const pos = [user.approverKey ? "approver:" + user.approverKey : "", user.preparerClass ? "preparer:" + user.preparerClass : ""].filter(Boolean).join("+");
  return [
    "pos=" + (pos || "none"),
    "sites=" + user.siteIds.length,
    "visitor=" + (user.owner ? "owner" : user.visitor),
    "tickets=" + (queues.length ? queues.join(",") : "none"),
  ].join(" ");
}

async function endSessions(email) {
  const { blobs } = await otpStore().list({ prefix: "sess/" });
  let ended = 0;
  for (const blob of blobs) {
    const row = await otpStore().get(blob.key, { type: "json" });
    if (row?.email === email) { await otpStore().delete(blob.key); ended += 1; }
  }
  return ended;
}

/** Add or edit one user. body: { email, mode: "add"|"edit", approverKey, preparerClass, siteIds, visitor, tickets } */
export async function saveUser(actor, body) {
  if (!isOwner(actor)) return { status: 403, error: "Only the owner can manage users." };
  await migrateUsers({ trigger: "owner-save", visitorOwnerOk: true });
  const mode = body?.mode === "add" ? "add" : body?.mode === "edit" ? "edit" : "";
  if (!mode) return { status: 400, error: "Choose add or edit." };
  const email = mode === "add" ? userEmailOk(body?.email) : normalizeEmail(body?.email);
  if (!email) return { status: 400, error: "Use one exact @" + USERS_DOMAIN + " email address." };
  const approverKey = typeof body?.approverKey === "string" ? body.approverKey : "";
  const preparerClass = typeof body?.preparerClass === "string" ? body.preparerClass : "";
  const roleError = posRoleError(email, approverKey, preparerClass);
  if (roleError) return { status: 400, error: roleError };
  if (body?.siteIds != null && !Array.isArray(body.siteIds)) return { status: 400, error: "Sites must be a list." };
  const siteIds = [...new Set((body?.siteIds || []).map(String))];
  if (siteIds.some((id) => !/^s[a-f0-9]{8}$/.test(id))) return { status: 400, error: "Unknown site." };
  if (siteIds.length > OTP_EXPLICIT_SITE_CAP) return { status: 400, error: "Too many sites." };
  const visitor = body?.visitor === undefined ? "none" : body.visitor;
  if (!VISITOR_LEVELS.includes(visitor)) return { status: 400, error: "Unknown Visitor Log level." };
  if (body?.tickets != null && !Array.isArray(body.tickets)) return { status: 400, error: "Ticket areas must be a list." };
  const tickets = [...new Set(body?.tickets || [])];
  if (tickets.some((q) => !QUEUES.includes(q))) return { status: 400, error: "Unknown ticket area." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await usersStore().getWithMetadata(REGISTRY_KEY, { type: "json", consistency: "strong" });
    if (!meta?.etag) return { status: 409, error: "Users list is not ready. Try again." };
    const users = (meta.data.users || []).map(cleanUser).filter(Boolean);
    const index = users.findIndex((row) => row.email === email);
    if (mode === "add" && index >= 0) return { status: 409, error: "That user already exists. Edit them instead." };
    if (mode === "edit" && index < 0) return { status: 404, error: "User not found." };
    if (mode === "add" && users.length >= USERS_MAX) return { status: 400, error: "Too many users." };
    const before = index >= 0 ? users[index] : null;
    // Newly added sites must exist; sites a user already had (e.g. from the old allowlist) are kept as they are.
    const added = siteIds.filter((id) => !(before?.siteIds || []).includes(id));
    if (added.length) {
      const known = new Set((await siteNames()).map((row) => row.id));
      if (added.some((id) => !known.has(id))) return { status: 400, error: "Unknown site." };
    }
    const isOwnerRow = email === OWNER_EMAIL;
    if (isOwnerRow && before && (approverKey !== before.approverKey || preparerClass !== before.preparerClass)) {
      return { status: 400, error: "The owner's own roles cannot be changed here." };
    }
    const next = cleanUser({ email, approverKey, preparerClass, siteIds, visitor: isOwnerRow ? "none" : visitor, ticketsEnabled: tickets.length > 0, addedAt: before?.addedAt || nowIso(), updatedAt: nowIso() });
    if (!next) return { status: 400, error: "That combination is not allowed." };
    if (!isOwnerRow && !next.approverKey && !next.preparerClass && next.visitor === "none" && !tickets.length) {
      return { status: 400, error: "Give at least one permission, or remove the user." };
    }
    const settings = await readTicketSettings();
    const oldQueues = before ? publicUser(before, settings).tickets : [];
    const list = [...users];
    if (index >= 0) list[index] = next; else list.push(next);
    list.sort((a, b) => a.email.localeCompare(b.email));
    const write = await usersStore().setJSON(REGISTRY_KEY, { ...meta.data, version: 1, users: list, updatedAt: nowIso() }, { onlyIfMatch: meta.etag });
    if (write?.modified !== true) continue;
    const newQueues = isOwnerRow ? oldQueues : QUEUES.filter((q) => tickets.includes(q));
    if (!isOwnerRow && newQueues.join(",") !== [...oldQueues].sort().join(",")) await setTicketStaffQueues(email, newQueues);
    await audit(actor, mode === "add" ? "user-add" : "user-edit", email, (before ? describe(before, oldQueues) : "none") + " > " + describe(next, newQueues));
    return { status: 200, body: { user: publicUser(next, await readTicketSettings()) } };
  }
  return { status: 409, error: "The list changed. Try again." };
}

/** Remove one user: access ends on their next request and their email-code sessions are deleted now. */
export async function removeUser(actor, body) {
  if (!isOwner(actor)) return { status: 403, error: "Only the owner can manage users." };
  await migrateUsers({ trigger: "owner-remove", visitorOwnerOk: true });
  const email = normalizeEmail(body?.email);
  if (!email) return { status: 400, error: "Choose a user." };
  if (email === OWNER_EMAIL) return { status: 400, error: "The owner cannot be removed." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await usersStore().getWithMetadata(REGISTRY_KEY, { type: "json", consistency: "strong" });
    if (!meta?.etag) return { status: 409, error: "Users list is not ready. Try again." };
    const users = (meta.data.users || []).map(cleanUser).filter(Boolean);
    const before = users.find((row) => row.email === email);
    if (!before) return { status: 404, error: "User not found." };
    const write = await usersStore().setJSON(REGISTRY_KEY, { ...meta.data, users: users.filter((row) => row.email !== email), updatedAt: nowIso() }, { onlyIfMatch: meta.etag });
    if (write?.modified !== true) continue;
    const settings = await readTicketSettings();
    const oldQueues = publicUser(before, settings).tickets;
    await setTicketStaffQueues(email, []);
    const ended = await endSessions(email);
    await audit(actor, "user-remove", email, describe(before, oldQueues) + " > removed; sessions ended " + ended);
    return { status: 200, body: { removed: email, sessionsEnded: ended } };
  }
  return { status: 409, error: "The list changed. Try again." };
}

/** Visitor Log "Building maintenance access" compatibility: grant or clear view-with-photos for one address. */
export async function setVisitorLevel(actor, email, level) {
  const user = await userFor(email);
  if (!user) {
    if (level === "none") return { status: 200, body: { changed: false } };
    return saveUser(actor, { mode: "add", email, visitor: level });
  }
  if (user.owner) return { status: 400, error: "Joshua already has full visitor log access." };
  const settings = await readTicketSettings();
  const queues = publicUser(user, settings).tickets;
  if (level === "none" && !user.approverKey && !user.preparerClass && !queues.length) return removeUser(actor, { email });
  return saveUser(actor, { mode: "edit", email, approverKey: user.approverKey, preparerClass: user.preparerClass, siteIds: user.siteIds, visitor: level, tickets: queues });
}
