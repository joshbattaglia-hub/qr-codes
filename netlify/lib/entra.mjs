import crypto from "node:crypto";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { env, entraStore, publicBase } from "./lib.mjs";
import { PREPARER_CLASSES } from "./pos-approval.mjs";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
export const ENTRA_SCOPES = "openid profile";
export const REDIRECT_PATH = "/api/identity/entra/callback";
export const LOGOUT_RETURN_PATH = "/admin";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ROTATE_AFTER_MS = 15 * 60 * 1000;

let testJwks = null;
let testFetch = null;

export function setEntraTestHooks({ jwks = null, fetchImpl = null } = {}) {
  testJwks = jwks;
  testFetch = fetchImpl;
}

export function tenantId() {
  const value = env("ENTRA_TENANT_ID").trim().toLowerCase();
  if (!GUID.test(value) || value === CONSUMER_TENANT) return "";
  if (value === "common" || value === "organizations" || value === "consumers") return "";
  return value;
}

export function clientId() {
  const value = env("ENTRA_CLIENT_ID").trim().toLowerCase();
  return GUID.test(value) ? value : "";
}

export function clientSecret() {
  return env("ENTRA_CLIENT_SECRET");
}

export function sessionSecret() {
  return env("IDENTITY_SESSION_SECRET");
}

export function testIssuerAllowed() {
  const value = env("ENTRA_TEST_ISSUER");
  return env("ENTRA_ALLOW_TEST_ISSUER") === "1" && (value.startsWith("https://") || value.startsWith("http://127.0.0.1"));
}

export function issuer() {
  const tenant = tenantId();
  if (!tenant) return "";
  if (testIssuerAllowed()) return env("ENTRA_TEST_ISSUER").replace(/\/$/, "");
  return `https://login.microsoftonline.com/${tenant}/v2.0`;
}

