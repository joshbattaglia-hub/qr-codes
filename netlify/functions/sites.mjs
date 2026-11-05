import crypto from "node:crypto";
import { json, sitesStore } from "../lib/lib.mjs";
import { actorFrom, canSeeSite, forbidden, unauthorised } from "../lib/access.mjs";

function publicSite(site) {
  return { id: site.id, name: site.name, created: site.created };
}

export default async (req) => {
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const store = sitesStore();
  if (path === "/api/sites" && req.method === "GET") {
    const { blobs } = await store.list();
    const sites = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    return json(200, sites.filter((site) => canSeeSite(actor, site.id)).map(publicSite).sort((a, b) => a.name.localeCompare(b.name)));
  }
  if (path === "/api/sites" && req.method === "POST") {
    if (actor.role !== "head") return forbidden();
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) return json(400, { error: "Name is required" });
    const { blobs } = await store.list();
    const existing = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    if (existing.some((site) => site.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "A site with that name already exists" });
    const site = { id: "s" + crypto.randomBytes(4).toString("hex"), name, created: new Date().toISOString() };
    await store.setJSON(site.id, site);
    return json(201, publicSite(site));
  }
  const one = path.match(/^\/api\/sites\/([^/]+)$/);
  if (!one) return json(404, { error: "Not found" });
  const id = decodeURIComponent(one[1]);
  const site = await store.get(id, { type: "json" });
  if (!site) return json(404, { error: "Not found" });
  if (!canSeeSite(actor, site.id)) return forbidden();
  if (req.method === "GET") return json(200, publicSite(site));
  if (actor.role !== "head") return forbidden();
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) return json(400, { error: "Name is required" });
    const next = { ...site, name };
    await store.setJSON(id, next);
    return json(200, publicSite(next));
  }
  if (req.method === "DELETE") {
    await store.delete(id);
    return json(200, { ok: true });
  }
  return json(405, { error: "Method not allowed" });
};

export const config = { path: ["/api/sites", "/api/sites/:id"] };
