import crypto from "node:crypto";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { clearCookie } from "../lib/lib.mjs";
import { clearStaffCookie } from "../lib/access.mjs";
import { json } from "../lib/lib.mjs";
import { clearIdentityCookie } from "../lib/identity.mjs";
import { clearOtpCookie, deleteOtpSession } from "../lib/otp.mjs";
import {
  authorizeUrl, clearSessionCookie, clearStateCookie, clientId, createSession, deleteSession,
  entraConfigured, entraStatus, exchangeCode, logoutEndpoint, logoutReturnUri, pkceChallenge, readSession,
  redirectUri, rotateSession, saveLoginState, sessionCookie, stateCookie, takeLoginState,
  validateReturnTo, verifyIdToken,
} from "../lib/entra.mjs";

function redirect(location, cookies) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function stateFrom(req) {
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_entra_state=([A-Za-z0-9_-]{43})/);
  return match ? match[1] : "";
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/identity/entra/status" && req.method === "GET") return json(200, entraStatus());
  if (path === "/api/identity/entra/start" && req.method === "GET") {
    if (!entraConfigured() || !clientId()) return json(403, { error: "Microsoft sign-in is not configured. Nothing was started." });
    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    await saveLoginState({ state, nonce, verifier, returnTo: url.searchParams.get("returnTo") || "" });
    return redirect(authorizeUrl({ state, nonce, challenge: pkceChallenge(verifier) }), [stateCookie(req, state)]);
  }
  if (path === "/api/identity/entra/callback" && req.method === "GET") {
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!state || state !== stateFrom(req) || !code) return json(400, { error: "Sign-in could not be completed" });
    const saved = await takeLoginState(state);
    if (!saved) return json(400, { error: "Sign-in could not be completed" });
    const exchanged = await exchangeCode({ code, verifier: saved.verifier });
    if (exchanged.error) return json(400, { error: "Sign-in could not be completed" });
    const verified = await verifyIdToken(exchanged.idToken, { nonce: saved.nonce });
    if (verified.error) return json(400, { error: "Sign-in could not be completed" });
    const session = await createSession(verified.claims);
    await deleteOtpSession(req);
    const destination = new URL(redirectUri()).origin + saved.returnTo;
    return redirect(destination, [clearStateCookie(req), sessionCookie(req, session.id, session.exp), clearCookie(req), clearStaffCookie(req), clearIdentityCookie(req), clearOtpCookie(req)]);
  }
  if (path === "/api/identity/entra/logout" && req.method === "POST") {
    if (originBlocked(req)) return forbidden();
    await deleteSession(req);
    await deleteOtpSession(req);
    const microsoft = logoutEndpoint();
    const next = microsoft ? `${microsoft}?post_logout_redirect_uri=${encodeURIComponent(logoutReturnUri())}` : logoutReturnUri();
    return redirect(next, [clearSessionCookie(req), clearStateCookie(req), clearOtpCookie(req)]);
  }
  return json(404, { error: "Not found" });
};

export const config = { path: ["/api/identity/entra/status", "/api/identity/entra/start", "/api/identity/entra/callback", "/api/identity/entra/logout"] };

export function safeReturn(value) {
  return validateReturnTo(value);
}
