import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { previewReadOnly } from "../lib/preview-deploy.mjs";
import { canEditMenu, loadMenu, publicMenu, saveMenu } from "../lib/admin-menu.mjs";

const PRIVATE = { "cache-control": "private, no-store" };

export default async (req, context) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFromRequest(req);
  if (!actor) return unauthorised();
  if (req.method === "GET") {
    const resolved = await loadMenu();
    return json(200, publicMenu(resolved, canEditMenu(actor)), PRIVATE);
  }
  if (previewReadOnly(req, context)) return json(403, { error: "This is a preview for review. Nothing can be saved here." }, PRIVATE);
  if (!canEditMenu(actor)) return forbidden();
  if (req.method !== "POST" && req.method !== "PATCH") return json(405, { error: "Method not allowed" }, PRIVATE);
  const body = await req.json().catch(() => ({}));
  const result = await saveMenu(body);
  return json(result.status, publicMenu(result.body, true), PRIVATE);
};

export const config = { path: "/api/admin-menu" };
