import { shouldCountVisitRequest, visitScanKind } from "./visit-scan-paths.mjs";

/** Record a page open in the background, then always continue to the static page. */
export async function handleVisitScanEdge(request, context) {
  try {
    if (shouldCountVisitRequest(request)) {
      const kind = visitScanKind(new URL(request.url).pathname);
      if (kind) {
        const hit = new URL("/api/visit/scan-hit", request.url);
        const task = fetch(hit, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": request.headers.get("user-agent") || "",
          },
          body: JSON.stringify({
            kind,
            referrer: request.headers.get("referer") || "",
            geo: context?.geo || {},
          }),
        }).catch(() => null);
        if (typeof context?.waitUntil === "function") context.waitUntil(task);
      }
    }
  } catch {
    /* Fail open: the sign-in and sign-out pages must still load. */
  }
  return context.next();
}
