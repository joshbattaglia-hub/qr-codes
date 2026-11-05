import crypto from "node:crypto";
import { melbourneDate } from "./competitions.mjs";

export function voucherConfig(comp) {
  const raw = comp?.voucher || {};
  return {
    enabled: raw.enabled === true,
    label: String(raw.label || "").slice(0, 80),
    terms: String(raw.terms || "").slice(0, 500),
    expires: typeof raw.expires === "string" ? raw.expires : "",
  };
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
  const existing = await store.get(idem, { type: "json" });
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
    const again = await store.get(idem, { type: "json" });
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
  const meta = await store.getWithMetadata(key, { type: "json" });
  if (!meta?.data) return { ok: false, error: "Invalid voucher" };
  if (!meta.etag) return { ok: false, error: "Redemption is unavailable" };
  const voucher = meta.data;
  if (voucher.disabled) return { ok: false, error: "This voucher is disabled" };
  if (voucher.expires && melbourneDate() > voucher.expires) return { ok: false, error: "This voucher has expired" };
  if (voucher.status !== "issued") return { ok: false, error: "Already redeemed" };
  const next = { ...voucher, status: "redeemed", redeemedAt: new Date().toISOString(), redeemedBy: actorId || "" };
  const write = await store.setJSON(key, next, { onlyIfMatch: meta.etag });
  if (!write || write.modified !== true) return { ok: false, error: "Already redeemed" };
  await store.setJSON("audit/" + voucher.id, auditView(next));
  return { ok: true, voucher: auditView(next) };
}
