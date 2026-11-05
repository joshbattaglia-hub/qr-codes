import { checkPassword, makeCookie, authed, json } from "../lib/lib.mjs";
export default async (req) => {
  if (req.method === "GET") return json(200, { authenticated: authed(req) });
  if (req.method === "DELETE") return json(200, { ok: true }, { "set-cookie": "qr_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  const { password } = await req.json().catch(() => ({}));
  if (!checkPassword(password)) return json(401, { error: "Invalid password" });
  return json(200, { ok: true }, { "set-cookie": makeCookie() });
};
export const config = { path: "/api/auth" };
