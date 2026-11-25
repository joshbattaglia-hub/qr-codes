import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { previewReadOnly } from "../lib/preview-deploy.mjs";
import { loadFooter, saveFooter } from "../lib/footer.mjs";

const PRIVATE = { "cache-control": "private, no-store" };
const PUBLIC = { "cache-control": "no-store" };

function canEditFooter(actor) {
  return !!(actor && (actor.role === "head" || actor.owner));
}

export default async (req, context) => {
  if (originBlocked(req)) return forbidden();
  if (req.method === "GET") {
    const footer = await loadFooter();
    return json(200, footer, PUBLIC);
  }
  if (previewReadOnly(req, context)) return json(403, { error: "This is a preview for review. Nothing can be saved here." }, PRIVATE);
  const actor = await actorFromRequest(req);
  if (!actor) return unauthorised();
  if (!canEditFooter(actor)) return forbidden();
  if (req.method !== "POST" && req.method !== "PATCH") return json(405, { error: "Method not allowed" }, PRIVATE);
  const body = await req.json().catch(() => ({}));
  const result = await saveFooter(body);
  return json(result.status, result.body || { error: result.error }, PRIVATE);
};

export const config = { path: "/api/footer" };
