import { json } from "../lib/lib.mjs";
import { actorFrom, forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { readTvSettings, saveTvSettings, tvFeed } from "../lib/tv.mjs";
import { tvTickets, verifyTvKey } from "../lib/tv-tickets.mjs";

const PRIVATE_TV = { "cache-control": "no-store", "netlify-cdn-cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" };

const PUBLIC = {
  "cache-control": "public, max-age=60",
  "netlify-cdn-cache-control": "public, s-maxage=300, stale-while-revalidate=600",
  "x-robots-tag": "noindex, nofollow",
  "access-control-allow-origin": "*",
};

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/api/tv/truckies-lounge") {
    if (req.method !== "GET") return json(405, { error: "Method not allowed" }, PUBLIC);
    try { return json(200, await tvFeed(url.searchParams), PUBLIC); }
    catch { return json(503, { error: "Feed unavailable" }, { ...PUBLIC, "cache-control": "no-store", "netlify-cdn-cache-control": "no-store" }); }
  }
  if (path === "/api/tv/tickets") {
    // Read-only, behind the TV link key. The TV page sends it as ?key=; a wrong, missing or replaced key is a plain 401.
    if (req.method !== "GET") return json(405, { error: "Method not allowed" }, PRIVATE_TV);
    if (!(await verifyTvKey(url.searchParams.get("key")))) return json(401, { error: "Unauthorised" }, PRIVATE_TV);
    try { return json(200, await tvTickets(), PRIVATE_TV); }
    catch { return json(503, { error: "Tickets unavailable" }, PRIVATE_TV); }
  }
  if (path === "/api/tv/settings") {
    if (originBlocked(req)) return forbidden();
    const actor = await actorFrom(req);
    if (!actor) return unauthorised();
    if (actor.role !== "head") return forbidden();
    if (req.method === "GET") return json(200, await readTvSettings(), { "cache-control": "no-store" });
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const result = await saveTvSettings(body);
      return json(result.status, result.body || { error: result.error }, { "cache-control": "no-store" });
    }
    return json(405, { error: "Method not allowed" });
  }
  return json(404, { error: "Not found" });
};

export const config = { path: ["/api/tv/truckies-lounge", "/api/tv/tickets", "/api/tv/settings"] };
