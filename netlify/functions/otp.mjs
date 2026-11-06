import { json } from "../lib/lib.mjs";
import { clearCookie } from "../lib/lib.mjs";
import { clearStaffCookie, forbidden, jsonCookies, originBlocked } from "../lib/access.mjs";
import { clearIdentityCookie } from "../lib/identity.mjs";
import { otpStatus, startOtp, verifyOtp } from "../lib/otp.mjs";

async function readBody(req) {
  const text = await req.text();
  if (text.length > 2048) return { error: "Request was rejected" };
  try { return { body: text ? JSON.parse(text) : {} }; }
  catch { return { error: "Request was rejected" }; }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/identity/otp/status" && req.method === "GET") {
    const status = otpStatus();
    return json(200, {
      configured: status.configured,
      operational: status.operational,
      mock: status.mock,
      setup: status.setup,
    });
  }
  if (req.method !== "POST") return json(405, { error: "Not found" });
  if (originBlocked(req)) return forbidden();
  const parsed = await readBody(req);
  if (parsed.error) return json(400, { error: parsed.error });
  if (path === "/api/identity/otp/start") {
    const result = await startOtp(req, parsed.body?.email);
    if (result.body) return json(result.status, result.body);
    return json(result.status, { error: result.error });
  }
  if (path === "/api/identity/otp/verify") {
    const result = await verifyOtp(req, parsed.body?.email, parsed.body?.code);
    if (result.status !== 200) return json(result.status, { error: result.error });
    return jsonCookies(200, { ok: true, role: result.actor.role, identity: result.actor }, [result.cookie, clearCookie(req), clearStaffCookie(req), clearIdentityCookie(req)]);
  }
  return json(404, { error: "Not found" });
};

export const config = { path: ["/api/identity/otp/status", "/api/identity/otp/start", "/api/identity/otp/verify"] };
