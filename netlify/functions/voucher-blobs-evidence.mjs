import { getStore } from "@netlify/blobs";
import { failClosedChecks, finishReport, newStoreName, runVerification } from "../../scripts/voucher-verification/verify-voucher-blobs.mjs";

/**
 * Runs only for a non-production deploy of the evidence branch.
 * Netlify signs event calls and rejects external requests before this runs.
 * There is no HTTP handler and no public path.
 */
export function shouldRun(deploy) {
  if (!deploy || typeof deploy !== "object") return false;
  if (deploy.context === "production") return false;
  return String(deploy.branch || "").includes("voucher-blobs-evidence");
}

export default {
  async deploySucceeded(event) {
    if (!shouldRun(event?.deploy)) return;
    const storeName = newStoreName();
    const store = getStore({ name: storeName, consistency: "strong" });
    let report;
    try {
      report = await finishReport(await runVerification(store, { storeName, mode: "live", retainResult: true }));
      report.deployContext = event.deploy.context || null;
      report.deployId = event.deploy.id || null;
    } catch (error) {
      report = {
        ok: false,
        mode: "live",
        store: storeName,
        error: String(error?.message || error).slice(0, 300),
        failClosed: await failClosedChecks().catch(() => null),
      };
    }
    await store.setJSON("result", report);
    console.log("VOUCHER_BLOBS_EVIDENCE " + JSON.stringify(report));
  },
};
