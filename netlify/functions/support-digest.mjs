import { processTestRequest, runDigest } from "../lib/support-digest.mjs";
import { processMailDiagRequest } from "../lib/mail-diag.mjs";

/** Every 15 minutes. Sends the daily Support digest at most once per Melbourne date (see runDigest). */
export default async () => {
  let test = null;
  try { test = await processTestRequest(); } catch { test = { outcome: "test-error" }; }
  let diag = null;
  try { diag = await processMailDiagRequest(); } catch { diag = { outcome: "diag-error" }; }
  let daily;
  try { daily = await runDigest(); } catch (error) { daily = { outcome: "error", error: String(error?.name || "Error") }; }
  console.log("support-digest", JSON.stringify({ daily: { outcome: daily.outcome, date: daily.date, count: daily.count }, test: test ? { outcome: test.outcome, status: test.result?.status } : null, diag: diag ? diag.outcome : null }));
  return new Response(null, { status: 204 });
};

export const config = { schedule: "*/15 * * * *" };
