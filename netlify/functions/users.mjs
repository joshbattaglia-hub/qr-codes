import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { listUsers, removeUser, saveUser } from "../lib/users.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

/** Admin > Users. Owner (Joshua's email-code sign-in) only; every change is audited in the users store. */
export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const actor = await actorFromRequest(req);
  if (!actor) return json(401, { error: "Unauthorized" }, PRIVATE);
  if (path === "/api/users" && req.method === "GET") {
    const result = await listUsers(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  const body = await req.json().catch(() => ({}));
  if (path === "/api/users/save") {
    const result = await saveUser(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/users/remove") {
    const result = await removeUser(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: ["/api/users", "/api/users/save", "/api/users/remove"] };
