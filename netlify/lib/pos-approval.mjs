import crypto from "node:crypto";

/** Configuration facts. An email here is not a login and does not grant a role. */
export const APPROVER_FACTS = {
  neil: { key: "neil", name: "Neil", email: "nanderson@libertyretail.com.au" },
  joshua: { key: "joshua", name: "Joshua", email: "jbattaglia@libertyretail.com.au" },
};

export const PREPARER_CLASSES = ["regional-business-manager", "jeremy", "joshua"];
export const QUICKFUEL_RECIPIENT = "support@quickfuel.com.au";
export const REVIEW_TTL_MS = 48 * 60 * 60 * 1000;

export function materialView(draft) {
  return {
    offer: draft.offer || "",
    conditions: draft.conditions || "",
    start: draft.start || "",
    end: draft.end || "",
    siteIds: [...(draft.siteIds || [])].map(String).sort(),
    posRedemption: draft.posRedemption || "",
    codeType: draft.codeType || "",
    codeValue: draft.codeValue || "",
    distribution: draft.distribution || "",
    claimCap: Number(draft.claimCap) || 0,
  };
}

export function materialDigest(draft) {
  return crypto.createHash("sha256").update(JSON.stringify(materialView(draft))).digest("hex");
}

export function approvalCurrent(draft) {
  const approval = draft?.approval;
  return !!(
    draft?.approvalStatus === "approved" &&
    approval &&
    approval.revision === draft.revision &&
    approval.digest === draft.materialDigest &&
    (approval.approverKey === "neil" || approval.approverKey === "joshua") &&
    typeof approval.identityId === "string" &&
    approval.identityId
  );
}

export function publicationAllowed(draft) {
  if (!approvalCurrent(draft)) return false;
  if (draft.distribution !== "shareable-claim-link") return false;
  if (draft.confirmationStatus !== "confirmed") return false;
  const evidence = draft.confirmationEvidence;
  if (!evidence || evidence.kind !== "recorded" || typeof evidence.reference !== "string" || evidence.reference.trim().length < 8) return false;
  if (draft.activation !== "active" || draft.activationAuthority !== "recorded") return false;
  if (!draft.offer || !draft.conditions || !draft.start || !draft.end) return false;
  if (!Array.isArray(draft.siteIds) || !draft.siteIds.length) return false;
  if (!Number.isInteger(draft.claimCap) || draft.claimCap < 1) return false;
  if (typeof draft.claimToken !== "string" || !/^[a-f0-9]{64}$/.test(draft.claimToken)) return false;
  return true;
}

export function publicDraft(draft, etag) {
  if (!draft) return null;
  const copy = { ...draft };
  delete copy.claimToken;
  delete copy.reviewHashes;
  if (etag) copy.etag = etag;
  copy.approvalCurrent = approvalCurrent(draft);
  copy.claimPublished = false;
  return copy;
}

export function pushHistory(draft, event) {
  const history = Array.isArray(draft.history) ? draft.history.slice(-29) : [];
  history.push({
    at: new Date().toISOString(),
    action: event.action,
    identityId: event.identityId || "",
    role: event.role || "",
    approverKey: event.approverKey || "",
    revision: draft.revision,
    digest: draft.materialDigest,
  });
  draft.history = history;
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function sameToken(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
