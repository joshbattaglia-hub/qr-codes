import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { previewReadOnly } from "../lib/preview-deploy.mjs";
export { previewReadOnly };
import { actorFromRequest } from "../lib/identity.mjs";
import {
  changeBuildingMaintenance, changeNotificationRecipients, listBuildingMaintenance, visitorRole, deleteVisit, exportVisits, idPhotoBackfill, listVisits, maintenanceSettings, notificationSettings, readPhoto, readVisit, recoverReceipt, saveMaintenanceSettings, saveNotificationSettings, sheetConnectionCheck, visitorCapability, visitorReadiness, visitorSettingsCapability,
  archiveManagedSite, createManagedSite, geocodeManagedSite, hideManagedSite, importSiteDetails, saveCompanyDetails, saveDefaultContactEmailSetting, savePickerTypeSetting, siteDetailCsv, siteDetailSettings, updateManagedSite,
} from "../lib/visitor-log.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export default async (req, context) => {
  if (previewReadOnly(req, context)) return json(403, { error: "This is a preview for review. Nothing can be saved here." }, { "cache-control": "private, no-store" });
  if (originBlocked(req)) return forbidden();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const actor = await actorFromRequest(req);
  if (path === "/api/visitor-log/readiness" && req.method === "GET") {
    const role = await visitorRole(actor);
    // People without Visitor Log access get no readiness detail (the tab is off for them).
    if (role === "none") return json(403, { granted: false, role: "none", error: "Visitor log access is not granted." }, PRIVATE);
    return json(200, { ...visitorReadiness(), granted: true, role }, PRIVATE);
  }
  if (!actor) return json(401, { error: "Unauthorized" }, PRIVATE);
  if (path === "/api/visitor-log/sheet-check") {
    if (!(await visitorSettingsCapability(actor))) return json(403, { error: "Visitor log access is not granted." }, PRIVATE);
    if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "CHECK") return json(400, { error: "Confirm the connection check." }, PRIVATE);
    const result = await sheetConnectionCheck(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/sheet-photo-backfill") {
    if (!(await visitorSettingsCapability(actor))) return json(403, { error: "Visitor log access is not granted." }, PRIVATE);
    if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
    const body = await req.json().catch(() => ({}));
    const result = await idPhotoBackfill(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/notify-recipients") {
    if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
    const body = await req.json().catch(() => ({}));
    const result = await changeNotificationRecipients(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/building-maintenance") {
    if (req.method === "GET") {
      const result = await listBuildingMaintenance(actor);
      return json(result.status, result.body || { error: result.error }, PRIVATE);
    }
    if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
    const body = await req.json().catch(() => ({}));
    const result = await changeBuildingMaintenance(actor, body);
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
  if (path === "/api/visitor-log/site-details" && req.method === "GET") {
    const result = await siteDetailSettings(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/site-details.csv" && req.method === "GET") {
    const typesParam = url.searchParams.has("types") ? url.searchParams.getAll("types") : undefined;
    const result = await siteDetailCsv(actor, typesParam);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return new Response(result.body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=\"site-details.csv\"", ...PRIVATE } });
  }
  if (path === "/api/visitor-log/sites/geocode" && req.method === "GET") {
    const result = await geocodeManagedSite(actor, url.searchParams.get("address") || "");
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
  if (path === "/api/visitor-log/company" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await saveCompanyDetails(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/contact-email" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await saveDefaultContactEmailSetting(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/site-details/import" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await importSiteDetails(actor, body);
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
  if (path === "/api/visitor-log/picker-types" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await savePickerTypeSetting(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/visitor-log/sites" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await createManagedSite(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const siteOne = path.match(/^\/api\/visitor-log\/sites\/(s[a-f0-9]{8})$/);
  if (siteOne) {
    const body = await req.json().catch(() => ({}));
    const result = await updateManagedSite(actor, siteOne[1], body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const siteHide = path.match(/^\/api\/visitor-log\/sites\/(s[a-f0-9]{8})\/(hide|unhide)$/);
  if (siteHide) {
    const result = await hideManagedSite(actor, siteHide[1], siteHide[2] === "hide");
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const siteArchive = path.match(/^\/api\/visitor-log\/sites\/(s[a-f0-9]{8})\/(remove|restore)$/);
  if (siteArchive) {
    const body = await req.json().catch(() => ({}));
    const result = await archiveManagedSite(actor, siteArchive[1], { ...body, archived: siteArchive[2] === "remove" });
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: "/api/visitor-log/*" };
