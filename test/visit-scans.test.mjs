import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] },
});

const lib = await import("../netlify/lib/lib.mjs");
const backend = lib.memoryBackend();
lib.setStoreFactory(backend);
const otpLib = await import("../netlify/lib/otp.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const { shouldCountVisitRequest, visitScanKind, isVisitScanSlug } = await import("../netlify/lib/visit-scan-paths.mjs");
const { handleVisitScanEdge } = await import("../netlify/lib/visit-scan-edge.mjs");
const { setVisitScanNow, visitScanStats } = await import("../netlify/lib/visit-scans.mjs");
const scanHit = (await import("../netlify/functions/visit-scan-hit.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const redirectFn = (await import("../netlify/functions/redirect.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const adminFn = (await import("../netlify/functions/visitor-admin.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;

const otpMail = [];
const sentMail = [];
otpLib.setOtpTestHooks({ deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
setMailTransport(async (message) => { sentMail.push(message); return { status: "sent", id: "local-mock" }; });

const FIXED = new Date("2026-11-26T02:00:00.000Z");
setVisitScanNow(() => FIXED);

function req(method, url, { cookie, body, ua, origin, ip, dest, purpose, referer, host } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (ua) headers.set("user-agent", ua);
  if (origin) headers.set("origin", origin);
  if (ip) headers.set("x-nf-client-connection-ip", ip);
  if (dest) headers.set("sec-fetch-dest", dest);
  if (purpose) headers.set("sec-fetch-purpose", purpose);
  if (referer) headers.set("referer", referer);
  if (body !== undefined) headers.set("content-type", "application/json");
  const base = host || "https://expresshelp.site";
  return new Request(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json(), headers: res.headers };
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const geo = { country: { code: "AU", name: "Australia" }, city: "Melbourne", subdivision: { code: "VIC" } };

async function adminCookie() {
  const res = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  return cookieNamed(res, "qr_admin");
}
async function otpCookie(email = JOSHUA) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email }, ip: "2001:db8::10" }));
  assert.equal(started.status, 200);
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code }, ip: "2001:db8::10" }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_otp");
}
async function hit(kind, extra = {}) {
  return read(await scanHit(req("POST", "/api/visit/scan-hit", {
    body: { kind, referrer: extra.referrer || "", geo: extra.geo || geo },
    ua: extra.ua || IPHONE,
    ip: extra.ip || "203.0.113.50",
  }), { geo: extra.contextGeo || geo, ip: extra.ip || "203.0.113.50", deploy: extra.deploy }));
}

describe("visitor scan counter", { concurrency: false }, () => {

test("pretty sign-in and sign-out paths are counted; assets, APIs and prefetch are not", () => {
  const count = (method, path, headers = {}) => shouldCountVisitRequest(req(method, path, headers));
  assert.equal(visitScanKind("/visit/sign-in/"), "sign-in");
  assert.equal(visitScanKind("/visit/sign-out"), "sign-out");
  assert.equal(visitScanKind("/visit"), "");
  assert.equal(visitScanKind("/api/visit/sites"), "");
  assert.equal(count("GET", "/visit/sign-in"), true);
  assert.equal(count("GET", "/visit/sign-in/"), true);
  assert.equal(count("GET", "/visit/sign-out/"), true);
  assert.equal(count("GET", "/visit/sign-in", { dest: "document" }), true);
  assert.equal(count("POST", "/visit/sign-in"), false);
  assert.equal(count("HEAD", "/visit/sign-in"), false);
  assert.equal(count("GET", "/visit"), false);
  assert.equal(count("GET", "/visit/sign-in.html"), false);
  assert.equal(count("GET", "/api/visit/sites"), false);
  assert.equal(count("GET", "/visit/sign-in", { dest: "image" }), false);
  assert.equal(count("GET", "/visit/sign-in", { dest: "style" }), false);
  assert.equal(count("GET", "/visit/sign-in", { dest: "script" }), false);
  assert.equal(count("GET", "/visit/sign-in", { purpose: "prefetch" }), false);
  assert.equal(isVisitScanSlug("visitor-sign-in"), true);
  assert.equal(isVisitScanSlug("hello"), false);
});

test("scan-hit records Visitor sign-in and sign-out into QR analytics without IPs or visitor hashes", async () => {
  const a = await hit("sign-in", { referrer: "" });
  const b = await hit("sign-in", { referrer: "https://news.example/path?q=1" });
  const c = await hit("sign-out");
  assert.equal(a.status, 204);
  assert.equal(b.status, 204);
  assert.equal(c.status, 204);
  const signIn = await lib.codes().get("visitor-sign-in", { type: "json" });
  const signOut = await lib.codes().get("visitor-sign-out", { type: "json" });
  assert.equal(signIn.name, "Visitor sign-in");
  assert.equal(signIn.url, "https://expresshelp.site/visit/sign-in");
  assert.equal(signIn.protected, true);
  assert.equal(signOut.name, "Visitor sign-out");
  assert.equal(signOut.url, "https://expresshelp.site/visit/sign-out");
  const inStats = await lib.stats().get("visitor-sign-in", { type: "json" });
  const dumped = JSON.stringify(inStats);
  assert.equal(dumped.includes("203.0.113.50"), false);
  assert.equal(dumped.includes("x-nf-client-connection-ip"), false);
  assert.ok(!inStats.days["2026-11-26"].scan.u || inStats.days["2026-11-26"].scan.u.length === 0, "no visitor hashes stored");
  assert.equal(inStats.days["2026-11-26"].scan.n, 2);
  assert.equal(inStats.days["2026-11-26"].scan.device.Mobile, 2);
  assert.equal(inStats.days["2026-11-26"].scan.country.AU, 2);
  assert.equal(inStats.days["2026-11-26"].scan.referrer["Direct / QR scan"], 1);
  assert.equal(inStats.days["2026-11-26"].scan.referrer["news.example"], 1);
  const outStats = await lib.stats().get("visitor-sign-out", { type: "json" });
  assert.equal(outStats.days["2026-11-26"].scan.n, 1);
  const listed = await read(await codesFn(req("GET", "/api/codes", { cookie: await adminCookie() })));
  assert.equal(listed.status, 200);
  const names = listed.body.map((row) => row.name);
  assert.ok(names.includes("Visitor sign-in") && names.includes("Visitor sign-out"));
  const row = listed.body.find((c) => c.slug === "visitor-sign-in");
  assert.equal(row.scans, 2);
  assert.equal(row.protected, true);
});

test("preview deploys do not write scan counts", async () => {
  const before = (await lib.stats().get("visitor-sign-in", { type: "json" }))?.days?.["2026-11-26"]?.scan?.n || 0;
  const res = await hit("sign-in", { deploy: { context: "deploy-preview" } });
  assert.equal(res.status, 403);
  const after = (await lib.stats().get("visitor-sign-in", { type: "json" }))?.days?.["2026-11-26"]?.scan?.n || 0;
  assert.equal(after, before);
  const alias = await read(await scanHit(req("POST", "/api/visit/scan-hit", {
    body: { kind: "sign-in", geo },
    ua: IPHONE,
    host: "https://visitor-scans-pr77--liberty-qr-353.netlify.app",
  }), { geo }));
  assert.equal(alias.status, 403);
});

test("logging failure still returns 204 and the edge handler always continues to the page", async () => {
  const boom = {
    get: async () => { throw new Error("stats down"); },
    setJSON: async () => { throw new Error("stats down"); },
  };
  lib.setStoreFactory((name) => name === "stats" ? boom : backend(name));
  try {
    const res = await read(await scanHit(req("POST", "/api/visit/scan-hit", { body: { kind: "sign-in", geo }, ua: IPHONE })));
    assert.equal(res.status, 204);
  } finally {
    lib.setStoreFactory(backend);
  }

  let nexted = 0;
  let waited = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const out = await handleVisitScanEdge(req("GET", "/visit/sign-in", { dest: "document", ua: IPHONE }), {
      geo,
      waitUntil: (p) => { waited += 1; return p; },
      next: async () => { nexted += 1; return new Response("PAGE", { status: 200 }); },
    });
    assert.equal(await out.text(), "PAGE");
    assert.equal(nexted, 1);
    assert.equal(waited, 1);
  } finally {
    globalThis.fetch = prevFetch;
  }
  const skipped = await handleVisitScanEdge(req("GET", "/visit/sign-in", { dest: "image" }), {
    geo,
    waitUntil: () => { throw new Error("should not record assets"); },
    next: async () => new Response("PAGE", { status: 200 }),
  });
  assert.equal(await skipped.text(), "PAGE");
});

test("reserved slugs cannot be created, changed or deleted, and deleting stats does not break later counts", async () => {
  const cookie = await adminCookie();
  const create = await read(await codesFn(req("POST", "/api/codes", { cookie, body: { url: "https://example.com", name: "Taken", slug: "visitor-sign-in" } })));
  assert.equal(create.status, 409);
  const patch = await read(await codesFn(req("PATCH", "/api/codes/visitor-sign-in", { cookie, body: { name: "Nope" } })));
  assert.equal(patch.status, 403);
  const del = await read(await codesFn(req("DELETE", "/api/codes/visitor-sign-in", { cookie })));
  assert.equal(del.status, 403);
  const still = await lib.codes().get("visitor-sign-in", { type: "json" });
  assert.equal(still.name, "Visitor sign-in");
  await lib.codes().delete("visitor-sign-in");
  await lib.stats().delete("visitor-sign-in");
  const again = await hit("sign-in");
  assert.equal(again.status, 204);
  const recreated = await lib.codes().get("visitor-sign-in", { type: "json" });
  assert.equal(recreated.name, "Visitor sign-in");
  const stats = await lib.stats().get("visitor-sign-in", { type: "json" });
  assert.ok(stats.days["2026-11-26"].scan.n >= 1);
});

test("short links for the reserved slugs redirect without a second count", async () => {
  const beforeIn = (await lib.stats().get("visitor-sign-in", { type: "json" }))?.days?.["2026-11-26"]?.scan?.n || 0;
  const beforeOut = (await lib.stats().get("visitor-sign-out", { type: "json" }))?.days?.["2026-11-26"]?.scan?.n || 0;
  const a = await redirectFn(req("GET", "/r/visitor-sign-in"), { params: { slug: "visitor-sign-in" }, ip: "203.0.113.9", geo });
  assert.equal(a.status, 302);
  assert.equal(a.headers.get("location"), "https://expresshelp.site/visit/sign-in");
  const b = await redirectFn(req("GET", "/r/visitor-sign-out"), { params: { slug: "visitor-sign-out" }, ip: "203.0.113.9", geo });
  assert.equal(b.headers.get("location"), "https://expresshelp.site/visit/sign-out");
  const afterIn = (await lib.stats().get("visitor-sign-in", { type: "json" }))?.days?.["2026-11-26"]?.scan?.n || 0;
  const afterOut = (await lib.stats().get("visitor-sign-out", { type: "json" }))?.days?.["2026-11-26"]?.scan?.n || 0;
  assert.equal(afterIn, beforeIn);
  assert.equal(afterOut, beforeOut);
});

test("visitor log scan-stats compare scans with completed sign-ins and sign-outs", async () => {
  await lib.stats().delete("visitor-sign-in");
  await lib.stats().delete("visitor-sign-out");
  for (let i = 0; i < 10; i++) await hit("sign-in");
  for (let i = 0; i < 8; i++) await hit("sign-out");
  async function visit(id, signedInAt, signedOutAt) {
    await lib.visitorStore().setJSON("visit/" + id, {
      id, location: "Synthetic Mernda", name: "Alex Example", phone: "0411000001", company: "Example Co",
      signedInAt, signedOutAt: signedOutAt || null, photoStatus: "none",
    });
  }
  await visit("v" + "a".repeat(32), "2026-11-26T00:30:00.000Z", "2026-11-26T03:00:00.000Z");
  await visit("v" + "b".repeat(32), "2026-11-26T01:00:00.000Z", "2026-11-26T04:00:00.000Z");
  await visit("v" + "c".repeat(32), "2026-11-26T01:15:00.000Z", null);
  await visit("v" + "d".repeat(32), "2026-11-16T02:00:00.000Z", "2026-11-16T05:00:00.000Z");
  const cookie = await otpCookie();
  const today = await read(await adminFn(req("GET", "/api/visitor-log/scan-stats?period=today", { cookie })));
  assert.equal(today.status, 200);
  assert.equal(today.body.period, "today");
  assert.equal(today.body.from, "2026-11-26");
  assert.equal(today.body.signIn.scans, 10);
  assert.equal(today.body.signIn.completed, 3);
  assert.equal(today.body.signIn.rate, 30);
  assert.equal(today.body.signOut.scans, 8);
  assert.equal(today.body.signOut.completed, 2);
  assert.equal(today.body.signOut.rate, 25);
  assert.equal(today.body.note, "This counts page opens, which can include refreshes.");
  const dumped = JSON.stringify(today.body);
  assert.equal(dumped.includes("Alex Example"), false);
  assert.equal(dumped.includes("0411000001"), false);
  const month = await read(await adminFn(req("GET", "/api/visitor-log/scan-stats?period=30", { cookie })));
  assert.equal(month.body.signIn.completed, 4);
  assert.equal(month.body.signOut.completed, 3);
  const denied = await read(await adminFn(req("GET", "/api/visitor-log/scan-stats?period=today")));
  assert.equal(denied.status, 401);
  assert.equal(sentMail.length, 0);
});

test("unknown kind is 400 and does not throw", async () => {
  const res = await hit("other");
  assert.equal(res.status, 400);
});

});
