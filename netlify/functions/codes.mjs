import crypto from "node:crypto";
import {
  codes, stats, authed, json, validSlug, readSettings, buildCode, applyPatch,
  normalizeCode, publicCode, migrateStats, statsForList,
} from "../lib/lib.mjs";

const gen = () => Array.from(crypto.randomBytes(6), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

export default async (req, context) => {
  if (!authed(req)) return json(401, { error: "Unauthorized" });
  const store = codes();
  const slug = context.params?.slug ? String(context.params.slug).toLowerCase() : "";

  if (req.method === "GET" && !slug) {
    const { blobs } = await store.list();
    const out = await Promise.all(blobs.map(async (b) => {
      const c = await store.get(b.key, { type: "json" });
      if (!c) return null;
      const raw = await stats().get(b.key, { type: "json" });
      const summary = statsForList(raw);
      return { ...publicCode(c), scans: summary.scans, clicks: summary.clicks, total: summary.total, last: summary.last, days: summary.days };
    }));
    return json(200, out.filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created))));
  }

  if (req.method === "POST" && !slug) {
    const body = await req.json().catch(() => ({}));
    const settings = await readSettings();
    const built = buildCode(body, settings);
    if (built.error) return json(400, { error: built.error });
    let s = String(body.slug || "").trim().toLowerCase();
    if (s) {
      if (!validSlug(s)) return json(400, { error: "Slug: 2–41 chars, a-z, 0-9 and hyphens" });
      if (await store.get(s)) return json(409, { error: "Slug already in use" });
    } else {
      do s = gen(); while (await store.get(s));
    }
    const c = { ...built.code, slug: s };
    await store.setJSON(s, c);
    return json(201, publicCode(c));
  }

  if (!slug) return json(405, { error: "Method not allowed" });
  const existing = await store.get(slug, { type: "json" });
  if (!existing) return json(404, { error: "Not found" });

  if (req.method === "GET") {
    const raw = await stats().get(slug, { type: "json" });
    return json(200, { code: publicCode(existing, { logo: true }), stats: migrateStats(raw) });
  }

  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const patched = applyPatch(normalizeCode(existing), body);
    if (patched.error) return json(400, { error: patched.error });
    const c = { ...existing, ...patched.code, slug };
    await store.setJSON(slug, c);
    return json(200, publicCode(c, { logo: true }));
  }

  if (req.method === "DELETE") {
    await store.delete(slug);
    await stats().delete(slug);
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
};

export const config = { path: ["/api/codes", "/api/codes/:slug"] };
