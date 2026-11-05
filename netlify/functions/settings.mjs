import { json, readSettings, settingsStore, validColor } from "../lib/lib.mjs";
import { actorFrom, forbidden, originBlocked, unauthorised } from "../lib/access.mjs";

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  if (req.method === "GET") return json(200, await readSettings());
  if (req.method === "PATCH") {
    if (actor.role !== "head") return forbidden();
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
