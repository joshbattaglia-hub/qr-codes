import { checkPassword, makeCookie, clearCookie, json, staffStore } from "../lib/lib.mjs";
import { actorFrom, clearStaffCookie, jsonCookies, makeStaffCookie, publicStaff, verifyPassword } from "../lib/access.mjs";

const DUMMY = "scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";

export default async (req) => {
  if (req.method === "GET") {
    const actor = await actorFrom(req);
    if (!actor) return json(200, { authenticated: false });
    return json(200, { authenticated: true, role: actor.role, siteIds: actor.siteIds, name: actor.name });
  }
  if (req.method === "DELETE") {
    return jsonCookies(200, { ok: true }, [clearCookie(req), clearStaffCookie(req)]);
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) {
    if (!checkPassword(body.password)) return json(401, { error: "Invalid password" });
    return jsonCookies(200, { ok: true, role: "head" }, [makeCookie(req), clearStaffCookie(req)]);
  }
  const { blobs } = await staffStore().list().catch(() => ({ blobs: [] }));
  const people = (await Promise.all(blobs.map((b) => staffStore().get(b.key, { type: "json" })))).filter(Boolean);
  const staff = people.find((person) => person.email === email && !person.disabled);
  const match = verifyPassword(body.password, staff?.passwordHash || DUMMY);
  if (!staff || !match) return json(401, { error: "Invalid password" });
  return jsonCookies(200, { ok: true, role: "manager", staff: publicStaff(staff) }, [clearCookie(req), makeStaffCookie(req, staff.id)]);
};

export const config = { path: "/api/auth" };
