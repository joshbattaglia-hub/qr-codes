import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, decodeProtectedHeader } from "jose";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.IDENTITY_SESSION_SECRET = "fixture-session-secret-value";
process.env.ENTRA_TENANT_ID = "11111111-1111-4111-8111-111111111111";
process.env.ENTRA_CLIENT_ID = "22222222-2222-4222-8222-222222222222";
process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
process.env.ENTRA_ALLOW_TEST_ISSUER = "1";
process.env.ENTRA_TEST_ISSUER = "https://login.microsoftonline.com/" + process.env.ENTRA_TENANT_ID + "/v2.0";
delete process.env.ALLOW_FIXTURE_IDENTITY_BIND;

const TENANT = process.env.ENTRA_TENANT_ID;
const CLIENT = process.env.ENTRA_CLIENT_ID;
const NEIL = "33333333-3333-4333-8333-333333333333";
const JOSH = "44444444-4444-4444-8444-444444444444";
const PREP = "55555555-5555-4555-8555-555555555555";
const SITE = "s1234abcd";
process.env.ENTRA_ROLE_MAP = JSON.stringify({
  approverNeil: { oid: NEIL, siteIds: [SITE] },
  approverJoshua: { oid: JOSH, allSites: true },
  preparers: [
    { oid: PREP, class: "regional-business-manager", siteIds: [SITE] },
    { oid: JOSH, class: "joshua", siteIds: [SITE] },
  ],
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const entraLib = await import("../netlify/lib/entra.mjs");
const entraFn = (await import("../netlify/functions/entra.mjs")).default;
const identityFn = (await import("../netlify/functions/identity.mjs")).default;
const { isVerifiedApprover, isVerifiedPreparer, canSeeDraft } = await import("../netlify/lib/pos-workflow.mjs");
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = "test-key";
jwk.alg = "RS256";
jwk.use = "sig";
const jwks = createLocalJWKSet({ keys: [jwk] });
entraLib.setEntraTestHooks({ jwks, fetchImpl: async (url, init) => tokenFetch(url, init) });

const usedCodes = new Set();
async function tokenFetch(url, init) {
  const params = new URLSearchParams(init.body);
  const code = params.get("code");
  if (usedCodes.has(code)) return new Response("{}", { status: 400 });
  usedCodes.add(code);
  const expected = entraLib.pkceChallenge(params.get("code_verifier"));
  if (expected !== challenges.get(code)) return new Response("{}", { status: 400 });
  if (params.get("redirect_uri") !== "https://expresshelp.site/api/identity/entra/callback") return new Response("{}", { status: 400 });
  return Response.json({ id_token: tokens.get(code), access_token: "do-not-store", refresh_token: "do-not-store" });
}
const challenges = new Map();
const tokens = new Map();

async function sign(claims, { header = { alg: "RS256", kid: "test-key" }, issuer = entraLib.issuer() } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader(header)
    .setIssuer(issuer)
    .setAudience(claims.aud || CLIENT)
    .setSubject(claims.sub || claims.oid)
    .setIssuedAt(now)
    .setNotBefore(claims.nbf || "-5s")
    .setExpirationTime(claims.exp || "5m")
    .sign(privateKey);
}

function req(method, url, { cookie, origin } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  return new Request(url, { method, headers });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const hit = rows.find((row) => row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}

test("sign-in stays closed until the tenant, client, and role map exist", async () => {
  const saved = process.env.ENTRA_ROLE_MAP;
  delete process.env.ENTRA_ROLE_MAP;
  const res = await entraFn(req("GET", "https://expresshelp.site/api/identity/entra/start?returnTo=/admin"));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("location"), null);
  process.env.ENTRA_ROLE_MAP = saved;
  const common = process.env.ENTRA_TENANT_ID;
  process.env.ENTRA_TENANT_ID = "common";
  assert.equal((await entraFn(req("GET", "https://expresshelp.site/api/identity/entra/start"))).status, 403);
  process.env.ENTRA_TENANT_ID = common;
});

test("authorization code, PKCE, and a signed token create a revocable session", async () => {
  const start = await entraFn(req("GET", "https://expresshelp.site/api/identity/entra/start?returnTo=https://evil.example/phish"));
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("location"));
  assert.equal(location.origin, "https://login.microsoftonline.com");
  assert.equal(location.searchParams.get("redirect_uri"), "https://expresshelp.site/api/identity/entra/callback");
  assert.equal(location.searchParams.get("scope"), "openid profile");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("client_id"), CLIENT);
  const state = location.searchParams.get("state");
  const nonce = location.searchParams.get("nonce");
  const stateCookie = cookieNamed(start, "qr_entra_state");
  const code = "code-" + state.slice(0, 8);
  challenges.set(code, location.searchParams.get("code_challenge"));
  tokens.set(code, await sign({ oid: JOSH, tid: TENANT, nonce, name: "Fixture Josh", email: "someone@example.com", preferred_username: "nanderson@libertyretail.com.au" }));
  const back = await entraFn(req("GET", "https://expresshelp.site/api/identity/entra/callback?code=" + code + "&state=" + state, { cookie: stateCookie }));
  assert.equal(back.status, 302);
  assert.equal(back.headers.get("location"), "https://expresshelp.site/admin");
  const session = cookieNamed(back, "qr_entra");
  const me = await identityFn(req("GET", "https://expresshelp.site/api/identity/session", { cookie: session }));
  const body = await me.json();
  assert.equal(body.identity.approverKey, "joshua");
  assert.equal(body.identity.preparerClass, "joshua");
  assert.equal(body.identity.oid, JOSH);
  assert.equal(isVerifiedApprover(body.identity), true);
  assert.equal(isVerifiedPreparer(body.identity), true);
  assert.equal(JSON.stringify(body).includes("test-client-secret"), false);
  assert.equal(JSON.stringify(body).includes(tokens.get(code)), false);
  const replay = await entraFn(req("GET", "https://expresshelp.site/api/identity/entra/callback?code=" + code + "&state=" + state, { cookie: stateCookie }));
  assert.equal(replay.status, 400);
  const stored = await lib.entraStore().get("sess/" + body.identity.sessionId, { type: "json" });
  assert.equal(stored.oid, JOSH);
  assert.equal(stored.id_token, undefined);
  assert.equal(stored.access_token, undefined);
  const logout = await entraFn(req("POST", "https://expresshelp.site/api/identity/entra/logout", { cookie: session, origin: "https://evil.example" }));
  assert.equal(logout.status, 403);
  const gone = await entraFn(req("POST", "https://expresshelp.site/api/identity/entra/logout", { cookie: session, origin: "https://expresshelp.site" }));
  assert.equal(gone.status, 302);
  assert.equal(gone.headers.get("location"), "https://expresshelp.site/admin");
  delete process.env.ENTRA_ALLOW_TEST_ISSUER;
  assert.equal(entraLib.logoutEndpoint(), "https://login.microsoftonline.com/" + TENANT + "/oauth2/v2.0/logout");
  process.env.ENTRA_ALLOW_TEST_ISSUER = "1";
  assert.equal(await lib.entraStore().get("sess/" + body.identity.sessionId, { type: "json" }), null);
});

