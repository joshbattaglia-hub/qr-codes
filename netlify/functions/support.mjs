import { json } from "../lib/lib.mjs";
import { forbidden, jsonCookies, originBlocked } from "../lib/access.mjs";
import { clearSupportCookie, deleteSupportSession } from "../lib/support-auth.mjs";
import { receiveInbound } from "../lib/ticket-mail.mjs";
import { SUBMIT_MAX_BYTES, publicForm, readTracking, submitPublicTicket } from "../lib/support-public.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" };

async function boundedText(req, max) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > max) return null;
  const raw = await req.text();
  return raw.length > max ? null : raw;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const inbound = path.match(/^\/api\/support\/inbound\/(postmark|resend)$/);
  if (inbound && req.method === "POST") {
    const raw = await req.text();
    const result = await receiveInbound(inbound[1], raw, req.headers, req.url);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (req.method !== "GET" && originBlocked(req)) return forbidden();
  if (path === "/api/support/form" && req.method === "GET") {
    const result = await publicForm();
    return json(result.status, result.body, PRIVATE);
  }
  if (path === "/api/support/submit" && req.method === "POST") {
    const raw = await boundedText(req, SUBMIT_MAX_BYTES);
    if (raw === null) return json(413, { error: "The request is too large. Use fewer or smaller files." }, PRIVATE);
    const result = await submitPublicTicket(req, raw);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/support/track" && req.method === "POST") {
    const raw = await boundedText(req, 2000);
    if (raw === null) return json(404, { error: "That tracking link is not valid." }, PRIVATE);
    const result = await readTracking(req, raw);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/support/logout" && req.method === "POST") {
    // Old requester sessions are retired; this only clears a leftover cookie.
    await deleteSupportSession(req);
    return jsonCookies(200, { ok: true }, [clearSupportCookie(req)]);
  }
  // Requester sign-in, session and ticket-list endpoints are retired. Nothing here reads a support session.
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: ["/api/support/form", "/api/support/submit", "/api/support/track", "/api/support/start", "/api/support/verify", "/api/support/logout", "/api/support/session", "/api/support/tickets", "/api/support/tickets/*", "/api/support/inbound/postmark", "/api/support/inbound/resend"] };
