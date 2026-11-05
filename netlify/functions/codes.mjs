import crypto from "node:crypto";
import { codes, stats, authed, json } from "../lib/lib.mjs";
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const validUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol); } catch { return false; } };
const gen = () => Array.from(crypto.randomBytes(6), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
export default async (req, context) => {
  if (!authed(req)) return json(401, { error: "Unauthorized" });
  const store = codes(), slug = context.params?.slug;
  if (req.method === "GET" && !slug) {
    const { blobs } = await store.list();
    const out = await Promise.all(blobs.map(async b => {
      const c = await store.get(b.key, { type: "json" }); const s = await stats().get(b.key, { type: "json" });
      return { ...c, total: s?.total || 0, last: s?.last || null };
    }));
    return json(200, out.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created)));
  }
  if (req.method === "POST" && !slug) {
    const b = await req.json().catch(() => ({}));
    if (!validUrl(b.url)) return json(400, { error: "Destination must be a valid http(s) URL" });
    let s = (b.slug || "").trim().toLowerCase();
    if (s) { if (!SLUG.test(s)) return json(400, { error: "Slug: 2-41 chars, a-z 0-9 and -" }); if (await store.get(s)) return json(409, { error: "Slug already in use" }); }
    else { do s = gen(); while (await store.get(s)); }
    const c = { slug: s, url: b.url, name: (b.name || "").slice(0, 120), notes: (b.notes || "").slice(0, 2000), paused: false, created: new Date().toISOString() };
    await store.setJSON(s, c); return json(201, c);
  }
  if (!slug) return json(405, { error: "Method not allowed" });
  const c = await store.get(slug, { type: "json" });
  if (!c) return json(404, { error: "Not found" });
  if (req.method === "GET") return json(200, { code: c, stats: (await stats().get(slug, { type: "json" })) || { total: 0 } });
  if (req.method === "PATCH") {
    const b = await req.json().catch(() => ({}));
    if (b.url !== undefined) { if (!validUrl(b.url)) return json(400, { error: "Destination must be a valid http(s) URL" }); c.url = b.url; }
    if (b.name !== undefined) c.name = String(b.name).slice(0, 120);
    if (b.notes !== undefined) c.notes = String(b.notes).slice(0, 2000);
    if (b.paused !== undefined) c.paused = !!b.paused;
    c.updated = new Date().toISOString(); await store.setJSON(slug, c); return json(200, c);
  }
  if (req.method === "DELETE") { await store.delete(slug); await stats().delete(slug); return json(200, { ok: true }); }
  return json(405, { error: "Method not allowed" });
};
export const config = { path: ["/api/codes", "/api/codes/:slug"] };
