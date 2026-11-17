// Synthetic real-browser harness for the batch UI tests: real function handlers, in-memory Blobs, mocked mail. Nothing leaves this process.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
export const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
export const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.ADMIN_PASSWORD = "synthetic-local-only-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] } });
process.env.VISITOR_COLLECTION = "open";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;
import crypto from "node:crypto";
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.VISITOR_SHEETS_SPREADSHEET_ID = "sheet-id";
process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
process.env.VISITOR_SHEETS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
// No network from this process, ever: every outbound fetch from server code gets a canned OK.
globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "mock", expires_in: 3600, updates: { updatedRange: "Visits!A2:Z2" }, values: [], sheets: [] }), { status: 200, headers: { "content-type": "application/json" } });
const lib = await import("../../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const mail = await import("../../netlify/lib/mail.mjs");
export const mailbox = [];
mail.setMailTransport(async (m) => { mailbox.push(m); return { status: "sent", id: "mock" }; });
(await import("../../netlify/lib/visitor-log.mjs")).setVisitorTestHooks({ collect: true });
const users = await import("../../netlify/lib/users.mjs");
const otp = await import("../../netlify/lib/otp.mjs");
export const OWNER = await otp.actorForEmail(JOSHUA);
let otpNow = Date.now();
otp.setOtpTestHooks({ now: () => otpNow, deliver: async (m) => { mailbox.push(m); return { status: "sent", id: "local-mock" }; } });
// handlers
const handlers = [];
for (const f of fs.readdirSync("netlify/functions")) {
  const m = await import("../../netlify/functions/" + f);
  const paths = [].concat(m.config?.path || []);
  for (const p of paths) {
    if (!p.startsWith("/api/")) continue;
    const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-z]+/gi, "[^/]+").replace(/\*/g, ".*") + "$");
    handlers.push([re, m.default, p]);
  }
}
let ip = 0;
export async function call(method, path, { cookie = "", body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-nf-client-connection-ip", "2001:db8:abcd::" + (++ip).toString(16));
  if (body !== undefined) headers.set("content-type", "application/json");
  const url = new URL("https://expresshelp.site" + path);
  const h = handlers.find(([re]) => re.test(url.pathname));
  if (!h) return new Response(JSON.stringify({ error: "nf" }), { status: 404, headers: { "content-type": "application/json" } });
  return h[1](new Request(url, { method, headers, body: body !== undefined && typeof body !== "string" ? JSON.stringify(body) : body }), { geo: {}, ip: "127.0.0.1" });
}
const cookieNamed = (res, name) => { const rows = res.headers.getSetCookie?.() || []; const hit = rows.find((r) => r.startsWith(name + "=") && !r.startsWith(name + "=;")); return hit ? hit.split(";")[0] : ""; };
export const head = cookieNamed(await call("POST", "/api/auth", { body: { password: process.env.ADMIN_PASSWORD } }), "qr_session") || cookieNamed(await call("POST", "/api/auth", { body: { password: process.env.ADMIN_PASSWORD } }), "qr_admin");
let fake = Date.now();
let otpSeen;
export async function otpCookie(email) {
  if (!otpSeen) otpSeen = new Set();
  if (otpSeen.has(email)) otpNow += 16 * 60 * 1000;
  otpSeen.add(email);
  const before = mailbox.length;
  const s = await call("POST", "/api/identity/otp/start", { body: { email } });
  const code = mailbox.slice(before).at(-1)?.text?.match(/code is (\d{8})/)?.[1];
  if (!code) throw new Error("no code " + s.status);
  return cookieNamed(await call("POST", "/api/identity/otp/verify", { body: { email, code } }), "qr_otp");
}
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function launch() { return puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] }); }
export async function openPage(browser, cookie, hash, { w = 1366, h = 900, scale, theme, headMode = false, init, log = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: scale || (w < 500 ? 2 : 1) });
  if (init) await page.evaluateOnNewDocument(init);
  await page.setRequestInterception(true);
  const bad = [];
  page.on("request", async (r) => {
    const u = new URL(r.url());
    if (u.origin !== "https://expresshelp.site") return r.abort();
    if (u.pathname.startsWith("/api/")) {
      const hdrs = r.headers();
      const res = await call(r.method(), u.pathname + u.search, { cookie, body: r.postData() || undefined });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status >= 400 && log) bad.push(r.method() + " " + u.pathname + " " + res.status);
      const hh = {}; res.headers.forEach((v, k) => { if (k !== "set-cookie") hh[k] = v; });
      return r.respond({ status: res.status, headers: hh, body: buf });
    }
    const file = u.pathname === "/admin/" || u.pathname.startsWith("/admin/") && !u.pathname.includes(".") ? "public/admin/index.html" : "public" + u.pathname;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return r.respond({ contentType: file.endsWith(".css") ? "text/css" : /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".woff2") ? "font/woff2" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : "text/html", body: fs.readFileSync(file) });
    r.respond({ status: 404, body: "" });
  });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  page.bad = bad;
  await page.goto("https://expresshelp.site/admin/#/" + hash);
  await page.waitForSelector("#shell:not(.hidden)", { timeout: 10000 });
  await wait(700);
  return page;
}
