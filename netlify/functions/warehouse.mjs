import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { issueSheet, reprintSheet, setNextNumber, warehouseOverview } from "../lib/warehouse.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const out = (result) => json(result.status, result.body || { error: result.error, ...(result.needsConfirm ? { needsConfirm: true, issuedTop: result.issuedTop } : {}) }, PRIVATE);

/** Admin > Warehouse Stickers. Head office, the owner, and Users with the Warehouse Stickers permission. */
export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const actor = await actorFromRequest(req);
  if (!actor) return json(401, { error: "Unauthorized" }, PRIVATE);
  if (path === "/api/warehouse" && req.method === "GET") return out(await warehouseOverview(actor));
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  const body = await req.json().catch(() => ({}));
  if (path === "/api/warehouse/sheets") return out(await issueSheet(actor, body));
  const reprint = path.match(/^\/api\/warehouse\/sheets\/(\d{1,12})\/reprint$/);
  if (reprint) return out(await reprintSheet(actor, reprint[1]));
  if (path === "/api/warehouse/settings") return out(await setNextNumber(actor, body));
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: ["/api/warehouse", "/api/warehouse/sheets", "/api/warehouse/sheets/*", "/api/warehouse/settings"] };
