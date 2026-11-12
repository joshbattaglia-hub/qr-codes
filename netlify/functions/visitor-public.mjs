import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { publicMaintenanceContacts, signIn, signOut, visitorReadiness } from "../lib/visitor-log.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

async function bodyOf(req) {
  const text = await req.text();
  if (text.length > 12_000_000) return { error: "The photo is too large." };
  try { return { body: text ? JSON.parse(text) : {} }; }
  catch { return { error: "Request was rejected" }; }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/visit/status" && req.method === "GET") return json(200, visitorReadiness(), PRIVATE);
  if (path === "/api/visit/contacts" && req.method === "GET") {
    const contacts = await publicMaintenanceContacts().catch(() => ({ contacts: [] }));
    return json(200, contacts, PRIVATE);
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  if (originBlocked(req)) return forbidden();
  const parsed = await bodyOf(req);
  if (parsed.error) return json(400, { error: parsed.error }, PRIVATE);
  if (path === "/api/visit/sign-in") {
    const result = await signIn(req, parsed.body);
    return json(result.status, result.body || { error: result.error, blockers: result.blockers }, PRIVATE);
  }
  if (path === "/api/visit/sign-out") {
    const result = await signOut(req, parsed.body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: ["/api/visit/status", "/api/visit/contacts", "/api/visit/sign-in", "/api/visit/sign-out"] };
