import crypto from "node:crypto";
import { identities, posDrafts, posMail, posReviews, publicBase } from "./lib.mjs";
import { deliver, mailConfigured, mailSetupMessage } from "./mail.mjs";
import { packageFiles, safeDownloadName, zipStore } from "./pos-package.mjs";
import {
  APPROVER_FACTS, QUICKFUEL_RECIPIENT, REVIEW_TTL_MS, approvalCurrent, publicDraft, pushHistory, tokenHash,
} from "./pos-approval.mjs";

export function canSeeDraft(actor, draft) {
  if (!actor) return false;
  if (actor.role === "head") return true;
  const ids = draft?.siteIds || [];
  if (!ids.length) return actor.unassigned === true;
  return ids.every((id) => Array.isArray(actor.siteIds) && actor.siteIds.includes(id));
}

export async function loadDraft(id) {
  if (!/^p[a-f0-9]{8}$/.test(id)) return null;
  const meta = await posDrafts().getWithMetadata(id, { type: "json", consistency: "strong" });
  if (!meta?.data || meta.data.id !== id || !meta.etag) return null;
  return meta;
}

export async function invalidateReviews(draft) {
  for (const hash of draft?.reviewHashes || []) await posReviews().delete("token/" + hash);
}

async function clearApprovalMail(draftId, revision) {
  const store = posMail();
  const { blobs } = await store.list();
  for (const blob of blobs) {
    if (!blob.key.startsWith("m")) continue;
    const row = await store.get(blob.key, { type: "json" });
    if (!row || row.kind !== "approval-request" || row.draftId !== draftId || row.revision !== revision) continue;
    await store.delete(blob.key);
    await store.delete("idem/" + row.idempotencyKey);
  }
}

export async function supersedeMail(draftId) {
  const store = posMail();
  const { blobs } = await store.list();
  for (const blob of blobs) {
    if (!blob.key.startsWith("m")) continue;
    const meta = await store.getWithMetadata(blob.key, { type: "json" });
    const row = meta?.data;
    if (!row || row.draftId !== draftId || row.status === "sent" || row.status === "superseded" || !meta.etag) continue;
    await store.setJSON(blob.key, { ...row, status: "superseded", updated: new Date().toISOString() }, { onlyIfMatch: meta.etag });
  }
}

async function putOutbox(record) {
  const store = posMail();
  const idemKey = "idem/" + record.idempotencyKey;
  const existing = await store.get(idemKey, { type: "json" });
  if (existing?.id) return { duplicate: true, row: await store.get(existing.id, { type: "json" }) };
  const gate = await store.setJSON(idemKey, { id: record.id }, { onlyIfNew: true });
  if (gate?.modified !== true) {
    const again = await store.get(idemKey, { type: "json" });
    return { duplicate: true, row: again?.id ? await store.get(again.id, { type: "json" }) : null };
  }
  await store.setJSON(record.id, { ...record, created: new Date().toISOString() });
  return { duplicate: false, row: record };
}

async function finishOutbox(id, status, extra = {}) {
  const meta = await posMail().getWithMetadata(id, { type: "json" });
  if (!meta?.etag) return null;
  const next = { ...meta.data, ...extra, status, updated: new Date().toISOString() };
  const write = await posMail().setJSON(id, next, { onlyIfMatch: meta.etag });
  return write?.modified === true ? next : meta.data;
}

function outcome(row) {
  const status = row?.status || "unknown";
  return {
    sent: status === "sent",
    status,
    error: status === "sent" ? undefined : status === "unknown"
      ? "The email outcome is unknown. It was not marked sent and will not be retried."
      : status === "not-configured" ? mailSetupMessage() : "The email was not sent.",
  };
}

