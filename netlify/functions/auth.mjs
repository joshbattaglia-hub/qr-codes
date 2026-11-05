import { checkPassword, makeCookie, clearCookie, authed, json } from "../lib/lib.mjs";

export default async (req) => {
  if (req.method === "GET") return json(200, { authenticated: authed(req) });
  if (req.method === "DELETE") return json(200, { ok: true }, { "set-cookie": clearCookie(req) });
  const { password } = await req.json().catch(() => ({}));
  if (!checkPassword(password)) return json(401, { error: "Invalid password" });
  return json(200, { ok: true }, { "set-cookie": makeCookie(req) });
};

export const config = { path: "/api/auth" };
