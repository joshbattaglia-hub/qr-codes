import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
export const codes = () => getStore({ name: "codes", consistency: "strong" });
export const stats = () => getStore({ name: "stats", consistency: "strong" });
const secret = () => crypto.createHash("sha256").update("qr-sess:" + (process.env.ADMIN_PASSWORD || "")).digest();
export function checkPassword(p) {
  const a = Buffer.from(String(p || "")), b = Buffer.from(process.env.ADMIN_PASSWORD || "");
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function makeCookie() {
  const exp = Date.now() + 7 * 864e5;
  const sig = crypto.createHmac("sha256", secret()).update(String(exp)).digest("hex");
  return `qr_admin=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
}
export function authed(req) {
  const m = (req.headers.get("cookie") || "").match(/qr_admin=(\d+)\.([a-f0-9]+)/);
  if (!m || +m[1] < Date.now()) return false;
  const sig = crypto.createHmac("sha256", secret()).update(m[1]).digest("hex");
  return sig.length === m[2].length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(m[2]));
}
export const json = (s, o, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
export function parseUA(ua = "") {
  let os = "Other", device = "Desktop";
  if (/iPhone|iPod/.test(ua)) { os = "iOS"; device = "Mobile"; }
  else if (/iPad/.test(ua)) { os = "iPadOS"; device = "Tablet"; }
  else if (/Android/.test(ua)) { os = "Android"; device = /Mobile/.test(ua) ? "Mobile" : "Tablet"; }
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";
  if (/bot|crawl|spider|curl|wget|python|preview/i.test(ua)) device = "Bot/Other";
  return { os, device };
}
