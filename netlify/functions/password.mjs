import { clearCookie, json } from "../lib/lib.mjs";
import { clearStaffCookie, forbidden, jsonCookies, originBlocked } from "../lib/access.mjs";
import { clearIdentityCookie } from "../lib/identity.mjs";
import { checkLink, forgotPassword, passwordLogin, setPasswordFromLink } from "../lib/password-auth.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

async function readBody(req) {
  const text = await req.text();
  if (text.length > 4096) return { error: "Request was rejected" };
  try { return { body: text ? JSON.parse(text) : {} }; }
  catch { return { error: "Request was rejected" }; }
}

/** Password sign-in, forgot password and set-password links for Users. Public endpoints with generic answers. */
export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  if (originBlocked(req)) return forbidden();
  const parsed = await readBody(req);
  if (parsed.error) return json(400, { error: parsed.error }, PRIVATE);
  const body = parsed.body || {};
  if (path === "/api/identity/password/login") {
    const result = await passwordLogin(req, body.email, body.password);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return jsonCookies(200, { ok: true, role: result.actor.role, identity: result.actor }, [result.cookie, clearCookie(req), clearStaffCookie(req), clearIdentityCookie(req)]);
  }
  const route = {
    "/api/identity/password/forgot": () => forgotPassword(req, body.email),
    "/api/identity/password/link": () => checkLink(req, body.token),
    "/api/identity/password/set": () => setPasswordFromLink(req, body.token, body.password),
  }[path];
  if (!route) return json(404, { error: "Not found" }, PRIVATE);
  const result = await route();
  return json(result.status, result.body || { error: result.error }, PRIVATE);
};

export const config = { path: ["/api/identity/password/login", "/api/identity/password/forgot", "/api/identity/password/link", "/api/identity/password/set"] };
