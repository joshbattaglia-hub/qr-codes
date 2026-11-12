import { footerHtml } from "../lib/footer.mjs";
import { json, posReviews } from "../lib/lib.mjs";
import { forbidden, originBlocked, unauthorised } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { approvalBanner } from "../lib/pos-package.mjs";
import { tokenHash } from "../lib/pos-approval.mjs";
import { decide, loadDraft } from "../lib/pos-workflow.mjs";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function readBody(req) {
  const text = await req.text();
  if (!text) return {};
  if ((req.headers.get("content-type") || "").includes("application/json") || text.trim().startsWith("{")) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function openReview(token) {
  if (!/^[a-f0-9]{64}$/.test(token)) return { status: 404 };
  const record = await posReviews().get("token/" + tokenHash(token), { type: "json" });
  if (!record?.draftId) return { status: 404 };
  const meta = await loadDraft(record.draftId);
  if (!meta || record.revision !== meta.data.revision || record.digest !== meta.data.materialDigest) return { status: 404 };
  if (Date.parse(record.expiresAt) <= Date.now()) return { status: 410 };
  return { record, meta };
}

function reviewPayload(found) {
  const draft = found.meta.data;
  return {
    published: false,
    banner: approvalBanner(draft),
    approverKey: found.record.approverKey,
    expiresAt: found.record.expiresAt,
    etag: found.meta.etag,
    offer: draft.offer,
    conditions: draft.conditions,
    start: draft.start,
    end: draft.end,
    sites: draft.sites || [],
    posRedemption: draft.posRedemption,
    distribution: draft.distribution,
    claimCap: draft.claimCap,
    approvalStatus: draft.approvalStatus,
    revision: draft.revision,
    digest: draft.materialDigest,
    confirmationStatus: "pending",
  };
}

function reviewHtml(token, found) {
  const view = reviewPayload(found);
  const action = "/api/pos-review/" + token + "/decision";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>POS review</title><body style="font-family:sans-serif;max-width:40rem;margin:24px auto;padding:0 16px">
<h1>${esc(view.offer)}</h1>
<p>${esc(view.banner)}</p>
<p>Neil or Joshua may approve. Opening this page does not approve or send anything.</p>
<p>Revision ${esc(view.revision)}. Expires ${esc(view.expiresAt)}. POS request: ${esc(view.posRedemption)}. Claim link: not published.</p>
<p>${esc(view.conditions)}</p>
<p>${esc(view.start)} through ${esc(view.end)}. Sites: ${esc((view.sites || []).map((site) => site.name).join(", ") || "Unassigned")}.</p>
<form method="post" action="${esc(action)}"><input type="hidden" name="decision" value="approve"><input type="hidden" name="etag" value="${esc(view.etag)}"><button type="submit">Approve this revision</button></form>
<form method="post" action="${esc(action)}"><input type="hidden" name="decision" value="reject"><input type="hidden" name="etag" value="${esc(view.etag)}"><button type="submit">Reject this revision</button></form>
${footerHtml()}
</body></html>`;
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const decision = path.match(/^\/api\/pos-review\/([a-f0-9]{64})\/decision$/);
  const review = path.match(/^\/api\/pos-review\/([a-f0-9]{64})$/);
  if (req.method === "GET" && review) {
    const found = await openReview(review[1]);
    if (found.status) return json(found.status, { error: found.status === 410 ? "This review link has expired" : "Not found" });
    if ((req.headers.get("accept") || "").includes("application/json")) return json(200, reviewPayload(found));
    return new Response(reviewHtml(review[1], found), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (req.method === "POST" && decision) {
    if (originBlocked(req)) return forbidden();
    const actor = await actorFromRequest(req);
    if (!actor) return unauthorised();
    if (actor.role === "building-maintenance") return forbidden();
    const found = await openReview(decision[1]);
    if (found.status) return json(found.status, { error: found.status === 410 ? "This review link has expired" : "Not found" });
    const body = await readBody(req);
    const result = await decide({
      actor,
      draft: found.meta.data,
      etag: body.etag || found.meta.etag,
      decision: body.decision,
      tokenRecord: found.record,
    });
    const payload = result.body || { error: result.error };
    if ((req.headers.get("accept") || "").includes("text/html")) {
      return new Response("<!doctype html><title>POS review</title><p>" + esc(payload.error || "Decision recorded. Nothing was published.") + "</p>" + footerHtml(), { status: result.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return json(result.status, payload);
  }
  return json(404, { error: "Not found" });
};

export const config = { path: ["/api/pos-review/:token", "/api/pos-review/:token/decision"] };
