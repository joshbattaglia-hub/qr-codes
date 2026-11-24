import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { idempotentSubmit, publicMaintenanceContacts, readFirstMaintenance, signIn, signOut, visitorReadiness } from "../lib/visitor-log.mjs";
import { publicSiteDirectory } from "../lib/site-details.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

async function bodyOf(req) {
  const text = await req.text();
  if (text.length > 12_000_000) return { error: "The photo is too large." };
  try { return { body: text ? JSON.parse(text) : {} }; }
  catch { return { error: "Request was rejected" }; }
}

// Deploy previews and draft deploys share the live site's data, so on anything that is not the production deploy
// the Visitor Log is look-only: no sign-ins, sign-outs or settings changes can be saved there.
export function previewReadOnly(req, context) {
  const ctx = context?.deploy?.context;
  return !!ctx && ctx !== "production" && !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
}

export default async (req, context) => {
  if (previewReadOnly(req, context)) return json(403, { error: "This is a preview for review. Nothing can be saved here." }, { "cache-control": "private, no-store" });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/visit/status" && req.method === "GET") return json(200, visitorReadiness(), PRIVATE);
  if (path === "/api/visit/contacts" && req.method === "GET") {
    const contacts = await publicMaintenanceContacts().catch(() => ({ contacts: [] }));
    return json(200, contacts, PRIVATE);
  }
  if (path === "/api/visit/sites" && req.method === "GET") {
    // Public site directory for the site picker: names, LOC, address, phone, ABN / trading name and map points of
    // our own sites. Nothing about visitors. "Use my location" is worked out in the browser; coordinates are never sent here.
    const directory = await publicSiteDirectory({ readFirstMaintenance }).catch(() => ({ sites: [], total: 0, withCoordinates: 0 }));
    return json(200, directory, { "cache-control": "public, max-age=60", "referrer-policy": "no-referrer" });
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  if (originBlocked(req)) return forbidden();
  const parsed = await bodyOf(req);
  if (parsed.error) return json(400, { error: parsed.error }, PRIVATE);
  if (path === "/api/visit/sign-in") {
    const result = await idempotentSubmit("in", parsed.body?.idempotencyKey, () => signIn(req, parsed.body));
    return json(result.status, result.body || { error: result.error, blockers: result.blockers }, PRIVATE);
  }
  if (path === "/api/visit/sign-out") {
    const result = await idempotentSubmit("out", parsed.body?.idempotencyKey, () => signOut(req, parsed.body));
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: ["/api/visit/status", "/api/visit/contacts", "/api/visit/sites", "/api/visit/sign-in", "/api/visit/sign-out"] };
