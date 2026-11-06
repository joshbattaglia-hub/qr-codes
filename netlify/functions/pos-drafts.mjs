import crypto from "node:crypto";
import { json, posDrafts, sitesStore } from "../lib/lib.mjs";
import { forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { code128Svg, code128Values } from "../lib/code128.mjs";
import { packageFiles, safeDownloadName, zipStore } from "../lib/pos-package.mjs";
import { approvalCurrent, materialDigest, publicDraft, tokenHash } from "../lib/pos-approval.mjs";
import { canSeeDraft, decide, invalidateReviews, loadDraft, requestApproval, sendQuickfuel, supersedeMail } from "../lib/pos-workflow.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(value) {
  const text = String(value ?? "");
  if (!DATE.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
    if (actor.role !== "head" && !(Array.isArray(actor.siteIds) && actor.siteIds.includes(id))) return { error: "Forbidden", status: 403 };
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

function cleanContent(body, sites, codeValue) {
  if (body.confirmationStatus != null && body.confirmationStatus !== "pending") return { error: "Confirmation stays pending" };
  if (body.activation != null || body.confirmationEvidence != null || body.activationAuthority != null) return { error: "Activation is not available" };
  if (body.codeType != null && body.codeType !== "code128") return { error: "Only Code 128 artwork can be generated" };
  const distribution = body.distribution == null ? "shareable-claim-link" : body.distribution;
  if (distribution !== "shareable-claim-link") return { error: "The distribution mode is a shareable claim link" };
  const claimCap = body.claimCap == null ? 100 : Math.round(Number(body.claimCap));
  if (!Number.isInteger(claimCap) || claimCap < 1 || claimCap > 5000) return { error: "Claim cap must be from 1 to 5000" };
  const offer = cleanText(body.offer, 140, "Offer");
  if (offer.error) return offer;
  const conditions = cleanText(body.conditions, 2000, "Conditions");
  if (conditions.error) return conditions;
  if (!realDate(body.start) || !realDate(body.end)) return { error: "Dates must be YYYY-MM-DD" };
  if (body.start > body.end) return { error: "The start date must be on or before the end date" };
  if (body.posRedemption !== "single-use" && body.posRedemption !== "reusable") return { error: "Choose single-use or reusable for the point-of-sale request" };
  const coded = code128Values(codeValue);
  if (coded.error) return coded;
  return {
    content: {
      offer: offer.text,
      conditions: conditions.text,
      start: body.start,
      end: body.end,
      siteIds: sites.siteIds,
      sites: sites.sites,
      posRedemption: body.posRedemption,
      codeType: "code128",
      codeValue,
      distribution,
      claimCap,
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

function canEdit(actor, draft) {
  if (!canSeeDraft(actor, draft)) return false;
  return actor.role === "head" || actor.role === "manager" || actor.role === "preparer";
}

function workflowResult(result) {
  if (result.body) return json(result.status, result.body.error ? result.body : result.body);
  return json(result.status, { error: result.error });
}

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const actor = await actorFromRequest(req);
  if (!actor) return unauthorised();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const store = posDrafts();

  if (path === "/api/pos-drafts" && req.method === "GET") {
    const { blobs } = await store.list();
    const rows = (await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })))).filter((row) => row && row.codeValue && row.id && canSeeDraft(actor, row));
    return json(200, rows.map((row) => publicDraft(row)));
  }

  if (path === "/api/pos-drafts" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const sites = await resolveSites(actor, body.siteIds || []);
    if (sites.error) return json(sites.status, { error: sites.error });
    if (!canEdit(actor, { siteIds: sites.siteIds })) return forbidden();
    let codeValue = String(body.codeValue || "").trim() || autoValue();
    const id = "p" + crypto.randomBytes(4).toString("hex");
    const built = cleanContent(body, sites, codeValue);
    if (built.error) return json(400, { error: built.error });
    let claimed = await claimCode(store, codeValue, id);
    if (claimed.error && !body.codeValue) {
      codeValue = autoValue();
      const retry = cleanContent(body, sites, codeValue);
      if (retry.error) return json(400, { error: retry.error });
      claimed = await claimCode(store, codeValue, id);
      built.content = retry.content;
    }
    if (claimed.error) return json(409, { error: claimed.error });
    const claimToken = crypto.randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const draft = {
      ...built.content,
      id,
      claimToken,
      approvalStatus: "draft",
      approval: null,
      revision: 1,
      reviewHashes: [],
      history: [],
      created: now,
      updated: now,
      actorId: actor.id,
    };
    draft.materialDigest = materialDigest(draft);
    const written = await store.setJSON(id, draft);
    await store.setJSON("claim/" + tokenHash(claimToken), { id }, { onlyIfNew: true });
    return json(201, publicDraft(draft, written?.etag));
  }

  const approval = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/approval-request$/);
  if (approval && req.method === "POST") return act(req, approval[1], actor, (meta, body) => requestApproval({ actor, draft: meta.data, etag: body.etag || req.headers.get("if-match") || "", approverKey: body.approverKey }));
  const decision = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/decision$/);
  if (decision && req.method === "POST") return act(req, decision[1], actor, (meta, body) => decide({ actor, draft: meta.data, etag: body.etag || req.headers.get("if-match") || "", decision: body.decision }));
  const fuel = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/send-quickfuel$/);
  if (fuel && req.method === "POST") return act(req, fuel[1], actor, (meta, body) => sendQuickfuel({ actor, draft: meta.data, etag: body.etag || req.headers.get("if-match") || "", confirm: body.confirm === true, recipient: body.recipient }));

  const packed = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/(package|final-package)$/);
  if (packed && req.method === "GET") return sendPackage(packed[1], actor, packed[2] === "final-package");
  const artwork = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/barcode\.svg$/);
  if (artwork && req.method === "GET") {
    const meta = await visible(artwork[1], actor);
    if (meta.error) return meta.error;
    const svg = code128Svg(meta.data.codeValue);
    if (svg.error) return json(400, { error: svg.error });
    return new Response(svg, { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
  }
  const preview = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})\/claim-preview$/);
  if (preview && req.method === "GET") {
    const meta = await visible(preview[1], actor);
    if (meta.error) return meta.error;
    return json(200, {
      published: false,
      banner: "Draft preview. The claim link is not published.",
      offer: meta.data.offer,
      conditions: meta.data.conditions,
      start: meta.data.start,
      end: meta.data.end,
      sites: meta.data.sites || [],
      posRedemption: meta.data.posRedemption,
      distribution: meta.data.distribution,
      claimCap: meta.data.claimCap,
      approvalStatus: meta.data.approvalStatus,
      confirmationStatus: "pending",
    });
  }

  const one = path.match(/^\/api\/pos-drafts\/(p[a-f0-9]{8})$/);
  if (!one) return json(404, { error: "Not found" });
  const meta = await visible(one[1], actor);
  if (meta.error) return meta.error;
  if (req.method === "GET") return json(200, publicDraft(meta.data, meta.etag));
  if (req.method === "DELETE") {
    if (!canEdit(actor, meta.data)) return forbidden();
    await invalidateReviews(meta.data);
    await store.delete(meta.data.id);
    await store.delete(codeKey(meta.data.codeValue));
    return json(200, { ok: true });
  }
  if (req.method === "PATCH") {
    if (!canEdit(actor, meta.data)) return forbidden();
    const body = await req.json().catch(() => ({}));
    const sites = await resolveSites(actor, body.siteIds != null ? body.siteIds : meta.data.siteIds);
    if (sites.error) return json(sites.status, { error: sites.error });
    const codeValue = body.codeValue != null ? String(body.codeValue).trim() : meta.data.codeValue;
    const built = cleanContent({ ...meta.data, ...body, codeValue }, sites, codeValue);
    if (built.error) return json(400, { error: built.error });
    const etag = body.etag || req.headers.get("if-match") || "";
    if (!etag || etag !== meta.etag) return json(409, { error: "The draft changed" });
    const claimed = await claimCode(store, codeValue, meta.data.id, meta.data.codeValue);
    if (claimed.error) return json(409, { error: claimed.error });
    const next = { ...meta.data, ...built.content, id: meta.data.id, claimToken: meta.data.claimToken, created: meta.data.created, actorId: meta.data.actorId, updated: new Date().toISOString() };
    const digest = materialDigest(next);
    if (digest !== meta.data.materialDigest) {
      next.revision = (meta.data.revision || 1) + 1;
      next.materialDigest = digest;
      next.approvalStatus = "draft";
      next.approval = null;
      next.reviewHashes = [];
      next.selectedApprover = "";
    }
    delete next.confirmationEvidence;
    delete next.activation;
    delete next.activationAuthority;
    next.confirmationStatus = "pending";
    const write = await store.setJSON(next.id, next, { onlyIfMatch: meta.etag });
    if (write?.modified !== true) return json(409, { error: "The draft changed" });
    if (digest !== meta.data.materialDigest) {
      await invalidateReviews(meta.data);
      await supersedeMail(next.id);
    }
    return json(200, publicDraft(next, write.etag));
  }
  return json(405, { error: "Method not allowed" });
};

async function visible(id, actor) {
  const meta = await loadDraft(id);
  if (!meta) return { error: json(404, { error: "Not found" }) };
  if (!canSeeDraft(actor, meta.data)) return { error: forbidden() };
  return meta;
}

async function act(req, id, actor, run) {
  const meta = await visible(id, actor);
  if (meta.error) return meta.error;
  const body = await req.json().catch(() => ({}));
  return workflowResult(await run(meta, body));
}

async function sendPackage(id, actor, finalPackage) {
  const meta = await visible(id, actor);
  if (meta.error) return meta.error;
  if (finalPackage && !approvalCurrent(meta.data)) return json(403, { error: "A final package needs the current approved revision" });
  const packed = packageFiles(meta.data);
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

export const config = {
  path: ["/api/pos-drafts", "/api/pos-drafts/:id", "/api/pos-drafts/:id/package", "/api/pos-drafts/:id/final-package", "/api/pos-drafts/:id/barcode.svg", "/api/pos-drafts/:id/claim-preview", "/api/pos-drafts/:id/approval-request", "/api/pos-drafts/:id/decision", "/api/pos-drafts/:id/send-quickfuel"],
};