async function deliverApproval({ draft, actor, approverKey, hash, token, expiresAt }) {
  const fact = APPROVER_FACTS[approverKey];
  const idempotencyKey = `approval/${draft.id}/${draft.revision}/${approverKey}`;
  const existing = await posMail().get("idem/" + idempotencyKey, { type: "json" });
  if (existing?.id) {
    const row = await posMail().get(existing.id, { type: "json" });
    return { approverKey, to: fact.email, ...outcome(row) };
  }
  const outbox = {
    id: "m" + crypto.randomBytes(8).toString("hex"),
    kind: "approval-request",
    draftId: draft.id,
    revision: draft.revision,
    digest: draft.materialDigest,
    idempotencyKey,
    approverKey,
    status: "pending",
    to: fact.email,
  };
  const claimed = await putOutbox(outbox);
  if (claimed.duplicate) return { approverKey, to: fact.email, ...outcome(claimed.row) };
  await posReviews().setJSON("token/" + hash, { draftId: draft.id, revision: draft.revision, digest: draft.materialDigest, approverKey, expiresAt });
  const link = publicBase() + "/api/pos-review/" + token;
  const result = await deliver({
    to: fact.email,
    subject: "POS approval request, revision " + draft.revision,
    idempotencyKey,
    text: [
      "This link is only for " + fact.name + ".",
      "Either Neil or Joshua may approve. Both receive a link. One approval is enough.",
      "Opening this message does not approve the request.",
      "Review link: " + link,
      "The link is a GET review. It cannot approve or send.",
      "Expires: " + expiresAt,
      "Offer: " + draft.offer,
      "Revision: " + draft.revision,
      "Sign in as " + fact.name + " and submit the decision. The link is not an identity.",
      "Quickfuel has not confirmed support. The offer is not activated.",
    ].join("\n"),
  });
  const status = result.status === "sent" ? "sent" : result.status === "unknown" ? "unknown" : "not-sent";
  if (status === "not-sent") await posReviews().delete("token/" + hash);
  await finishOutbox(outbox.id, status, { providerId: result.id || "" });
  return { approverKey, to: fact.email, sent: status === "sent", status, mock: !!result.mock, actorId: actor.id };
}

export async function requestApproval({ actor, draft, etag }) {
  if (actor?.kind !== "verified-identity" || actor.role !== "preparer") {
    return { status: 403, error: "A verified preparer identity has to request approval. The shared head-office password cannot." };
  }
  if (!canSeeDraft(actor, draft)) return { status: 403, error: "Forbidden" };
  if (approvalCurrent(draft)) return { status: 409, error: "This revision is already approved" };
  if (!mailConfigured()) return { status: 409, body: { sent: false, status: "not-configured", recipients: [], error: mailSetupMessage() } };
  const meta = await posDrafts().getWithMetadata(draft.id, { type: "json" });
  if (!meta?.etag || meta.etag !== etag || meta.data.revision !== draft.revision || meta.data.materialDigest !== draft.materialDigest) {
    return { status: 409, body: { sent: false, status: "not-sent", error: "The draft changed" } };
  }
  const expiresAt = new Date(Date.now() + REVIEW_TTL_MS).toISOString();
  const prepared = Object.keys(APPROVER_FACTS).map((approverKey) => {
    const token = crypto.randomBytes(32).toString("hex");
    return { approverKey, token, hash: tokenHash(token) };
  });
  const next = { ...meta.data, approvalStatus: "pending", selectedApprover: "", requestedBy: actor.id, reviewHashes: prepared.map((item) => item.hash), approval: null };
  pushHistory(next, { action: "approval-requested", identityId: actor.id, role: "preparer", approverKey: "both" });
  const write = await posDrafts().setJSON(draft.id, next, { onlyIfMatch: meta.etag });
  if (write?.modified !== true) return { status: 409, error: "The draft changed" };
  const recipients = [];
  for (const item of prepared) recipients.push(await deliverApproval({ draft, actor, expiresAt, ...item }));
  const sentCount = recipients.filter((item) => item.sent).length;
  if (!sentCount && recipients.every((item) => item.status !== "unknown")) {
    const back = await posDrafts().getWithMetadata(draft.id, { type: "json" });
    if (back?.etag && back.data.approvalStatus === "pending" && !back.data.approval && back.data.revision === draft.revision) {
      const restored = { ...back.data, approvalStatus: draft.approvalStatus || "draft", selectedApprover: "", requestedBy: "", reviewHashes: [] };
      pushHistory(restored, { action: "approval-request-failed", identityId: actor.id, role: "preparer", approverKey: "both" });
      await posDrafts().setJSON(draft.id, restored, { onlyIfMatch: back.etag });
    }
  }
  const status = sentCount === recipients.length ? "sent" : recipients.some((item) => item.status === "unknown") ? "unknown" : sentCount ? "partial" : "not-sent";
  return {
    status: status === "sent" ? 200 : 409,
    body: {
      sent: status === "sent",
      status,
      mock: recipients.some((item) => item.mock),
      recipients: recipients.map((item) => ({ approverKey: item.approverKey, to: item.to, sent: !!item.sent, status: item.status })),
      draft: status === "sent" || sentCount || recipients.some((item) => item.status === "unknown") ? publicDraft(next, write.etag) : undefined,
      error: status === "sent" ? undefined : status === "unknown" ? "The email outcome is unknown for at least one approver. It was not marked sent and will not be retried." : "The approval request was not sent to both approvers.",
    },
  };
}

