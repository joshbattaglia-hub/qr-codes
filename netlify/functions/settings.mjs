import { json, readSettings, settingsStore, validColor } from "../lib/lib.mjs";
import { forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest, officeActor } from "../lib/identity.mjs";
import { previewReadOnly } from "../lib/preview-deploy.mjs";

const PREVIEW_BLOCKED = "This is a preview for review. Nothing can be saved here.";

export default async (req, context) => {
  if (originBlocked(req)) return forbidden();
  const actor = officeActor(await actorFromRequest(req));
  if (!actor) return unauthorised();
  if (actor.role !== "head" && actor.role !== "manager") return forbidden();
  if (req.method === "GET") return json(200, await readSettings());
  if (req.method === "PATCH") {
    if (actor.role !== "head") return forbidden();
    if (previewReadOnly(req, context)) return json(403, { error: PREVIEW_BLOCKED });
    const body = await req.json().catch(() => ({}));
    const current = await readSettings();
    const next = {
      workspaceName: String(body.workspaceName ?? current.workspaceName).trim().slice(0, 40) || "Liberty",
      defaultFg: body.defaultFg ?? current.defaultFg,
      defaultBg: body.defaultBg ?? current.defaultBg,
    };
    if (!validColor(next.defaultFg) || !validColor(next.defaultBg)) return json(400, { error: "Colours must be hex values like #112233" });
    await settingsStore().setJSON("workspace", next);
    return json(200, await readSettings());
  }
  return json(405, { error: "Method not allowed" });
};

export const config = { path: "/api/settings" };
