import { json } from "../lib/lib.mjs";
import { clearCookie } from "../lib/lib.mjs";
import { actorFrom, clearStaffCookie, forbidden, jsonCookies, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest, bindIdentity, clearIdentityCookie, entraActor, identityStatus, loginIdentity } from "../lib/identity.mjs";
import { clearOtpCookie, deleteOtpSession, otpSessionView } from "../lib/otp.mjs";
import { entraStatus } from "../lib/entra.mjs";
import { mailConfigured, mailMode, mailSetupMessage } from "../lib/mail.mjs";

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/identity/status" && req.method === "GET") {
    const actor = await actorFromRequest(req);
    if (!actor) return unauthorised();
    if (actor.role === "building-maintenance") return forbidden();
    const status = await identityStatus();
    return json(200, { ...status, mailConfigured: mailConfigured(), mailMode: mailMode(), mailSetup: mailMode() === "disabled" ? mailSetupMessage() : mailMode() === "mock" ? "Local test mail only. No message leaves this process." : "", actor: { role: actor.role, kind: actor.kind || "", approverKey: actor.approverKey || "", preparerClass: actor.preparerClass || "" } });
  }
  if (path === "/api/identity/session" && req.method === "GET") {
    const entra = await entraActor(req);
    if (entra.actor) {
      const body = { authenticated: true, assigned: !!entra.actor.role, role: entra.actor.role, identity: entra.actor, entra: true };
      if (!entra.cookie) return json(200, body);
      return jsonCookies(200, body, [entra.cookie]);
    }
    const otp = await otpSessionView(req);
    if (otp.cookie && !otp.actor) return jsonCookies(200, { authenticated: false }, [otp.cookie]);
    if (otp.actor) {
      const body = { authenticated: true, role: otp.actor.role, identity: otp.actor, otp: true };
      if (!otp.cookie) return json(200, body);
      return jsonCookies(200, body, [otp.cookie]);
    }
    const actor = await actorFromRequest(req);
    if (!actor || actor.kind !== "verified-identity") return json(200, { authenticated: false });
    return json(200, { authenticated: true, role: actor.role, identity: actor });
  }
  if (path === "/api/identity/session" && req.method === "DELETE") {
    await deleteOtpSession(req);
    return jsonCookies(200, { ok: true }, [clearIdentityCookie(req), clearCookie(req), clearStaffCookie(req), clearOtpCookie(req)]);
  }
  if (path === "/api/identity/session" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await loginIdentity(req, body);
    if (result.response) return result.response;
    return json(result.status, { error: result.error });
  }
  if (path === "/api/identity/bind" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const caller = await actorFrom(req);
    const result = await bindIdentity(body, req.headers.get("x-identity-bind-token") || "", { privilegedSession: caller?.role === "head" || caller?.role === "manager" });
    if (result.status !== 201) return json(result.status, { error: result.error });
    return json(201, { identity: result.identity });
  }
  return json(404, { error: "Not found" });
};

export const config = { path: ["/api/identity/status", "/api/identity/session", "/api/identity/bind"] };
