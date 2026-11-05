import { codes, competitionsStore, json, visitorHash, vouchersStore } from "../lib/lib.mjs";
import { actorFrom, canSeeSite, forbidden, unauthorised } from "../lib/access.mjs";
import { auditView, issueVoucher, redeemVoucher, voucherConfig } from "../lib/vouchers.mjs";

async function parentOffer(record) {
  if (record.source === "qr") {
    const code = await codes().get(record.competition, { type: "json" });
    if (!code || code.voucher?.enabled !== true) return null;
    return { siteId: code.siteId || "", enabled: true };
  }
  const comp = await competitionsStore().get(record.competition, { type: "json" });
  if (!comp || !voucherConfig(comp).enabled) return null;
  return { siteId: comp.siteId || record.siteId || "", enabled: true };
}

export default async (req, context) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const store = vouchersStore();
  if (path === "/api/vouchers/claim" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const slug = String(body.code || "").trim().toLowerCase();
    const code = slug ? await codes().get(slug, { type: "json" }) : null;
    if (!code || code.voucher?.enabled !== true || code.paused) return json(400, { error: "No voucher is available" });
    const issued = await issueVoucher(store, {
      competition: slug,
      siteId: code.siteId || "",
      source: "qr",
      parentType: "code",
      sourceId: visitorHash(context?.ip || "", req.headers.get("user-agent") || ""),
      expires: code.voucher.expires || "",
      label: code.voucher.label || "",
    });
    if (!issued?.token) return json(503, { error: "Could not issue a voucher" });
    return json(200, { id: issued.id, token: issued.token, created: !!issued.created });
  }
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();
  if (path === "/api/vouchers" && req.method === "GET") {
    const { blobs } = await store.list({ prefix: "audit/" });
    const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    return json(200, rows.filter((row) => canSeeSite(actor, row.siteId || "")).map(auditView));
  }
  if (path === "/api/vouchers/redeem" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "");
    const meta = typeof store.getWithMetadata === "function" ? await store.getWithMetadata("token/" + token, { type: "json" }) : null;
    if (!meta?.data) return json(400, { error: "Invalid voucher" });
    const parent = await parentOffer(meta.data);
    if (!parent) return json(400, { error: "This voucher is disabled" });
    if (!canSeeSite(actor, parent.siteId || meta.data.siteId || "")) return forbidden();
    const result = await redeemVoucher(store, token, { actorId: actor.id });
    if (!result.ok) return json(400, { error: result.error || "Could not redeem" });
    return json(200, result);
  }
  return json(404, { error: "Not found" });
};

export const config = { path: ["/api/vouchers", "/api/vouchers/claim", "/api/vouchers/redeem"] };