async function sendConfirmation(draft) {
  const person = draft.requestedBy ? await identities().get(draft.requestedBy, { type: "json" }) : null;
  const to = person?.contactEmail || "";
  const idempotencyKey = `confirm/${draft.id}/${draft.revision}/${draft.approval.identityId}`;
  if (!to || !mailConfigured()) {
    const status = !to ? "not-sent" : "not-configured";
    const outbox = {
      id: "m" + crypto.randomBytes(8).toString("hex"),
      kind: "requester-confirmation",
      draftId: draft.id,
      revision: draft.revision,
      digest: draft.materialDigest,
      idempotencyKey,
      status,
      to: "",
    };
    const claimed = await putOutbox(outbox);
    if (!claimed.duplicate) await finishOutbox(outbox.id, status, { reason: to ? mailSetupMessage() : "Requester address is not on the verified identity" });
    return outcome(claimed.duplicate ? claimed.row : { status });
  }
  const outbox = {
    id: "m" + crypto.randomBytes(8).toString("hex"),
    kind: "requester-confirmation",
    draftId: draft.id,
    revision: draft.revision,
    digest: draft.materialDigest,
    idempotencyKey,
    status: "pending",
    to,
  };
  const claimed = await putOutbox(outbox);
  if (claimed.duplicate) return outcome(claimed.row);
  const current = await posDrafts().get(draft.id, { type: "json" });
  if (!approvalCurrent(current) || current.revision !== draft.revision) {
    await finishOutbox(outbox.id, "superseded");
    return outcome({ status: "superseded" });
  }
  const who = APPROVER_FACTS[draft.approval.approverKey]?.name || "The approver";
  const result = await deliver({
    to,
    subject: "POS request approved, revision " + draft.revision,
    idempotencyKey,
    text: [
      who + " approved revision " + draft.revision + " of " + draft.offer + ".",
      "Open the same saved request: " + publicBase() + "/admin#/pos/" + draft.id,
      "The Quickfuel send box is on that screen only because this revision is approved.",
      "Approval does not forward the package and does not activate the offer.",
      "Quickfuel POS support is still unconfirmed. The claim link is not published.",
    ].join("\n"),
  });
  const status = result.status === "sent" ? "sent" : result.status === "unknown" ? "unknown" : "not-sent";
  await finishOutbox(outbox.id, status, { providerId: result.id || "" });
  return { ...outcome({ status }), mock: !!result.mock };
}

export async function decide({ actor, draft, etag, decision, tokenRecord }) {
  if (actor?.kind !== "verified-identity" || actor.role !== "approver") {
    return { status: 403, error: "A verified approver identity is required. Email and the shared password do not approve." };
  }
  if (!canSeeDraft(actor, draft)) return { status: 403, error: "Forbidden" };
  const approverKey = tokenRecord?.approverKey || actor.approverKey;
  if (!APPROVER_FACTS[approverKey] || actor.approverKey !== approverKey) {
    return { status: 403, error: "This request is for a different approver" };
  }
  if (tokenRecord) {
    if (Date.parse(tokenRecord.expiresAt) <= Date.now()) return { status: 410, error: "This review link has expired" };
    if (tokenRecord.revision !== draft.revision || tokenRecord.digest !== draft.materialDigest || tokenRecord.draftId !== draft.id) {
      return { status: 409, error: "This link is for an older revision" };
    }
  }
  if (decision !== "approve" && decision !== "reject") return { status: 400, error: "Choose approve or reject" };
  if (draft.approvalStatus !== "pending") return { status: 409, error: "This revision is not waiting for approval" };
  const meta = await posDrafts().getWithMetadata(draft.id, { type: "json" });
  if (!meta?.etag || meta.etag !== etag || meta.data.revision !== draft.revision || meta.data.materialDigest !== draft.materialDigest || meta.data.approvalStatus !== "pending") {
    return { status: 409, error: "The draft changed" };
  }
  const next = { ...meta.data };
  if (decision === "reject") {
    next.approvalStatus = "rejected";
    next.approval = null;
    next.reviewHashes = [];
    pushHistory(next, { action: "rejected", identityId: actor.id, role: "approver", approverKey: actor.approverKey });
  } else {
    next.approvalStatus = "approved";
    next.approval = {
      identityId: actor.id,
      approverKey: actor.approverKey,
      at: new Date().toISOString(),
      revision: next.revision,
      digest: next.materialDigest,
    };
    pushHistory(next, { action: "approved", identityId: actor.id, role: "approver", approverKey: actor.approverKey });
  }
  const write = await posDrafts().setJSON(draft.id, next, { onlyIfMatch: meta.etag });
  if (write?.modified !== true) return { status: 409, error: "The draft changed" };
  if (decision === "reject") {
    await invalidateReviews(meta.data);
    await clearApprovalMail(draft.id, draft.revision);
    return { status: 200, body: { draft: publicDraft(next, write.etag), confirmation: { sent: false, status: "not-sent" } } };
  }
  const confirmation = await sendConfirmation(next);
  return { status: 200, body: { draft: publicDraft(next, write.etag), confirmation, mock: !!confirmation.mock } };
}

