import crypto from "node:crypto";
import { json, posDrafts, sitesStore } from "../lib/lib.mjs";
import { actorFrom, canSeeSite, forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { code128Svg, code128Values } from "../lib/code128.mjs";
import { packageFiles, safeDownloadName, zipStore } from "../lib/pos-package.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(value) {
  const text = String(value ?? "");
  if (!DATE.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function canSeeDraft(actor, draft) {
  const ids = draft?.siteIds || [];
  if (!ids.length) return actor?.role === "head";
  return ids.every((id) => canSeeSite(actor, id));
}

async function resolveSites(actor, siteIds) {
  if (!Array.isArray(siteIds)) return { error: "Eligible sites must be a list", status: 400 };
  const ids = [...new Set(siteIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length > 20) return { error: "Choose up to 20 sites", status: 400 };
  if (!ids.length) {
    if (actor.role !== "head") return { error: "Forbidden", status: 403 };
    return { siteIds: [], sites: [] };
  }
  const sites = [];
  for (const id of ids) {
    if (!/^s[a-f0-9]{8}$/.test(id)) return { error: "Unknown site", status: 400 };
    if (!canSeeSite(actor, id)) return { error: "Forbidden", status: 403 };
    const site = await sitesStore().get(id, { type: "json" });
    if (!site) return { error: "Unknown site", status: 400 };
    sites.push({ id: site.id, name: site.name });
  }
  return { siteIds: ids, sites };
}

function cleanText(value, max, label) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  if (!text) return { error: label + " is required" };
  if (text.length > max) return { error: label + " is too long" };
  return { text };
}

function cleanDraft(body, sites, codeValue) {
  if (body.confirmationStatus != null && body.confirmationStatus !== "pending") {
    return { error: "Confirmation stays pending" };
  }
  if (body.codeType != null && body.codeType !== "code128") {
    return { error: "Only Code 128 artwork can be generated" };
  }
  const offer = cleanText(body.offer, 140, "Offer");
  if (offer.error) return offer;
  const conditions = cleanText(body.conditions, 2000, "Conditions");
  if (conditions.error) return conditions;
  if (!realDate(body.start) || !realDate(body.end)) return { error: "Dates must be YYYY-MM-DD" };
  if (body.start > body.end) return { error: "The start date must be on or before the end date" };
  if (body.posRedemption !== "single-use" && body.posRedemption !== "reusable") {
    return { error: "Choose single-use or reusable for the point-of-sale request" };
  }
  const coded = code128Values(codeValue);
  if (coded.error) return coded;
  return {
    draft: {
      offer: offer.text,
      conditions: conditions.text,
      start: body.start,
      end: body.end,
      siteIds: sites.siteIds,
      sites: sites.sites,
      posRedemption: body.posRedemption,
      codeType: "code128",
      codeValue,
      confirmationStatus: "pending",
      compatibility: "unconfirmed",
    },
  };
}

function codeKey(value) {
  return "code/" + crypto.createHash("sha256").update(value).digest("hex");
}

async function claimCode(store, value, id, previous) {
  if (previous === value) return {};
  const key = codeKey(value);
  const existing = await store.get(key, { type: "json" });
  if (existing && existing.id !== id) return { error: "That barcode value is already used" };
  if (!existing) {
    const gate = await store.setJSON(key, { id }, { onlyIfNew: true });
    if (gate?.modified !== true) {
      const again = await store.get(key, { type: "json" });
      if (again?.id !== id) return { error: "That barcode value is already used" };
    }
  }
  if (previous) await store.delete(codeKey(previous));
  return {};
}

function autoValue() {
  return "EH-POS-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

async function loadVisible(store, id, actor) {
  if (!/^p[a-f0-9]{8}$/.test(id)) return { error: json(404, { error: "Not found" }) };
  const draft = await store.get(id, { type: "json" });
  if (!draft || String(draft.id) !== id) return { error: json(404, { error: "Not found" }) };
  if (!canSeeDraft(actor, draft)) return { error: forbidden() };
  return { draft };
}

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const store = posDrafts();

  if (path === "/api/pos-drafts" && req.method === "GET") {
    const { blobs } = await store.list();
    const rows = (await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })))).filter((row) => row && row.codeValue && row.id && canSeeDraft(actor, row));
    return json(200, rows.sort((a, b) => String(b.created).localeCompare(String(a.created))));
  }

  if (path === "/api/pos-drafts" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const sites = await resolveSites(actor, body.siteIds || []);
    if (sites.error) return json(sites.status, { error: sites.error });
    let codeValue = String(body.codeValue || "").trim() || autoValue();
    const id = "p" + crypto.randomBytes(4).toString("hex");
    const built = cleanDraft(body, sites, codeValue);
    if (built.error) return json(400, { error: built.error });
    let claimed = await claimCode(store, codeValue, id);
    if (claimed.error && !body.codeValue) {
      codeValue = autoValue();
      const retry = cleanDraft(body, sites, codeValue);
      if (retry.error) return json(400, { error: retry.error });
      claimed = await claimCode(store, codeValue, id);
      built.draft.codeValue = codeValue;
    }
    if (claimed.error) return json(409, { error: claimed.error });
    const now = new Date().toISOString();
    const draft = { ...built.draft, id, created: now, updated: now, actorId: actor.id };
    await store.setJSON(id, draft);
    return json(201, draft);
  }

  const packed = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/package$/);
  if (packed && req.method === "GET") return sendPackage(store, packed[1], actor);
  const artwork = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/barcode\.svg$/);
  if (artwork && req.method === "GET") {
    const found = await loadVisible(store, artwork[1], actor);
    if (found.error) return found.error;
    const svg = code128Svg(found.draft.codeValue);
    if (svg.error) return json(400, { error: svg.error });
    return new Response(svg, { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
  }

  const one = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})$/);
  if (!one) return json(404, { error: "Not found" });
  const found = await loadVisible(store, one[1], actor);
  if (found.error) return found.error;
  if (req.method === "GET") return json(200, found.draft);
  if (req.method === "DELETE") {
    await store.delete(found.draft.id);
    await store.delete(codeKey(found.draft.codeValue));
    return json(200, { ok: true });
  }
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const sites = await resolveSites(actor, body.siteIds != null ? body.siteIds : found.draft.siteIds);
    if (sites.error) return json(sites.status, { error: sites.error });
    const codeValue = body.codeValue != null ? String(body.codeValue).trim() : found.draft.codeValue;
    const built = cleanDraft({ ...found.draft, ...body, codeValue }, sites, codeValue);
    if (built.error) return json(400, { error: built.error });
    const claimed = await claimCode(store, codeValue, found.draft.id, found.draft.codeValue);
    if (claimed.error) return json(409, { error: claimed.error });
    const draft = { ...found.draft, ...built.draft, id: found.draft.id, created: found.draft.created, updated: new Date().toISOString(), actorId: found.draft.actorId };
    await store.setJSON(draft.id, draft);
    return json(200, draft);
  }
  return json(405, { error: "Method not allowed" });
};

async function sendPackage(store, id, actor) {
  const found = await loadVisible(store, id, actor);
  if (found.error) return found.error;
  const packed = packageFiles(found.draft);
  if (packed.error) return json(400, { error: packed.error });
  const zip = zipStore(packed.files);
  return new Response(zip, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": "attachment; filename=\"" + safeDownloadName(id) + "\"",
      "cache-control": "no-store",
    },
  });
}

export const config = { path: ["/api/pos-drafts", "/api/pos-drafts/:id", "/api/pos-drafts/:id/package", "/api/pos-drafts/:id/barcode.svg"] };
