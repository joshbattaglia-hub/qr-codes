import crypto from "node:crypto";
import { melbourneDate } from "./competitions.mjs";

export const QR_IP_CAP = 3;

export function voucherConfig(record) {
  const raw = record?.voucher || {};
  const maxIssues = Math.round(Number(raw.maxIssues));
  return {
    enabled: raw.enabled === true && Number.isInteger(maxIssues) && maxIssues >= 1,
    label: String(raw.label || "").slice(0, 80),
    terms: String(raw.terms || "").slice(0, 500),
    expires: typeof raw.expires === "string" ? raw.expires : "",
    maxIssues: Number.isInteger(maxIssues) && maxIssues > 0 ? maxIssues : 0,
  };
}

/** Enabling requires an offer, terms, a Melbourne expiry that is still current, and an issue cap. */
export function validateVoucher(body, today = melbourneDate()) {
  if (!body || body.voucher === undefined) return {};
  const v = body.voucher || {};
  const label = String(v.label || "").trim().slice(0, 80);
  const terms = String(v.terms || "").trim().slice(0, 500);
  const expires = typeof v.expires === "string" ? v.expires.trim() : "";
  const maxIssues = Math.round(Number(v.maxIssues));
  const enabled = v.enabled === true;
  if (!enabled) return { voucher: { enabled: false, label, terms, expires: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : "", maxIssues: 0 } };
  if (!label) return { error: "Enter the offer text before enabling a voucher" };
  if (!terms) return { error: "Enter the offer terms before enabling a voucher" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || expires < today) return { error: "Voucher expiry must be today or a future date" };
  if (!Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > 500) return { error: "Set how many vouchers can be issued, from 1 to 500" };
  return { voucher: { enabled: true, label, terms, expires, maxIssues } };
}

export function auditView(record) {
  if (!record) return null;
  return {
    id: record.id,
    competition: record.competition || "",
    siteId: record.siteId || "",
    source: record.source || "",
    sourceId: record.sourceId || "",
    status: record.status,
    issuedAt: record.issuedAt || null,
    redeemedAt: record.redeemedAt || null,
    expires: record.expires || "",
    disabled: !!record.disabled,
  };
}

/**
 * Issue at most one voucher for an idempotency key.
 * The token is stored only on the secret record and returned to this caller.
 */
export async function issueVoucher(store, { competition, siteId, source, sourceId, expires, label, parentType }) {
  const idem = `gate/${competition}/${source}/${sourceId}`;
  const existing = await store.get(idem, { type: "json", consistency: "strong" });
  if (existing?.token) return { created: false, token: existing.token, id: existing.id };
  const token = crypto.randomBytes(32).toString("hex");
  const id = "v" + crypto.randomBytes(6).toString("hex");
  const record = {
    id, token, competition, siteId: siteId || "", source, sourceId, parentType: parentType || source,
    status: "issued", issuedAt: new Date().toISOString(), redeemedAt: null,
    expires: expires || "", disabled: false, label: label || "",
  };
  const gate = await store.setJSON(idem, { id, token }, { onlyIfNew: true });
  if (!gate || gate.modified !== true) {
    const again = await store.get(idem, { type: "json", consistency: "strong" });
    if (again?.token) return { created: false, token: again.token, id: again.id };
    return { error: "Could not issue a voucher" };
  }
  const secret = await store.setJSON("token/" + token, record, { onlyIfNew: true });
  if (!secret || secret.modified !== true) return { error: "Could not issue a voucher" };
  await store.setJSON("audit/" + id, auditView(record));
  return { created: true, token, id };
}

/**
 * Single-use redemption. The token record is updated only with If-Match
 * (onlyIfMatch). A lost race returns modified:false and does not redeem.
 */
export async function redeemVoucher(store, token, { actorId = "" } = {}) {
  if (!token || typeof token !== "string" || token.length < 32) return { ok: false, error: "Invalid voucher" };
  const key = "token/" + token;
  if (typeof store.getWithMetadata !== "function" || typeof store.setJSON !== "function") {
    return { ok: false, error: "Redemption is unavailable" };
  }
  const meta = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!meta?.data) return { ok: false, error: "Invalid voucher" };
  if (!meta.etag) return { ok: false, error: "Redemption is unavailable" };
  const voucher = meta.data;
  if (voucher.disabled) return { ok: false, error: "This voucher is disabled" };
  if (voucher.expires && melbourneDate() > voucher.expires) return { ok: false, error: "This voucher has expired" };
  if (voucher.status !== "issued") return { ok: false, conflict: true, error: "Already redeemed" };
  const next = { ...voucher, status: "redeemed", redeemedAt: new Date().toISOString(), redeemedBy: actorId || "" };
  const write = await store.setJSON(key, next, { onlyIfMatch: meta.etag });
  if (!write || write.modified !== true) return { ok: false, conflict: true, error: "Already redeemed" };
  await store.setJSON("audit/" + voucher.id, auditView(next));
  return { ok: true, voucher: auditView(next) };
}