export async function sendQuickfuel({ actor, draft, etag, confirm, recipient }) {
  if (actor?.kind !== "verified-identity" || actor.role !== "preparer" || actor.id !== draft.requestedBy) {
    return { status: 403, error: "The requester has to send this from the POS setup screen." };
  }
  if (!canSeeDraft(actor, draft)) return { status: 403, error: "Forbidden" };
  if (confirm !== true) return { status: 400, error: "Confirm the send on the POS setup screen" };
  if (recipient != null && recipient !== QUICKFUEL_RECIPIENT) return { status: 400, error: "The recipient is fixed" };
  if (!approvalCurrent(draft)) return { status: 403, error: "This revision is not approved" };
  const idempotencyKey = `quickfuel/${draft.id}/${draft.revision}`;
  const existing = await posMail().get("idem/" + idempotencyKey, { type: "json" });
  if (existing?.id) {
    const row = await posMail().get(existing.id, { type: "json" });
    return { status: row?.status === "sent" ? 200 : 409, body: { ...outcome(row), recipient: QUICKFUEL_RECIPIENT } };
  }
  if (!mailConfigured()) return { status: 409, body: { sent: false, status: "not-configured", recipient: QUICKFUEL_RECIPIENT, error: mailSetupMessage() } };
  const meta = await posDrafts().getWithMetadata(draft.id, { type: "json" });
  if (!meta?.etag || meta.etag !== etag || !approvalCurrent(meta.data) || meta.data.revision !== draft.revision) {
    return { status: 409, error: "The approved revision changed" };
  }
  const packed = packageFiles(meta.data);
  if (packed.error) return { status: 400, error: packed.error };
  const zip = zipStore(packed.files);
  const outbox = {
    id: "m" + crypto.randomBytes(8).toString("hex"),
    kind: "quickfuel-send",
    draftId: draft.id,
    revision: draft.revision,
    digest: draft.materialDigest,
    idempotencyKey,
    status: "pending",
    to: QUICKFUEL_RECIPIENT,
  };
  const claimed = await putOutbox(outbox);
  if (claimed.duplicate) return { status: claimed.row?.status === "sent" ? 200 : 409, body: { ...outcome(claimed.row), recipient: QUICKFUEL_RECIPIENT } };
  const current = await posDrafts().get(draft.id, { type: "json" });
  if (!approvalCurrent(current) || current.revision !== draft.revision || current.materialDigest !== draft.materialDigest) {
    await finishOutbox(outbox.id, "superseded");
    return { status: 409, error: "The approved revision changed" };
  }
  const result = await deliver({
    to: QUICKFUEL_RECIPIENT,
    subject: "POS setup package, revision " + draft.revision,
    idempotencyKey,
    text: [
      "Internally approved POS setup. Quickfuel barcode requirements are still unconfirmed.",
      "Offer: " + current.offer,
      "Revision: " + current.revision,
      "POS redemption requested: " + current.posRedemption + ". A static barcode does not enforce single use.",
      "The claim link is not published and the offer is not activated.",
      "Attachment: " + safeDownloadName(current.id),
    ].join("\n"),
    attachments: [{ filename: safeDownloadName(current.id), content: zip.toString("base64") }],
  });
  const status = result.status === "sent" ? "sent" : result.status === "unknown" ? "unknown" : "not-sent";
  await finishOutbox(outbox.id, status, { providerId: result.id || "" });
  if (status === "sent") {
    const fresh = await posDrafts().getWithMetadata(draft.id, { type: "json" });
    if (fresh?.etag && approvalCurrent(fresh.data) && fresh.data.revision === draft.revision) {
      const next = { ...fresh.data };
      pushHistory(next, { action: "quickfuel-sent", identityId: actor.id, role: "preparer", approverKey: "" });
      await posDrafts().setJSON(draft.id, next, { onlyIfMatch: fresh.etag });
    }
  }
  const body = { ...outcome({ status }), recipient: QUICKFUEL_RECIPIENT, attachment: safeDownloadName(draft.id), mock: !!result.mock };
  return { status: status === "sent" ? 200 : 409, body };
}
