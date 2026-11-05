import {
  codes, stats, parseUA, readGeo, recordHit, resolveDestination, channelFor, dayKey, visitorHash, validUrl, normalizeCode,
} from "../lib/lib.mjs";

const inactive = () => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link inactive</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#243;text-align:center;background:#f4f5f7"><div><h1 style="font-weight:650">Link inactive</h1><p>This Liberty link is not currently active.</p></div>`,
  { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
);

export default async (req, context) => {
  const slug = (context.params?.slug || new URL(req.url).pathname.split("/").pop() || "").toLowerCase();
  const code = await codes().get(slug, { type: "json" }).catch(() => null);
  if (!code || code.paused) return inactive();
  const normalized = normalizeCode(code);
  const destination = resolveDestination(normalized, {
    ua: req.headers.get("user-agent") || "",
    geo: readGeo(context.geo || {}),
  });
  if (!validUrl(destination)) return inactive();
  try {
    const ua = req.headers.get("user-agent") || "";
    const { os, device, browser } = parseUA(ua);
    const geo = readGeo(context.geo || {});
    let ref = "Direct / QR scan";
    const referer = req.headers.get("referer");
    if (referer) {
      try { ref = new URL(referer).hostname || ref; } catch { ref = "Unknown"; }
    }
    const qrFlag = new URL(req.url).searchParams.get("qr") === "1";
    // Hash only — the IP itself is not written to the stats blob.
    const visitor = visitorHash(context.ip || "", ua);
    const prev = await stats().get(slug, { type: "json" });
    const next = recordHit(prev, {
      at: new Date().toISOString(),
      day: dayKey(),
      channel: channelFor(normalized, qrFlag),
      os, device, browser,
      country: geo.countryCode || "Unknown",
      city: geo.city || "Unknown",
      referrer: ref,
      visitor,
    });
    await stats().setJSON(slug, next);
  } catch (e) { console.error("stats", e && e.message); }
  return new Response(null, { status: 302, headers: { location: destination, "cache-control": "no-store" } });
};

export const config = { path: "/r/:slug" };
