import { visitorStore } from "./lib.mjs";

/** Building maintenance users: Visitor Log read-only (visits, records, ID photos). Managed by Joshua only. */
export const BUILDING_MAINTENANCE_KEY = "access/building-maintenance";
export const BUILDING_MAINTENANCE_DOMAIN = "libertyretail.com.au";
export const BUILDING_MAINTENANCE_ROLE = "building-maintenance";
export const BUILDING_MAINTENANCE_MAX = 50;

/** One exact @libertyretail.com.au address (no subdomains, lookalikes or lists). */
export function buildingMaintenanceEmailOk(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 254) return "";
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at) return "";
  if (email.slice(at + 1) !== BUILDING_MAINTENANCE_DOMAIN) return "";
  const local = email.slice(0, at);
  if (!/^[a-z0-9._%+-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "";
  return email;
}

export async function readBuildingMaintenance() {
  const meta = await visitorStore().getWithMetadata(BUILDING_MAINTENANCE_KEY, { type: "json", consistency: "strong" });
  const emails = Array.isArray(meta?.data?.emails) ? meta.data.emails.map(buildingMaintenanceEmailOk).filter(Boolean) : [];
  return { emails: [...new Set(emails)].sort(), etag: meta?.etag || "" };
}

export async function isBuildingMaintenance(email) {
  const address = buildingMaintenanceEmailOk(email);
  if (!address) return false;
  return (await readBuildingMaintenance()).emails.includes(address);
}

/** Conditional write so concurrent add/remove cannot lose a change. */
export async function writeBuildingMaintenance(emails, etag) {
  const body = { emails: [...new Set(emails)].sort(), updatedAt: new Date().toISOString() };
  const options = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
  const write = await visitorStore().setJSON(BUILDING_MAINTENANCE_KEY, body, options);
  return write?.modified === true;
}
