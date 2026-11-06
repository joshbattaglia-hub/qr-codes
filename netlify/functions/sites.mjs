import crypto from "node:crypto";
import { json, siteImports, sitesStore } from "../lib/lib.mjs";
import { canSeeSite, forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { applyImport, auditView, classifyImport, isSiteRecord, readSites, rowsFromDocument } from "../lib/site-import.mjs";

function publicSite(site) {
  const out = { id: site.id, name: site.name, created: site.created };
  for (const key of ["loc", "address", "operationalRegion", "geographicState", "sourceRef", "sourceName"]) {
    if (site[key]) out[key] = site[key];
  }
  if (Array.isArray(site.sourceFlags) && site.sourceFlags.length) out.sourceFlags = site.sourceFlags;
  return out;
}

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFromRequest(req);
  if (!actor) return unauthorised();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const store = sitesStore();
  if (path === "/api/sites" && req.method === "GET") {
    const { blobs } = await store.list();
    const sites = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(isSiteRecord);
    return json(200, sites.filter((site) => canSeeSite(actor, site.id)).map(publicSite).sort((a, b) => a.name.localeCompare(b.name)));
  }
  if (path === "/api/sites" && req.method === "POST") {
    if (actor.role !== "head") return forbidden();
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) return json(400, { error: "Name is required" });
    const { blobs } = await store.list();
    const existing = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(isSiteRecord);
    if (existing.some((site) => site.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "A site with that name already exists" });
    const site = { id: "s" + crypto.randomBytes(4).toString("hex"), name, created: new Date().toISOString() };
    await store.setJSON(site.id, site);
    return json(201, publicSite(site));
  }
  if (path === "/api/sites/import" && (req.method === "POST" || req.method === "GET")) {
    if (actor.role !== "head") return forbidden();
    if (req.method === "GET") {
      const { blobs } = await siteImports().list();
      const rows = (await Promise.all(blobs.map((blob) => siteImports().get(blob.key, { type: "json" })))).filter(Boolean);
      return json(200, rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20));
    }
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const input = rowsFromDocument(body.sites ? body : (body.rows || body));
    if (!input) return json(400, { error: "Import JSON must be a rows array or a sites document" });
    const report = dryRun ? classifyImport(await readSites(store), input) : await applyImport(store, input);
    if (report.error) return json(400, { error: report.error });
    const saved = { id: "i" + crypto.randomBytes(6).toString("hex"), at: new Date().toISOString(), dryRun, ...auditView(report) };
    if (!dryRun) await siteImports().setJSON(saved.id, saved);
    const { plan, ...rest } = report;
    return json(200, { dryRun, ...rest, audit: auditView(report) });
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

export const config = { path: ["/api/sites", "/api/sites/import", "/api/sites/:id"] };
