/** Reserved analytics entries for the printed visitor sign-in and sign-out QR codes.
 *  Those codes point at /visit/sign-in and /visit/sign-out, not /r/<slug>. */
export const VISIT_SCAN_ENTRIES = {
  "sign-in": {
    kind: "sign-in",
    slug: "visitor-sign-in",
    name: "Visitor sign-in",
    path: "/visit/sign-in",
  },
  "sign-out": {
    kind: "sign-out",
    slug: "visitor-sign-out",
    name: "Visitor sign-out",
    path: "/visit/sign-out",
  },
};

export function visitScanKind(pathname) {
  const p = String(pathname || "").replace(/\/+$/, "") || "/";
  if (p === "/visit/sign-in") return "sign-in";
  if (p === "/visit/sign-out") return "sign-out";
  return "";
}

export function visitScanEntry(kind) {
  return VISIT_SCAN_ENTRIES[kind] || null;
}

export function isVisitScanSlug(slug) {
  const s = String(slug || "").toLowerCase();
  return s === VISIT_SCAN_ENTRIES["sign-in"].slug || s === VISIT_SCAN_ENTRIES["sign-out"].slug;
}

export function visitScanPublicPath(slug) {
  const s = String(slug || "").toLowerCase();
  if (s === VISIT_SCAN_ENTRIES["sign-in"].slug) return VISIT_SCAN_ENTRIES["sign-in"].path;
  if (s === VISIT_SCAN_ENTRIES["sign-out"].slug) return VISIT_SCAN_ENTRIES["sign-out"].path;
  return "";
}

/** Count only document GET navigations of the printed sign-in and sign-out URLs. */
export function shouldCountVisitRequest(req) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method !== "GET") return false;
  let url;
  try { url = new URL(req.url); } catch { return false; }
  if (!visitScanKind(url.pathname)) return false;
  const dest = String(req.headers?.get?.("sec-fetch-dest") || "").toLowerCase();
  if (dest && dest !== "document" && dest !== "empty") return false;
  const purpose = String(req.headers?.get?.("sec-fetch-purpose") || req.headers?.get?.("purpose") || "").toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return false;
  return true;
}

export function visitScanReferrer(raw) {
  const value = String(raw || "").trim();
  if (!value) return "Direct / QR scan";
  try {
    return new URL(value).hostname || "Unknown";
  } catch {
    return "Unknown";
  }
}
