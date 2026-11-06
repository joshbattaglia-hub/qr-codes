import crypto from "node:crypto";
import { json, posClaims, posDrafts } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { evaluateClaim } from "../lib/claim.mjs";
import { publicationAllowed, sameToken, tokenHash } from "../lib/pos-approval.mjs";

export default async (req) => {
  const token = (new URL(req.url).pathname.match(/^\/api\/claim\/([a-f0-9]{64})$/) || [])[1] || "";
  if (!token) return json(404, { error: "Not found" });
  const pointer = await posDrafts().get("claim/" + tokenHash(token), { type: "json" });
  const draft = pointer?.id ? await posDrafts().get(pointer.id, { type: "json" }) : null;
  if (!draft || !sameToken(draft.claimToken, token) || !publicationAllowed(draft)) return json(404, { error: "Not found" });
  if (req.method === "GET") {
    return json(200, { offer: draft.offer, start: draft.start, end: draft.end, sites: (draft.sites || []).map((site) => ({ id: site.id, name: site.name })), posRedemption: draft.posRedemption });
  }
  if (req.method !== "POST") return json(404, { error: "Not found" });
  if (originBlocked(req)) return forbidden();
  const body = await req.json().catch(() => ({}));
  const ipHash = crypto.createHash("sha256").update("claim-ip\n" + (req.headers.get("x-forwarded-for") || "local")).digest("hex").slice(0, 16);
  const result = await evaluateClaim(posClaims(), draft, {
    reference: body.reference,
    idempotencyKey: body.idempotencyKey,
    siteId: body.siteId,
    ipHash,
  });
  return json(result.status, result.claim ? { claim: result.claim, replay: !!result.replay } : { error: result.error });
};

export const config = { path: "/api/claim/:token" };
