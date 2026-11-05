import { authed, json, readSettings, settingsStore, validColor } from "../lib/lib.mjs";

export default async (req) => {
  if (!authed(req)) return json(401, { error: "Unauthorized" });
  if (req.method === "GET") return json(200, await readSettings());
  if (req.method === "PATCH") {
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
