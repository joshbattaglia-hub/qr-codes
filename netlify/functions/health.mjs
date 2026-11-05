import { codes, competitionsStore, healthStore, json } from "../lib/lib.mjs";
import { actorFrom, canSeeSite, forbidden, originBlocked, siteOf, unauthorised } from "../lib/access.mjs";
import { melbourneDate } from "../lib/competitions.mjs";
import { checkDestination } from "../lib/health.mjs";

async function visibleCodes(actor) {
  const { blobs } = await codes().list();
  const rows = (await Promise.all(blobs.map((b) => codes().get(b.key, { type: "json" })))).filter(Boolean);
  return rows.filter((code) => canSeeSite(actor, siteOf(code)));
}

function promotionStatus(comp, today) {
  const expired = comp.status === "ended" || (!!comp.end && comp.end < today);
  return {
    slug: comp.slug,
    name: comp.name || comp.slug,
    siteId: comp.siteId || "",
    kind: "promotion",
    status: expired ? "expired" : "ok",
    reason: expired ? (comp.status === "ended" ? "ended" : "past-close") : "",
    checkedAt: new Date().toISOString(),
  };
}

async function checkOne(code) {
  const result = await checkDestination(code.url);
  const saved = { slug: code.slug, url: code.url, siteId: code.siteId || "", kind: "link", ...result };
  await healthStore().setJSON(code.slug, saved);
  return saved;
}

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const today = melbourneDate();
  if (path === "/api/health" && req.method === "GET") {
    const [linkRows, compBlobs] = await Promise.all([visibleCodes(actor), competitionsStore().list()]);
    const stored = await Promise.all(linkRows.map(async (code) => healthStore().get(code.slug, { type: "json" })));
    const links = linkRows.map((code, i) => stored[i] || { slug: code.slug, url: code.url, siteId: code.siteId || "", kind: "link", status: "unchecked" });
    const comps = (await Promise.all(compBlobs.blobs.map((b) => competitionsStore().get(b.key, { type: "json" })))).filter((comp) => comp && canSeeSite(actor, siteOf(comp)));
    return json(200, { links, promotions: comps.map((comp) => promotionStatus(comp, today)) });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const body = await req.json().catch(() => ({}));
  let targets = await visibleCodes(actor);
  if (body.slug) {
    const slug = String(body.slug).toLowerCase();
    const code = await codes().get(slug, { type: "json" });
    if (!code) return json(404, { error: "Not found" });
    if (!canSeeSite(actor, siteOf(code))) return forbidden();
    targets = [code];
  }
  const out = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const code = targets[cursor++];
      out.push(await checkOne(code));
    }
  }
  const workers = Math.min(3, targets.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return json(200, { checked: out });
};

export const config = { path: ["/api/health", "/api/health/check"] };
