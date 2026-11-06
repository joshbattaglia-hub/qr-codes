import crypto from "node:crypto";
import { conditionalIncrement } from "./lib.mjs";
import { melbourneDate } from "./competitions.mjs";
import { publicationAllowed } from "./pos-approval.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export async function evaluateClaim(store, draft, { reference, idempotencyKey, siteId, ipHash, now = new Date() } = {}) {
  if (!publicationAllowed(draft)) return { status: 404, error: "Not found" };
  const today = melbourneDate(now);
  if (today < draft.start || today > draft.end) return { status: 400, error: "Outside the validity dates" };
  if (!siteId || !draft.siteIds.includes(siteId)) return { status: 403, error: "Not eligible at this site" };
  const key = String(idempotencyKey || "");
  if (key.length < 8 || key.length > 80) return { status: 400, error: "Idempotency key is required" };
  const person = hash("claim-person\n" + String(reference || ""));
  if (!reference || String(reference).length < 3) return { status: 400, error: "A claim reference is required" };
  const rate = await conditionalIncrement(store, `rate/${draft.id}/${Math.floor(now.getTime() / 60000)}/${ipHash || "none"}`, 8);
  if (!rate.ok) return { status: rate.reason === "limit" ? 429 : 503, error: "Claim is unavailable" };
  const idemKey = `idem/${draft.id}/${hash(key)}`;
  const existing = await store.get(idemKey, { type: "json" });
  if (existing?.id) return { status: 200, claim: publicClaim(existing), replay: true };
  if (draft.posRedemption === "single-use") {
    const gate = await store.setJSON(`person/${draft.id}/${person}`, { at: now.toISOString() }, { onlyIfNew: true });
    if (gate?.modified !== true) return { status: 409, error: "Already claimed" };
  }
  const cap = await conditionalIncrement(store, `cap/${draft.id}`, draft.claimCap);
  if (!cap.ok) return { status: cap.reason === "limit" ? 409 : 503, error: cap.reason === "limit" ? "Claim cap reached" : "Claim is unavailable" };
  const claim = {
    id: "k" + crypto.randomBytes(8).toString("hex"),
    draftId: draft.id,
    revision: draft.revision,
    siteId,
    posRedemption: draft.posRedemption,
    at: now.toISOString(),
  };
  const write = await store.setJSON(idemKey, claim, { onlyIfNew: true });
  if (write?.modified !== true) {
    const again = await store.get(idemKey, { type: "json" });
    if (again?.id) return { status: 200, claim: publicClaim(again), replay: true };
    return { status: 503, error: "Claim is unavailable" };
  }
  return { status: 201, claim: publicClaim(claim) };
}

function publicClaim(claim) {
  return { id: claim.id, draftId: claim.draftId, revision: claim.revision, siteId: claim.siteId, posRedemption: claim.posRedemption, at: claim.at };
}
