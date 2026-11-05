import crypto from "node:crypto";
import {
  competitionsStore, json, pagesStore, publicBase, templatesStore, validSlug,
} from "../lib/lib.mjs";
import { actorFrom, assignSite, canSeeSite, forbidden, siteOf, unauthorised } from "../lib/access.mjs";
import { applyCompetitionPatch, defaultCompetition, publicCompetition } from "../lib/competitions.mjs";
import { applyPagePatch, defaultPage, publicPage } from "../lib/pages.mjs";
import { competitionSnapshot, pageSnapshot } from "../lib/templates.mjs";

const gen = () => Array.from(crypto.randomBytes(6), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

function publicTemplate(template) {
  return { id: template.id, name: template.name, kind: template.kind, siteId: template.siteId || "", created: template.created };
}

export default async (req) => {
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const store = templatesStore();
  if (path === "/api/templates" && req.method === "GET") {
    const { blobs } = await store.list();
    const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    return json(200, rows.filter((row) => canSeeSite(actor, row.siteId || "")).map(publicTemplate));
  }
  if (path === "/api/templates" && req.method === "POST") return saveTemplate(req, actor);
  const use = path.match(/^\/api\/templates\/([^/]+)\/use$/);
  if (use && req.method === "POST") return useTemplate(decodeURIComponent(use[1]), req, actor);
  return json(404, { error: "Not found" });
};

async function saveTemplate(req, actor) {
  const body = await req.json().catch(() => ({}));
  const kind = body.kind === "page" ? "page" : body.kind === "competition" ? "competition" : "";
  if (!kind) return json(400, { error: "Kind must be competition or page" });
  const slug = String(body.slug || "").toLowerCase();
  const source = kind === "page" ? await pagesStore().get(slug, { type: "json" }) : await competitionsStore().get(slug, { type: "json" });
  if (!source) return json(404, { error: "Not found" });
  if (!canSeeSite(actor, siteOf(source))) return forbidden();
  const template = {
    id: "t" + crypto.randomBytes(4).toString("hex"),
    name: String(body.name || source.name || "Template").trim().slice(0, 140),
    kind,
    siteId: source.siteId || "",
    snapshot: kind === "page" ? pageSnapshot(source) : competitionSnapshot(source),
    created: new Date().toISOString(),
  };
  await templatesStore().setJSON(template.id, template);
  return json(201, publicTemplate(template));
}

async function useTemplate(id, req, actor) {
  const template = await templatesStore().get(id, { type: "json" });
  if (!template) return json(404, { error: "Not found" });
  if (!canSeeSite(actor, template.siteId || "")) return forbidden();
  const body = await req.json().catch(() => ({}));
  const assigned = assignSite(actor, null, Object.prototype.hasOwnProperty.call(body, "siteId") ? body : { siteId: template.siteId || "" });
  if (assigned.error) return forbidden();
  let slug = String(body.slug || "").trim().toLowerCase();
  const bucket = template.kind === "page" ? pagesStore() : competitionsStore();
  if (slug) {
    if (!validSlug(slug)) return json(400, { error: "Slug: 2–41 chars, a-z, 0-9 and hyphens" });
    if (await bucket.get(slug)) return json(409, { error: "Slug already in use" });
  } else do slug = gen(); while (await bucket.get(slug));
  if (template.kind === "page") {
    const built = applyPagePatch(defaultPage({ slug, created: new Date().toISOString() }), { ...template.snapshot, name: body.name || template.snapshot.name || "Untitled page", status: "draft", codeSlug: "" });
    if (built.error) return json(400, { error: built.error });
    const page = { ...built.page, slug, siteId: assigned.siteId, status: "draft", codeSlug: "" };
    await pagesStore().setJSON(slug, page);
    return json(201, { kind: "page", page: publicPage(page), url: publicBase() + "/p/" + slug });
  }
  const snap = template.snapshot || {};
  const built = applyCompetitionPatch(defaultCompetition({ slug, created: new Date().toISOString() }), {
    ...snap,
    name: body.name || snap.name || "Untitled competition",
    sites: body.sites !== undefined ? body.sites : snap.sites,
    prize: body.prize !== undefined ? body.prize : snap.prize,
    start: body.start !== undefined ? body.start : snap.start,
    end: body.end !== undefined ? body.end : snap.end,
    status: "draft",
    codeSlug: "",
    voucher: { enabled: false },
  });
  if (built.error) return json(400, { error: built.error });
  const comp = { ...built.competition, slug, siteId: assigned.siteId, winners: [], currentPeriod: 1, status: "draft", codeSlug: "", voucher: { enabled: false } };
  await competitionsStore().setJSON(slug, comp);
  return json(201, { kind: "competition", competition: publicCompetition(comp), url: publicBase() + "/c/" + slug });
}

export const config = { path: ["/api/templates", "/api/templates/:id/use"] };
