import { getStore } from "@netlify/blobs";
import { failClosedChecks, finishReport, newStoreName, runVerification } from "../../scripts/voucher-verification/verify-voucher-blobs.mjs";

/** Non-secret marker. CLI drafts must pass it with --message. It is not a credential. */
export const FIXTURE_MARKER = "voucher-blobs-evidence";

/**
 * Accepts the observed unpublished CLI draft: context deploy-preview,
 * publishedAt null, branch null, and the marker in the deploy title.
 * Production context never runs. External HTTP calls are rejected by Netlify's
 * event signature before this function is invoked.
 */
export function shouldRun(deploy) {
  if (!deploy || typeof deploy !== "object") return false;
  if (deploy.context === "production") return false;
  if (deploy.publishedAt) return false;
  if (deploy.context !== "deploy-preview" && deploy.context !== "branch-deploy") return false;
  const haystack = [deploy.title, deploy.commitMessage, deploy.branch].map((value) => String(value || ""));
  return haystack.some((value) => value.includes(FIXTURE_MARKER));
}

export function gateSummary(deploy) {
  const title = String(deploy?.title || "");
  const message = String(deploy?.commitMessage || "");
  return {
    run: shouldRun(deploy),
    context: deploy?.context ?? null,
    published: Boolean(deploy?.publishedAt),
    branchPresent: Boolean(deploy?.branch),
    manual: deploy?.manual === true,
    titleMarked: title.includes(FIXTURE_MARKER) || message.includes(FIXTURE_MARKER),
  };
}

export default {
  async deploySucceeded(event) {
    const deploy = event?.deploy || null;
    console.log("VOUCHER_BLOBS_EVIDENCE_SEEN " + JSON.stringify(gateSummary(deploy)));
    if (!shouldRun(deploy)) return;
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
