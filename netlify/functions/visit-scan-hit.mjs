import { json } from "../lib/lib.mjs";
import { previewReadOnly } from "../lib/preview-deploy.mjs";
import { recordVisitPageScan } from "../lib/visit-scans.mjs";

export default async (req, context) => {
  if (previewReadOnly(req, context)) {
    return json(403, { error: "This is a preview for review. Nothing can be saved here." }, { "cache-control": "no-store" });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" }, { "cache-control": "no-store" });
  try {
    const body = await req.json().catch(() => ({}));
    const result = await recordVisitPageScan(req, context, body);
    if (result?.status === 400) return json(400, { error: result.error }, { "cache-control": "no-store" });
  } catch (e) {
    console.error("visit-scan", e && e.message);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

export const config = { path: "/api/visit/scan-hit" };
