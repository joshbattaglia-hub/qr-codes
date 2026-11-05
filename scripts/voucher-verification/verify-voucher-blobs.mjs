import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { memoryBackend } from "../../netlify/lib/lib.mjs";
import { redeemVoucher } from "../../netlify/lib/vouchers.mjs";

export const STORE_PREFIX = "expresshelp-voucher-verification-";
export const CONTENDERS = 24;

const PRODUCTION_STORES = new Set([
  "vouchers", "codes", "stats", "settings", "pages", "page-views", "submissions",
  "competitions", "comp-entries", "comp-files", "comp-views", "sites", "staff",
  "templates", "health", "auth-rate",
]);

export function newStoreName() {
  const name = STORE_PREFIX + crypto.randomBytes(15).toString("hex");
  assertStoreName(name);
  return name;
}

export function assertStoreName(name) {
  if (typeof name !== "string" || !name.startsWith(STORE_PREFIX) || name.length <= STORE_PREFIX.length) {
    throw new Error("Refusing to use a store outside the verification prefix");
  }
  if (name.length > 64) throw new Error("Store name exceeds the Netlify Blobs 64 byte limit");
  if (PRODUCTION_STORES.has(name)) throw new Error("Refusing to use a production store");
}

function fixture(token) {
  return {
    id: "v" + crypto.randomBytes(4).toString("hex"),
    token,
    competition: "verification-fixture",
    siteId: "verification",
    source: "verification",
    sourceId: "fixture",
    status: "issued",
    issuedAt: new Date().toISOString(),
    redeemedAt: null,
    expires: "2099-01-01",
    disabled: false,
    label: "FAKE verification fixture",
  };
}

export async function failClosedChecks() {
  let writes = 0;
  const missingEtag = await redeemVoucher({
    async getWithMetadata() {
      return { data: { status: "issued", id: "v", expires: "2099-01-01", disabled: false }, etag: "" };
    },
    async setJSON() { writes += 1; return { modified: true }; },
  }, "ab".repeat(32), { actorId: "verification" });
  let calls = 0;
  const missingStore = await redeemVoucher({
    async get() { calls += 1; return null; },
  }, "cd".repeat(32), { actorId: "verification" });
  return {
    mode: "local-stub",
    missingEtag: missingEtag.error === "Redemption is unavailable" && missingEtag.ok === false,
    missingEtagWrites: writes,
    missingStorage: missingStore.error === "Redemption is unavailable" && calls === 0,
  };
}

export async function runVerification(store, { storeName, mode, retainResult = false }) {
  assertStoreName(storeName);
  const token = crypto.randomBytes(32).toString("hex");
  const record = fixture(token);
  const key = "token/" + token;
  const seeded = await store.setJSON(key, record, { onlyIfNew: true });
  if (seeded?.modified !== true) throw new Error("Fixture seed was not a conditional create");
  const before = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!before?.etag || before.data?.status !== "issued") throw new Error("Strong read of the fixture did not return an etag");
  const results = await Promise.all(Array.from({ length: CONTENDERS }, () => redeemVoucher(store, token, { actorId: "verification" })));
  const successes = results.filter((row) => row.ok).length;
  const conflicts = results.filter((row) => row.conflict).length;
  const after = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  const replay = await redeemVoucher(store, token, { actorId: "verification" });
  const replayRead = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  const stale = await store.setJSON(key, { ...after.data, label: "stale write" }, { onlyIfMatch: before.etag });
  const afterStale = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  let cleaned = false;
  try {
    await store.delete(key);
    await store.delete("audit/" + record.id);
    if (!retainResult && typeof store.deleteAll === "function") await store.deleteAll();
    cleaned = true;
  } catch { cleaned = false; }
  const report = {
    ok: successes === 1
      && conflicts === CONTENDERS - 1
      && after?.data?.status === "redeemed"
      && after?.etag !== before.etag
      && replay.ok === false
      && replay.conflict === true
      && replayRead?.data?.status === "redeemed"
      && replayRead?.etag === after?.etag
      && stale?.modified === false
      && afterStale?.data?.status === "redeemed"
      && cleaned,
    mode,
    store: storeName,
    productionFunction: "redeemVoucher",
    consistency: "strong",
    contenders: CONTENDERS,
    successes,
    conflicts,
    other: results.length - successes - conflicts,
    rereadStatus: after?.data?.status || null,
    etagChanged: before.etag !== after?.etag,
    replayConflict: replay.conflict === true,
    replayChangedRecord: replayRead?.etag !== after?.etag,
    staleEtagModified: stale?.modified === true,
    recordAfterStale: afterStale?.data?.status || null,
    offersEnabled: false,
    cleaned,
  };
  return report;
}

export async function runMock() {
  const storeName = newStoreName();
  const store = memoryBackend()(storeName);
  return finishReport(await runVerification(store, { storeName, mode: "mock" }));
}

export async function finishReport(report) {
  report.failClosed = await failClosedChecks();
  report.ok = report.ok && report.failClosed.missingEtag && report.failClosed.missingEtagWrites === 0 && report.failClosed.missingStorage;
  return report;
}

async function runWithEnv() {
  const siteID = process.env.NETLIFY_SITE_ID || "";
  const token = process.env.NETLIFY_AUTH_TOKEN || "";
  if (!siteID || !token) {
    console.error("This environment cannot reach live Netlify Blobs. The CLI login is not injected into the SDK, and netlify dev uses a local sandbox.");
    console.error("Live evidence runs inside the deploySucceeded handler on a non-production deploy of the voucher-blobs-evidence branch. That handler is not an HTTP endpoint.");
    console.error("A local live run needs NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN set only in the command environment. Do not commit them, paste them into chat, or copy them out of the CLI config.");
    process.exit(2);
  }
  const storeName = newStoreName();
  const store = getStore({ name: storeName, consistency: "strong", siteID, token });
  const report = await finishReport(await runVerification(store, { storeName, mode: "live", retainResult: true }));
  await store.setJSON("result", report);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--live")) await runWithEnv();
  const report = await runMock();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}
