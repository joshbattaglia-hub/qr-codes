import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.VISITOR_SHEETS_SPREADSHEET_ID;
delete process.env.VISITOR_SHEETS_CLIENT_EMAIL;
delete process.env.VISITOR_SHEETS_PRIVATE_KEY;

const JOSHUA = "jbattaglia@libertyretail.com.au";
const NEIL = "nanderson@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [NEIL]: { approverKey: "neil", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
const { setMailTransport } = await import("../netlify/lib/mail.mjs");
const publicFn = (await import("../netlify/functions/visitor-public.mjs")).default;
const adminFn = (await import("../netlify/functions/visitor-admin.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;
const otpMail = [];
otpLib.setOtpTestHooks({ deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
const sent = [];
setMailTransport(async (message) => { sent.push(message); return { status: "sent", id: "fake" }; });

let ipSeq = 0;
function req(method, url, { cookie = "", body, origin } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  headers.set("x-nf-client-connection-ip", "2001:db8:dddd::" + (++ipSeq).toString(16));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function read(res) {
  return { status: res.status, body: await res.json(), headers: res.headers };
}
async function otpCookie(email) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }));
  assert.equal(started.status, 200);
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_otp");
}
async function auditActions() {
  const { blobs } = await lib.visitorStore().list({ prefix: "audit/" });
  const rows = await Promise.all(blobs.map((blob) => lib.visitorStore().get(blob.key, { type: "json" })));
  return rows.filter(Boolean).map((row) => row.action);
}

test("phone validation keeps readable display text and normalises the tel: href", () => {
  assert.deepEqual(visitLib.maintenancePhone("0400 000 000"), { display: "0400 000 000", href: "tel:0400000000" });
  assert.deepEqual(visitLib.maintenancePhone("  +61 400 000 001 "), { display: "+61 400 000 001", href: "tel:+61400000001" });
  assert.deepEqual(visitLib.maintenancePhone("(03) 9000-0000"), { display: "(03) 9000-0000", href: "tel:0390000000" });
  assert.deepEqual(visitLib.maintenancePhone("1300.000.000"), { display: "1300.000.000", href: "tel:1300000000" });
  assert.equal(visitLib.maintenancePhone("").blank, true);
  assert.equal(visitLib.maintenancePhone("   ").blank, true);
  for (const bad of ["call Bob", "0400 000 000 ext 2", "12345", "+61 400 000 000 000 00", "04+00000000", "javascript:alert(1)", "0400<b>000</b>", "0400 000 000 0000 0000 0000"]) {
    assert.ok(visitLib.maintenancePhone(bad).error, bad);
  }
});

test("public contacts are empty and the block stays hidden until a number is set", async () => {
  const empty = await read(await publicFn(req("GET", "/api/visit/contacts")));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { contacts: [] });
  assert.match(empty.headers.get("cache-control"), /no-store/);
  for (const page of ["../public/visit.html", "../public/visit/sign-in.html"]) {
    const html = fs.readFileSync(new URL(page, import.meta.url), "utf8");
    const done = html.slice(html.indexOf('id="in-done"'), html.indexOf("</section>", html.indexOf('id="in-done"')));
    assert.ok(done.indexOf("Sign Out QR Code") < done.indexOf('id="maintenance-contacts"'), page + ": block sits below the sign-out reminder");
    assert.match(done, /<div class="maintenance" id="maintenance-contacts" hidden data-testid="visit-maintenance">/);
    assert.match(done, /Need the locker access code\? Call maintenance:/);
    assert.match(html, /<script src="\/visit\/maintenance\.js" defer><\/script>/);
  }
  const script = fs.readFileSync(new URL("../public/visit/maintenance.js", import.meta.url), "utf8");
  assert.match(script, /box\.hidden = contacts\.length === 0/);
  assert.match(script, /textContent = row\.display/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /\^tel:\\\+\?\[0-9\]\{6,15\}\$/);
});

