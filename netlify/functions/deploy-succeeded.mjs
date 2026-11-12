import { migrateUsers } from "../lib/users.mjs";

/**
 * Netlify deploy event. Writes the Users list once from the previous sources (OTP_ALLOWLIST and the building
 * maintenance list) after proving effective access is identical; a no-op once the list exists. Takes no input
 * and returns only a status and counts.
 */
export default async () => {
  try {
    const result = await migrateUsers({ trigger: "deploy" });
    const report = result.report || {};
    return new Response(JSON.stringify({ status: result.status, same: report.same === true, checked: report.checked || 0 }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return new Response(JSON.stringify({ status: "error" }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
};
