import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { requestStatus, submitRequest } from "../lib/access-request.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

/** Signed-in email-code users ask Joshua for a tool they do not have. Sends one email; grants nothing. */
export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const url = new URL(req.url);
  const actor = await actorFromRequest(req);
  if (!actor) return json(401, { error: "Unauthorized" }, PRIVATE);
  if (req.method === "GET") {
    const result = await requestStatus(actor, url.searchParams.get("tool") || "");
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  const text = await req.text();
  if (text.length > 4096) return json(400, { error: "Request was rejected" }, PRIVATE);
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { return json(400, { error: "Request was rejected" }, PRIVATE); }
  const result = await submitRequest(actor, body);
  return json(result.status, result.body || { error: result.error }, PRIVATE);
};

export const config = { path: "/api/access-request" };