test("admin settings are Joshua-only: 401 signed out, 403 for the shared password and other staff", async () => {
  const anon = await read(await adminFn(req("GET", "/api/visitor-log/maintenance")));
  assert.equal(anon.status, 401);
  const anonSave = await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { body: { numbers: ["0400 000 000"] } })));
  assert.equal(anonSave.status, 401);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  assert.ok(head);
  assert.equal((await read(await adminFn(req("GET", "/api/visitor-log/maintenance", { cookie: head })))).status, 403);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: head, body: { numbers: ["0400 000 000"] } })))).status, 403);
  const neil = await otpCookie(NEIL);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: neil, body: { numbers: ["0400 000 000"] } })))).status, 403);
  const joshua = await otpCookie(JOSHUA);
  const crossSite = await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, origin: "https://evil.example", body: { numbers: ["0400 000 000"] } }));
  assert.equal(crossSite.status, 403);
  assert.deepEqual((await read(await publicFn(req("GET", "/api/visit/contacts")))).body, { contacts: [] });
});

test("Joshua saves up to 4 numbers; only set lines are public with labels, display and tel: link only", async () => {
  const joshua = await otpCookie(JOSHUA);
  const start = await read(await adminFn(req("GET", "/api/visitor-log/maintenance", { cookie: joshua })));
  assert.deepEqual(start.body, { numbers: ["", "", "", ""] });
  const bad = await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: ["0400 000 000", "call Bob"] } })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "Maintenance line 2 is not a valid phone number.");
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: ["1", "2", "3", "4", "5"] } })))).status, 400);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: "0400 000 000" } })))).status, 400);
  assert.equal((await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: [400000000] } })))).status, 400);
  assert.deepEqual((await read(await publicFn(req("GET", "/api/visit/contacts")))).body, { contacts: [] }, "rejected saves change nothing");

  const saved = await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: [" 0400  000 000 ", "", "+61 400 000 002", ""] } })));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.numbers, ["0400 000 000", "", "+61 400 000 002", ""]);
  assert.deepEqual((await read(await adminFn(req("GET", "/api/visitor-log/maintenance", { cookie: joshua })))).body.numbers, ["0400 000 000", "", "+61 400 000 002", ""]);
  const pub = await read(await publicFn(req("GET", "/api/visit/contacts")));
  assert.deepEqual(pub.body, { contacts: [
    { label: "Maintenance line 1", display: "0400 000 000", href: "tel:0400000000" },
    { label: "Maintenance line 3", display: "+61 400 000 002", href: "tel:+61400000002" },
  ] });
  assert.deepEqual(Object.keys(pub.body), ["contacts"]);
  for (const row of pub.body.contacts) assert.deepEqual(Object.keys(row), ["label", "display", "href"]);
  assert.ok((await auditActions()).includes("maintenance-numbers"));
  assert.equal(sent.length, 0, "no notification mail");

  const all = await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: ["0400 000 001", "0400 000 002", "0400 000 003", "0400 000 004"] } })));
  assert.equal(all.status, 200);
  assert.deepEqual((await read(await publicFn(req("GET", "/api/visit/contacts")))).body.contacts.map((row) => row.label), ["Maintenance line 1", "Maintenance line 2", "Maintenance line 3", "Maintenance line 4"]);
  // Clearing all four hides the block again.
  const cleared = await read(await adminFn(req("POST", "/api/visitor-log/maintenance", { cookie: joshua, body: { numbers: ["", "", "", ""] } })));
  assert.equal(cleared.status, 200);
  assert.deepEqual((await read(await publicFn(req("GET", "/api/visit/contacts")))).body, { contacts: [] });
  // A tampered stored value is never published.
  await lib.visitorStore().setJSON("maintenance/contacts", { numbers: ["javascript:alert(1)", "0400 000 009"] });
  assert.deepEqual((await read(await publicFn(req("GET", "/api/visit/contacts")))).body.contacts, [{ label: "Maintenance line 2", display: "0400 000 009", href: "tel:0400000009" }]);
  assert.equal(sent.length, 0);
});

test("the admin Visitor Log page has the four maintenance fields and saves to the protected endpoint", () => {
  const admin = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  assert.match(admin, /<h2>Maintenance phone numbers<\/h2>/);
  assert.match(admin, /id="visitor-maintenance-' \+ i \+ '"/);
  assert.match(admin, /"\/api\/visitor-log\/maintenance", \{\s*method: "POST"/);
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.doesNotMatch(toml, /api\/visit\/contacts/, "no redirect changes");
});