export function authorizeEndpoint() {
  const tenant = tenantId();
  if (!tenant) return "";
  if (testIssuerAllowed()) return env("ENTRA_TEST_ISSUER").replace(/\/$/, "") + "/authorize";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint() {
  const tenant = tenantId();
  if (!tenant) return "";
  if (testIssuerAllowed()) return env("ENTRA_TEST_ISSUER").replace(/\/$/, "") + "/token";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function jwksUrl() {
  const tenant = tenantId();
  if (!tenant) return "";
  if (testIssuerAllowed()) return env("ENTRA_TEST_ISSUER").replace(/\/$/, "") + "/keys";
  return `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;
}

export function logoutEndpoint() {
  const tenant = tenantId();
  if (!tenant || testIssuerAllowed()) return "";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`;
}

export function redirectUri() {
  return publicBase().replace(/\/$/, "") + REDIRECT_PATH;
}

export function logoutReturnUri() {
  return publicBase().replace(/\/$/, "") + LOGOUT_RETURN_PATH;
}

export function entraConfigured() {
  return !!(tenantId() && clientId() && clientSecret() && sessionSecret().length >= 16 && roleMap().oids.length);
}

export function entraStatus() {
  const map = roleMap();
  return {
    configured: entraConfigured(),
    operational: false,
    tenantConfigured: !!tenantId(),
    clientConfigured: !!clientId(),
    secretConfigured: !!clientSecret(),
    sessionSecretConfigured: sessionSecret().length >= 16,
    roleMapConfigured: map.oids.length > 0,
    testIssuer: testIssuerAllowed(),
    redirectUri: redirectUri(),
    logoutReturnUri: logoutReturnUri(),
    scopes: ENTRA_SCOPES,
  };
}

export function roleMap() {
  const raw = env("ENTRA_ROLE_MAP");
  if (!raw) return { oids: [], byOid: new Map(), error: "" };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { oids: [], byOid: new Map(), error: "ENTRA_ROLE_MAP is not valid JSON" }; }
  const byOid = new Map();
  const add = (oid, patch) => {
    const key = String(oid || "").trim().toLowerCase();
    if (!GUID.test(key)) return;
    const current = byOid.get(key) || { oid: key, approverKey: "", preparerClass: "", siteIds: [], allSites: false };
    if (patch.approverKey) current.approverKey = patch.approverKey;
    if (patch.preparerClass) current.preparerClass = patch.preparerClass;
    if (patch.allSites === true) current.allSites = true;
    if (Array.isArray(patch.siteIds)) current.siteIds = [...new Set([...current.siteIds, ...patch.siteIds.filter((id) => /^s[a-f0-9]{8}$/.test(id))])];
    byOid.set(key, current);
  };
  const neil = parsed.approverNeil?.oid || parsed.approverNeil;
  const joshua = parsed.approverJoshua?.oid || parsed.approverJoshua;
  add(neil, { approverKey: "neil", allSites: parsed.approverNeil?.allSites === true, siteIds: parsed.approverNeil?.siteIds || [] });
  add(joshua, { approverKey: "joshua", allSites: parsed.approverJoshua?.allSites === true, siteIds: parsed.approverJoshua?.siteIds || [] });
  for (const row of parsed.preparers || []) {
    if (!PREPARER_CLASSES.includes(row?.class)) continue;
    add(row.oid, { preparerClass: row.class, siteIds: row.siteIds || [] });
  }
  return { oids: [...byOid.keys()], byOid, error: "" };
}

export function rightsFor(oid) {
  const found = roleMap().byOid.get(String(oid || "").toLowerCase());
  if (!found) return null;
  return found;
}

export function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function validateReturnTo(value) {
  const text = String(value || "");
  if (text === "/admin") return "/admin";
  if (/^\/admin#\/pos\/p[a-f0-9]{8}$/.test(text)) return text;
  return "/admin";
}

export function authorizeUrl({ state, nonce, challenge }) {
  const url = new URL(authorizeEndpoint());
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", ENTRA_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function stateKey(state) {
  return "state/" + crypto.createHash("sha256").update(String(state)).digest("hex");
}

export async function saveLoginState({ state, nonce, verifier, returnTo }) {
  const record = { nonce, verifier, returnTo: validateReturnTo(returnTo), exp: Date.now() + STATE_TTL_MS };
  await entraStore().setJSON(stateKey(state), record, { onlyIfNew: true });
  return record;
}

export async function takeLoginState(state) {
  const key = stateKey(state);
  const row = await entraStore().get(key, { type: "json" });
  if (!row) return null;
  await entraStore().delete(key);
  if (!row.exp || row.exp < Date.now()) return null;
  return row;
}

export async function exchangeCode({ code, verifier }) {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    scope: ENTRA_SCOPES,
  });
  const fetchImpl = testFetch || fetch;
  const response = await fetchImpl(tokenEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return { error: "Token exchange failed" };
  const json = await response.json();
  if (!json.id_token || typeof json.id_token !== "string") return { error: "No identity token" };
  return { idToken: json.id_token };
}

export async function verifyIdToken(idToken, { nonce }) {
  const keyset = testJwks || createRemoteJWKSet(new URL(jwksUrl()));
  let payload;
  try {
    const verified = await jwtVerify(idToken, keyset, {
      issuer: issuer(),
      audience: clientId(),
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch {
    return { error: "Identity token was rejected" };
  }
  if (payload.nonce !== nonce) return { error: "Identity token was rejected" };
  const tid = String(payload.tid || "").toLowerCase();
  const oid = String(payload.oid || "").toLowerCase();
  if (tid !== tenantId() || !GUID.test(oid)) return { error: "Identity token was rejected" };
  if (payload.idp && String(payload.idp).includes(CONSUMER_TENANT)) return { error: "Identity token was rejected" };
  return {
    claims: {
      tid,
      oid,
      name: typeof payload.name === "string" ? payload.name.slice(0, 80) : "",
    },
  };
}

function cookieBase(req, sameSite) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* local http */ }
  return `Path=/; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
}

function sign(id, exp) {
  return crypto.createHmac("sha256", sessionSecret()).update(`entra:${id}.${exp}`).digest("hex");
}

export function stateCookie(req, state) {
  return `qr_entra_state=${state}; ${cookieBase(req, "Lax")}; Max-Age=600`;
}

export function clearStateCookie(req) {
  return `qr_entra_state=; ${cookieBase(req, "Lax")}; Max-Age=0`;
}

export function sessionCookie(req, id, exp) {
  const sig = sign(id, exp);
  const maxAge = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  return `qr_entra=${id}.${exp}.${sig}; ${cookieBase(req, "Strict")}; Max-Age=${maxAge}`;
}

export function clearSessionCookie(req) {
  return `qr_entra=; ${cookieBase(req, "Strict")}; Max-Age=0`;
}

export async function createSession(claims) {
  const id = "e" + crypto.randomBytes(16).toString("hex");
  const exp = Date.now() + SESSION_TTL_MS;
  const record = { id, tid: claims.tid, oid: claims.oid, name: claims.name || "", iat: Date.now(), exp };
  await entraStore().setJSON("sess/" + id, record);
  return record;
}

export async function readSession(req) {
  if (sessionSecret().length < 16) return null;
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_entra=(e[a-f0-9]{32})\.(\d+)\.([a-f0-9]+)/);
  if (!match || +match[2] < Date.now()) return null;
  const sig = sign(match[1], match[2]);
  try {
    if (sig.length !== match[3].length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(match[3]))) return null;
  } catch { return null; }
  const row = await entraStore().get("sess/" + match[1], { type: "json" });
  if (!row || row.exp < Date.now() || row.id !== match[1]) return null;
  return row;
}

export async function rotateSession(row) {
  if (!row || Date.now() - row.iat < ROTATE_AFTER_MS) return null;
  await entraStore().delete("sess/" + row.id);
  return createSession(row);
}

export async function deleteSession(req) {
  const row = await readSession(req);
  if (row) await entraStore().delete("sess/" + row.id);
}

export function actorFromSession(row) {
  if (!row) return null;
  const rights = rightsFor(row.oid);
  return {
    id: "entra:" + row.oid,
    sessionId: row.id,
    kind: "verified-identity",
    provider: "entra",
    tid: row.tid,
    oid: row.oid,
    name: row.name || "Work account",
    role: rights?.approverKey ? "approver" : rights?.preparerClass ? "preparer" : "",
    approverKey: rights?.approverKey || "",
    preparerClass: rights?.preparerClass || "",
    siteIds: rights?.siteIds || [],
    allSites: rights?.allSites === true,
  };
}

export { createLocalJWKSet };
