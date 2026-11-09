import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import {
  exportVisits, listVisits, notificationSettings, readPhoto, recoverReceipt, saveNotificationSettings, visitorCapability, visitorReadiness,
} from "../lib/visitor-log.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const actor = await actorFromRequest(req);
  if (path === "/api/visitor-log/readiness" && req.method === "GET") {
    return json(200, { ...visitorReadiness(), granted: visitorCapability(actor) }, PRIVATE);
  }
  if (!actor) return json(401, { error: "Unauthorized" }, PRIVATE);
  if (path === "/api/visitor-log/settings" && req.method === "GET") {
    const result = await notificationSettings(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/visits" && req.method === "GET") {
    const result = await listVisits(actor, url.searchParams);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/export" && req.method === "GET") {
    const result = await exportVisits(actor);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return new Response(result.body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=\"visitor-log.csv\"", ...PRIVATE } });
  }
  const photo = path.match(/^\/api\/visitor-log\/visits\/(v[a-f0-9]{32})\/photo$/);
  if (photo && req.method === "GET") {
    const result = await readPhoto(actor, photo[1]);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return new Response(result.bytes, { status: 200, headers: { "content-type": result.contentType, "content-disposition": "inline; filename=\"visitor-id\"", ...PRIVATE } });
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  const recover = path.match(/^\/api\/visitor-log\/visits\/(v[a-f0-9]{32})\/recover$/);
  if (recover) {
    const result = await recoverReceipt(actor, recover[1]);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/settings" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await saveNotificationSettings(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: "/api/visitor-log/*" };
