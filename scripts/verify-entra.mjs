import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const tenant = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const oid = "44444444-4444-4444-8444-444444444444";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = "browser-key";
jwk.alg = "RS256";
jwk.use = "sig";
const codes = new Map();
const issuer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8910");
  if (url.pathname === "/keys") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (url.pathname === "/authorize") {
    const code = "c" + Math.random().toString(16).slice(2);
    codes.set(code, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  if (url.pathname === "/token") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    const saved = codes.get(params.get("code"));
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ oid, tid: tenant, nonce: saved.nonce, name: "Fixture Worker", email: "not-an-approver@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "browser-key" })
      .setIssuer("http://127.0.0.1:8910")
      .setAudience(client)
      .setSubject(oid)
      .setIssuedAt(now)
      .setExpirationTime("5m")
      .sign(privateKey);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: token }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => issuer.listen(8910, "127.0.0.1", resolve));

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "http://127.0.0.1:8911";
process.env.IDENTITY_SESSION_SECRET = "fixture-session-secret-value";
process.env.ENTRA_TENANT_ID = tenant;
process.env.ENTRA_CLIENT_ID = client;
process.env.ENTRA_CLIENT_SECRET = "browser-test-secret";
process.env.ENTRA_ALLOW_TEST_ISSUER = "1";
process.env.ENTRA_TEST_ISSUER = "http://127.0.0.1:8910";
process.env.ENTRA_ROLE_MAP = JSON.stringify({ approverJoshua: { oid, siteIds: ["s00000000"] }, preparers: [{ oid, class: "joshua", siteIds: ["s00000000"] }] });
const { start } = await import("./dev-server.mjs");
const server = await start(8911);
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
const browser = await puppeteer.launch({ executablePath: "/usr/local/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function shot(name) {
  await page.screenshot({ path: path.join("/opt/cursor/artifacts", name + ".png"), fullPage: false });
}

try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8911/admin", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Local test issuer only"));
  const link = await page.$eval("#entra-signin", (el) => el.href);
  assert(link.includes("returnTo=%2Fadmin"), link);
  await page.click("#entra-signin");
  await page.waitForFunction(() => document.body.innerText.includes("Head office") || document.body.innerText.includes("Approver") || document.body.innerText.includes("POS setup"), { timeout: 8000 });
  await shot("entra-signed-in-desktop");
  await page.setViewport({ width: 390, height: 844 });
  await shot("entra-signed-in-mobile");
  const who = await page.evaluate(async () => {
    const res = await fetch("/api/identity/session", { credentials: "same-origin" });
    return res.json();
  });
  assert(who.identity?.approverKey === "joshua", JSON.stringify(who));
  assert(who.identity?.preparerClass === "joshua", JSON.stringify(who));
  assert(!JSON.stringify(who).includes("browser-test-secret"), "secret leaked");
  console.log("entra ui ok");
} finally {
  await browser.close();
  server.close();
  issuer.close();
}