test("bad issuer, tenant, audience, expiry, nonce, algorithm, and unknown object ids are rejected", async () => {
  const nonce = "nonce-1";
  const good = { oid: NEIL, tid: TENANT, nonce, name: "Neil" };
  assert.equal((await entraLib.verifyIdToken(await sign(good, { issuer: "https://evil.example/v2.0" }), { nonce })).error, "Identity token was rejected");
  assert.equal((await entraLib.verifyIdToken(await sign({ ...good, tid: "99999999-9999-4999-8999-999999999999" }), { nonce })).error, "Identity token was rejected");
  assert.equal((await entraLib.verifyIdToken(await sign({ ...good, aud: "33333333-3333-4333-8333-333333333333" }), { nonce })).error, "Identity token was rejected");
  assert.equal((await entraLib.verifyIdToken(await sign({ ...good, exp: "-10m" }), { nonce })).error, "Identity token was rejected");
  assert.equal((await entraLib.verifyIdToken(await sign({ ...good, nbf: "10m" }), { nonce })).error, "Identity token was rejected");
  assert.equal((await entraLib.verifyIdToken(await sign(good), { nonce: "other" })).error, "Identity token was rejected");
  const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ iss: entraLib.issuer(), aud: CLIENT, oid: NEIL, tid: TENANT, nonce })).toString("base64url") + ".";
  assert.equal(decodeProtectedHeader(none).alg, "none");
  assert.equal((await entraLib.verifyIdToken(none, { nonce })).error, "Identity token was rejected");
  const stranger = entraLib.actorFromSession({ id: "e1", tid: TENANT, oid: "66666666-6666-4666-8666-666666666666", name: "Stranger", exp: Date.now() + 1000, iat: Date.now() });
  assert.equal(stranger.role, "");
  assert.equal(isVerifiedApprover(stranger), false);
  const spoof = entraLib.actorFromSession({ id: "e2", tid: TENANT, oid: PREP, name: "nanderson@libertyretail.com.au", exp: Date.now() + 1000, iat: Date.now() });
  assert.equal(spoof.approverKey, "");
  assert.equal(spoof.preparerClass, "regional-business-manager");
  assert.equal(canSeeDraft(spoof, { siteIds: ["s0000ffff"] }), false);
  assert.equal(canSeeDraft(spoof, { siteIds: [SITE] }), true);
  const saved = process.env.ENTRA_ROLE_MAP;
  process.env.ENTRA_ROLE_MAP = "{}";
  assert.equal(entraLib.rightsFor(NEIL), null);
  process.env.ENTRA_ROLE_MAP = saved;
  assert.equal(entraLib.validateReturnTo("//evil.example"), "/admin");
  assert.equal(entraLib.validateReturnTo("https://expresshelp.site.evil.example/admin"), "/admin");
  assert.equal(entraLib.validateReturnTo("/admin#/pos/p1234abcd"), "/admin#/pos/p1234abcd");
});

test("a session rotates and loses rights when the object id is removed", async () => {
  const row = await entraLib.createSession({ tid: TENANT, oid: NEIL, name: "Neil" });
  row.iat = Date.now() - 20 * 60 * 1000;
  await lib.entraStore().setJSON("sess/" + row.id, row);
  const exp = row.exp;
  const cookie = entraLib.sessionCookie(req("GET", "https://expresshelp.site/admin"), row.id, exp);
  const first = await identityFn(req("GET", "https://expresshelp.site/api/identity/session", { cookie }));
  const renewed = cookieNamed(first, "qr_entra");
  assert.notEqual(renewed, "");
  const body = await first.json();
  assert.equal(body.identity.approverKey, "neil");
  process.env.ENTRA_ROLE_MAP = JSON.stringify({ approverJoshua: { oid: JOSH, siteIds: [SITE] } });
  const after = await identityFn(req("GET", "https://expresshelp.site/api/identity/session", { cookie: renewed }));
  const revoked = await after.json();
  assert.equal(revoked.identity.approverKey, "");
  assert.equal(revoked.assigned, false);
});
