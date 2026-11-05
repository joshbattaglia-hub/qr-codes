import crypto from "node:crypto";
import { json, sitesStore, staffStore } from "../lib/lib.mjs";
import { actorFrom, forbidden, hashPassword, originBlocked, publicStaff, unauthorised } from "../lib/access.mjs";

async function allStaff() {
  const { blobs } = await staffStore().list();
  return (await Promise.all(blobs.map((b) => staffStore().get(b.key, { type: "json" })))).filter(Boolean);
}

async function knownSites(ids) {
  const wanted = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
  for (const id of wanted) {
    const site = await sitesStore().get(id, { type: "json" });
    if (!site) return { error: "Unknown site" };
  }
  return { siteIds: wanted };
}

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  if (actor.role !== "head") return forbidden();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/staff" && req.method === "GET") {
    const people = await allStaff();
    return json(200, people.map(publicStaff).sort((a, b) => String(a.email).localeCompare(String(b.email))));
  }
  if (path === "/api/staff" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 80);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) return json(400, { error: "Name and email are required" });
    if (password.length < 10) return json(400, { error: "Password must be at least 10 characters" });
    if (body.role && body.role !== "manager") return json(400, { error: "Staff are managers" });
    const sites = await knownSites(body.siteIds);
    if (sites.error) return json(400, { error: sites.error });
    const people = await allStaff();
    if (people.some((person) => person.email === email)) return json(409, { error: "That email is already in use" });
    const staff = {
      id: "m" + crypto.randomBytes(4).toString("hex"),
      name, email, siteIds: sites.siteIds, disabled: false,
      passwordHash: hashPassword(password),
      created: new Date().toISOString(),
    };
    await staffStore().setJSON(staff.id, staff);
    return json(201, publicStaff(staff));
  }
  const one = path.match(/^\/api\/staff\/([^/]+)$/);
  if (!one || req.method !== "PATCH") return json(404, { error: "Not found" });
  const id = decodeURIComponent(one[1]);
  const staff = await staffStore().get(id, { type: "json" });
  if (!staff) return json(404, { error: "Not found" });
  const body = await req.json().catch(() => ({}));
  if (body.role && body.role !== "manager") return json(400, { error: "Staff are managers" });
  const next = { ...staff };
  if (body.name !== undefined) next.name = String(body.name || "").trim().slice(0, 80) || staff.name;
  if (body.disabled !== undefined) next.disabled = !!body.disabled;
  if (body.siteIds !== undefined) {
    const sites = await knownSites(body.siteIds);
    if (sites.error) return json(400, { error: sites.error });
    next.siteIds = sites.siteIds;
  }
  if (body.password) {
    if (String(body.password).length < 10) return json(400, { error: "Password must be at least 10 characters" });
    next.passwordHash = hashPassword(body.password);
  }
  delete next.role;
  await staffStore().setJSON(id, next);
  return json(200, publicStaff(next));
};

export const config = { path: ["/api/staff", "/api/staff/:id"] };
