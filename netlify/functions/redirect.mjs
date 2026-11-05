import { codes, stats, parseUA } from "../lib/lib.mjs";
const inactive = () => new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Link inactive</title><body style="font-family:system-ui;display:grid;place-items:center;height:90vh;color:#334;text-align:center"><div><h1>Link inactive</h1><p>This QR code is not currently active.</p></div>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
export default async (req, context) => {
  const slug = (context.params?.slug || new URL(req.url).pathname.split("/").pop() || "").toLowerCase();
  const code = await codes().get(slug, { type: "json" }).catch(() => null);
  if (!code || code.paused) return inactive();
  try {
    const s = (await stats().get(slug, { type: "json" })) || { total: 0, daily: {}, device: {}, os: {}, referrer: {}, country: {}, city: {} };
    const inc = (k, v) => { v = String(v || "Unknown").slice(0, 80); s[k][v] = (s[k][v] || 0) + 1; };
    const { os, device } = parseUA(req.headers.get("user-agent") || "");
    let ref = req.headers.get("referer"); try { ref = ref ? new URL(ref).hostname : "Direct / QR scan"; } catch { ref = "Unknown"; }
    const g = context.geo || {};
    s.total++; s.last = new Date().toISOString();
    inc("daily", s.last.slice(0, 10)); inc("device", device); inc("os", os); inc("referrer", ref);
    inc("country", g.country?.name || g.country?.code); inc("city", g.city ? `${g.city}${g.subdivision?.code ? ", " + g.subdivision.code : ""}` : null);
    await stats().setJSON(slug, s);
  } catch (e) { console.error(e); }
  return new Response(null, { status: 302, headers: { location: code.url, "cache-control": "no-store" } });
};
export const config = { path: "/r/:slug" };
