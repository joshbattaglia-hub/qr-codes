import crypto from "node:crypto";
import {
  codes, stats, json, validSlug, readSettings, buildCode, applyPatch,
  normalizeCode, publicCode, statsForList, groupedCountryStats, publicBase, healthStore,
} from "../lib/lib.mjs";
import { actorFrom, assignmentResponse, assignSite, canSeeSite, forbidden, originBlocked, siteOf, unauthorised } from "../lib/access.mjs";
import { validateVoucher } from "../lib/vouchers.mjs";
import { posterHtml } from "../lib/posters.mjs";

const gen = () => Array.from(crypto.randomBytes(6), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

function voucherOf(body) {
  const offer = validateVoucher(body);
  if (offer.error) return offer;
  return offer.voucher ? { voucher: offer.voucher } : undefined;
}

export default async (req, context) => {
  const store = codes();
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const posterMatch = path.match(/^\/api\/codes\/([^/]+)\/poster$/);
  const oneMatch = path.match(/^\/api\/codes\/([^/]+)$/);
  const codeSlug = decodeURIComponent((posterMatch || oneMatch)?.[1] || "").toLowerCase();
  if (originBlocked(req)) return forbidden();
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();

  if (req.method === "GET" && path === "/api/codes") {
    const { blobs } = await store.list();
    const out = await Promise.all(blobs.map(async (b) => {
      const c = await store.get(b.key, { type: "json" });
      if (!c || !canSeeSite(actor, siteOf(c))) return null;
      const raw = await stats().get(b.key, { type: "json" });
      const summary = statsForList(raw);
      const health = await healthStore().get(b.key, { type: "json" }).catch(() => null);
      return { ...publicCode(c), scans: summary.scans, clicks: summary.clicks, total: summary.total, last: summary.last, days: summary.days, health: health || null };
    }));
    return json(200, out.filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created))));
  }

  if (req.method === "POST" && path === "/api/codes") {
    const body = await req.json().catch(() => ({}));
    const assigned = await assignSite(actor, null, body);
    const denied = assignmentResponse(assigned);
    if (denied) return denied;
    const settings = await readSettings();
    const built = buildCode(body, settings);
    if (built.error) return json(400, { error: built.error });
    const offer = voucherOf(body);
    if (offer?.error) return json(400, { error: offer.error });
    let s = String(body.slug || "").trim().toLowerCase();
    if (s) {
      if (!validSlug(s)) return json(400, { error: "Slug: 2–41 chars, a-z, 0-9 and hyphens" });
      if (await store.get(s)) return json(409, { error: "Slug already in use" });
    } else {
      do s = gen(); while (await store.get(s));
    }
    const c = { ...built.code, slug: s, siteId: assigned.siteId, ...(offer ? { voucher: offer.voucher } : {}) };
    await store.setJSON(s, c);
    return json(201, publicCode(c));
  }

  if (!codeSlug) return json(405, { error: "Method not allowed" });
  const existing = await store.get(codeSlug, { type: "json" });
  if (!existing) return json(404, { error: "Not found" });
  if (!canSeeSite(actor, siteOf(existing))) return forbidden();

  if (posterMatch && req.method === "GET") {
    const size = new URL(req.url).searchParams.get("size") === "a3" ? "a3" : "a4";
    const html = posterHtml(
      { name: existing.name, heading: existing.name || existing.slug, body: existing.notes || "", prize: "", colors: {}, logoData: existing.logoData || "" },
      { base: publicBase(), size, url: publicBase() + "/r/" + existing.slug + "?qr=1" },
    );
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (req.method === "GET") {
    const raw = await stats().get(codeSlug, { type: "json" });
    const health = await healthStore().get(codeSlug, { type: "json" }).catch(() => null);
    return json(200, { code: publicCode(existing, { logo: true }), stats: groupedCountryStats(raw), health: health || null });
  }

  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const assigned = await assignSite(actor, existing, body);
    const denied = assignmentResponse(assigned);
    if (denied) return denied;
    const patched = applyPatch(normalizeCode(existing), body);
    if (patched.error) return json(400, { error: patched.error });
    const offer = voucherOf(body);
    if (offer?.error) return json(400, { error: offer.error });
    const c = { ...existing, ...patched.code, slug: codeSlug, siteId: assigned.siteId, ...(offer ? { voucher: offer.voucher } : {}) };
    await store.setJSON(codeSlug, c);
    return json(200, publicCode(c, { logo: true }));
  }

  if (req.method === "DELETE") {
    await store.delete(codeSlug);
    await stats().delete(codeSlug);
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
};

export const config = { path: ["/api/codes", "/api/codes/:slug", "/api/codes/:slug/poster"] };
