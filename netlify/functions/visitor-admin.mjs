import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import {
  deleteVisit, exportVisits, idPhotoBackfill, listVisits, maintenanceSettings, notificationSettings, readPhoto, readVisit, recoverReceipt, saveMaintenanceSettings, saveNotificationSettings, sheetConnectionCheck, visitorCapability, visitorReadiness,
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
  if (path === "/api/visitor-log/sheet-check") {
    if (!visitorCapability(actor)) return json(403, { error: "Visitor log access is not granted." }, PRIVATE);
    if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "CHECK") return json(400, { error: "Confirm the connection check." }, PRIVATE);
    const result = await sheetConnectionCheck(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/sheet-photo-backfill") {
    if (!visitorCapability(actor)) return json(403, { error: "Visitor log access is not granted." }, PRIVATE);
    if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
    const body = await req.json().catch(() => ({}));
    const result = await idPhotoBackfill(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/settings" && req.method === "GET") {
    const result = await notificationSettings(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/maintenance" && req.method === "GET") {
    const result = await maintenanceSettings(actor);
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
  const one = path.match(/^\/api\/visitor-log\/visits\/(v[a-f0-9]{32})$/);
  if (one && req.method === "GET") {
    const result = await readVisit(actor, one[1]);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const photo = path.match(/^\/api\/visitor-log\/visits\/(v[a-f0-9]{32})\/photo$/);
  if (photo && req.method === "GET") {
    const result = await readPhoto(actor, photo[1]);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return new Response(result.bytes, { status: 200, headers: { "content-type": result.contentType, "content-disposition": "inline; filename=\"visitor-id\"", ...PRIVATE } });
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  const remove = path.match(/^\/api\/visitor-log\/visits\/(v[a-f0-9]{32})\/delete$/);
  if (remove) {
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "DELETE") return json(400, { error: "Type DELETE to remove the record." }, PRIVATE);
    const result = await deleteVisit(actor, remove[1]);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const recover = path.match(/^\/api\/visitor-log\/visits\/(v[a-f0-9]{32})\/recover$/);
  if (recover) {
    const result = await recoverReceipt(actor, recover[1]);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/maintenance" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await saveMaintenanceSettings(actor, body);
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
