import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setStoreFactory, memoryBackend } from "../netlify/lib/lib.mjs";

setStoreFactory(memoryBackend());
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "liberty-dev";
if (!process.env.PUBLIC_URL) process.env.PUBLIC_URL = "https://expresshelp.site";

const auth = (await import("../netlify/functions/auth.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const settingsFn = (await import("../netlify/functions/settings.mjs")).default;
const redirectFn = (await import("../netlify/functions/redirect.mjs")).default;
const pagesFn = (await import("../netlify/functions/pages.mjs")).default;
const compFn = (await import("../netlify/functions/competitions.mjs")).default;
const sitesFn = (await import("../netlify/functions/sites.mjs")).default;
const staffFn = (await import("../netlify/functions/staff.mjs")).default;
const vouchersFn = (await import("../netlify/functions/vouchers.mjs")).default;
const healthFn = (await import("../netlify/functions/health.mjs")).default;
const templatesFn = (await import("../netlify/functions/templates.mjs")).default;
const posFn = (await import("../netlify/functions/pos-drafts.mjs")).default;
const identityFn = (await import("../netlify/functions/identity.mjs")).default;
const entraFn = (await import("../netlify/functions/entra.mjs")).default;
const reviewFn = (await import("../netlify/functions/pos-review.mjs")).default;
const claimFn = (await import("../netlify/functions/claim-public.mjs")).default;
if (process.env.POS_MAIL_MOCK === "1" && !(process.env.RESEND_API_KEY && process.env.RESEND_FROM)) {
  const { setMailTransport } = await import("../netlify/lib/mail.mjs");
  setMailTransport(async (message) => {
    fs.appendFileSync("/tmp/pos-mail-mock.jsonl", JSON.stringify({ to: message.to, subject: message.subject }) + "\n");
    return { status: "sent", id: "local-mock", mock: true };
  });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const GEO = {
  US: { city: "Austin", country: { code: "US", name: "United States" }, subdivision: { code: "TX" } },
  JP: { city: "Tokyo", country: { code: "JP", name: "Japan" } },
  AU: { city: "Sydney", country: { code: "AU", name: "Australia" }, subdivision: { code: "NSW" } },
};
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };

function toRequest(req, url, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const init = { method: req.method, headers };
  if (body.length && req.method !== "GET" && req.method !== "HEAD") init.body = body;
  return new Request(url, init);
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  if (typeof response.headers.getSetCookie === "function") {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(buf);
}

export function start(port = 8888) {
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "127.0.0.1";
      const url = new URL(req.url, "http://" + host);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const request = toRequest(req, url, body);
      if (url.pathname === "/api/auth") return send(res, await auth(request));
      if (url.pathname === "/api/settings") return send(res, await settingsFn(request));
      if (url.pathname === "/api/sites" || url.pathname.startsWith("/api/sites/")) return send(res, await sitesFn(request));
      if (url.pathname === "/api/staff" || url.pathname.startsWith("/api/staff/")) return send(res, await staffFn(request));
      if (url.pathname === "/api/vouchers" || url.pathname.startsWith("/api/vouchers/")) {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1");
        return send(res, await vouchersFn(request, { ip }));
      }
      if (url.pathname === "/api/health" || url.pathname.startsWith("/api/health/")) return send(res, await healthFn(request));
      if (url.pathname === "/api/templates" || url.pathname.startsWith("/api/templates/")) return send(res, await templatesFn(request));
      if (url.pathname === "/api/pos-drafts" || url.pathname.startsWith("/api/pos-drafts/")) return send(res, await posFn(request));
      if (url.pathname.startsWith("/api/identity/entra")) return send(res, await entraFn(request));
      if (url.pathname.startsWith("/api/identity/entra")) return send(res, await entraFn(request));
      if (url.pathname.startsWith("/api/identity/")) return send(res, await identityFn(request));
      if (url.pathname.startsWith("/api/pos-review/")) return send(res, await reviewFn(request));
      if (url.pathname.startsWith("/api/claim/")) return send(res, await claimFn(request));
      if (url.pathname === "/api/codes" || url.pathname.startsWith("/api/codes/")) {
        const slug = url.pathname === "/api/codes" ? undefined : decodeURIComponent(url.pathname.slice("/api/codes/".length));
        return send(res, await codesFn(request, { params: { slug } }));
      }
      if (url.pathname === "/api/competitions" || url.pathname.startsWith("/api/competitions/") || url.pathname.startsWith("/c/")) {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1");
        return send(res, await compFn(request, { ip }));
      }
      if (url.pathname === "/api/pages" || url.pathname.startsWith("/api/pages/") || url.pathname.startsWith("/p/")) {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1");
        return send(res, await pagesFn(request, { ip }));
      }
      if (url.pathname.startsWith("/r/")) {
        const slug = decodeURIComponent(url.pathname.slice(3).replace(/\/$/, ""));
        const geo = GEO[url.searchParams.get("_geo")] || GEO.AU;
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1");
        return send(res, await redirectFn(request, { params: { slug }, geo, ip }));
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let filePath = path.normalize(path.join(root, rel));
      if (url.pathname === "/") filePath = path.join(root, "index.html");
      if (!filePath.startsWith(root + path.sep) && filePath !== root) { res.writeHead(403).end("Forbidden"); return; }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
      if (!fs.existsSync(filePath)) {
        if (url.pathname.startsWith("/admin")) filePath = path.join(root, "admin/index.html");
        else { res.writeHead(404).end("Not found"); return; }
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(e.stack || String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8888);
  start(port).then(() => console.log("Liberty admin dev server http://127.0.0.1:" + port));
}
