import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ADMIN_PASSWORD = "test-pass-synthetic";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
process.env.VISITOR_COLLECTION = "open";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: [] } });

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const usersLib = await import("../netlify/lib/users.mjs");
const cred = await import("../netlify/lib/credentials.mjs");
const mailLib = await import("../netlify/lib/mail.mjs");
const perms = await import("../public/admin/permissions.mjs");
const ar = await import("../netlify/lib/access-request.mjs");
const fn = async (name) => (await import("../netlify/functions/" + name + ".mjs")).default;
const requestFn = await fn("access-request");
const passwordFn = await fn("password");
const identityFn = await fn("identity");
const whFn = await fn("warehouse");
const authFn = await fn("auth");

const sent = [];
let mode = "sent";
mailLib.setMailTransport(async (m) => { sent.push(m); return { status: mode, id: "mock" }; });
let t = Date.parse("2026-11-18T09:00:00+11:00");
cred.setCredentialsTestHooks({ now: () => t });
let ip = 0;
const req = (method, url, { cookie = "", body } = {}) => {
  const h = new Headers();
  if (cookie) h.set("cookie", cookie);
  h.set("x-nf-client-connection-ip", "2001:db8:a11::" + (++ip).toString(16));
  if (body !== undefined) h.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
};
const cookieOf = (res) => { const r = (res.headers.getSetCookie?.() || []).find((x) => x.startsWith("qr_otp=") && !x.startsWith("qr_otp=;")); return r ? r.split(";")[0] : ""; };
const owner = await otpLib.actorForEmail(JOSHUA);
const PW = "correct horse battery";
async function userWithSession(email, extra = {}) {
  const res = await usersLib.saveUser(owner, { mode: "add", email, visitor: "none", tickets: [], assets: "none", ...extra });
  assert.equal(res.status, 200, res.error);
  await cred.writePassword(email, PW);
  const login = await passwordFn(req("POST", "/api/identity/password/login", { body: { email, password: PW } }));
  assert.equal(login.status, 200);
  return cookieOf(login);
}
const ask = (cookie, body) => requestFn(req("POST", "/api/access-request", { cookie, body }));
const asks = () => sent.filter((m) => /Access request/.test(m.subject));

test("ROOT CAUSE: the hidden attribute lost to .nav button{display:flex}; the stylesheet now forces [hidden] to win", () => {
  const css = fs.readFileSync(new URL("../public/admin/styles.css", import.meta.url), "utf8");
  assert.match(css, /^\[hidden\]\{display:none !important\}/);
  assert.match(css, /\.nav button\{display:flex/, "the rule that used to override the attribute is still there");
  assert.ok(css.indexOf("[hidden]{display:none !important}") < css.indexOf(".nav button{display:flex"));
});

test("josh@-style user (Warehouse Stickers only): server access is exactly that one tool, by session and by password sign-in", async () => {
  await lib.usersStore().delete("registry");
  const email = "josh@libertyretail.com.au";
  const cookie = await userWithSession(email, { warehouse: true });
  const session = await (await identityFn(req("GET", "/api/identity/session", { cookie }))).json();
  assert.equal(session.identity.email, email);
  assert.notEqual(session.identity.owner, true);
  assert.deepEqual(perms.tabsFor(session.identity, []), ["warehouse"]);
  assert.equal(usersLib.isOwner(session.identity), false);
  assert.equal(session.identity.role, "building-maintenance");
  assert.equal((await whFn(req("GET", "/api/warehouse", { cookie }))).status, 200);
  assert.equal((await whFn(req("POST", "/api/warehouse/settings", { cookie, body: { next: 5000 } }))).status, 403);
  for (const name of ["users", "sites", "pos-drafts", "tickets", "codes", "pages", "settings", "staff", "templates", "vouchers", "competitions"]) {
    const res = await (await fn(name))(req("GET", "/api/" + (name === "pos-drafts" ? "pos-drafts" : name), { cookie }));
    assert.ok([401, 403].includes(res.status), name + " " + res.status);
  }
  // The session is not head office.
  assert.equal((await (await authFn(req("GET", "/api/auth", { cookie }))).json()).authenticated, false);
  // The head-office password typed into the user sign-in is never accepted.
  const bad = await passwordFn(req("POST", "/api/identity/password/login", { body: { email, password: "test-pass-synthetic" } }));
  assert.equal(bad.status, 401);
});

test("owner checks are exact: similar addresses and the same prefix never become the owner", async () => {
  for (const email of ["jbattaglia2@libertyretail.com.au", "jbattaglia+x@libertyretail.com.au", "j.battaglia@libertyretail.com.au", "josh@libertyretail.com.au"]) {
    await lib.usersStore().delete("registry");
    const res = await usersLib.saveUser(owner, { mode: "add", email, warehouse: true, visitor: "none", tickets: [], assets: "none" });
    assert.equal(res.status, 200, email + " " + res.error);
    const actor = await otpLib.actorForEmail(email);
    assert.equal(usersLib.isOwner(actor), false, email);
    assert.equal(actor.owner, false);
    assert.deepEqual(perms.tabsFor(actor, []), ["warehouse"]);
  }
  assert.equal(usersLib.isOwner(await otpLib.actorForEmail("JBATTAGLIA@LIBERTYRETAIL.COM.AU")), true, "same address in capitals is the same person");
});

test("request access: one email to Joshua with the requester, tool, escaped reason, AEDT time, edit link and the new footer; grants nothing", async () => {
  await lib.usersStore().delete("registry");
  const email = "limited.synthetic@libertyretail.com.au";
  const cookie = await userWithSession(email, { warehouse: true });
  const before = JSON.stringify((await usersLib.readUsers()).users);
  const res = await ask(cookie, { tool: "visitors", reason: '<img src=x onerror=alert(1)> & "quotes"\nline two' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, true);
  const mails = asks();
  assert.equal(mails.length, 1);
  const m = mails[0];
  assert.equal(m.to, JOSHUA);
  assert.equal(m.replyTo, email);
  assert.equal(m.subject, "[Express Help] Access request: Visitor Log (" + email + ")");
  assert.match(m.idempotencyKey, /^arq-[a-f0-9]{16}-visitors-\d+$/);
  assert.match(m.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quotes&quot;/);
  assert.equal(m.html.replace(/<img src="https:\/\/expresshelp\.site\/brand\/logo-lockup-email\.png"[^>]*>/, "").includes("<img"), false, "only the logo is an image; the user text is escaped");
  assert.match(m.text, /Reason: <img src=x/);
  for (const part of [m.html, m.text]) {
    assert.match(part, /Requester/ );
    assert.match(part, /AEDT|GMT\+11/);
    assert.match(part, /Visitor Log/);
    assert.ok(part.includes("https://expresshelp.site/admin/#/users?edit=limited.synthetic%40libertyretail.com.au") || part.includes("https://expresshelp.site/admin/#/users?edit=limited.synthetic%40libertyretail.com.au"));
  }
  assert.match(m.html, /Cowabunga - please hesitate to reach out <a href="mailto:jbattaglia@libertyretail\.com\.au"[^>]*>email me here<\/a>/);
  assert.match(m.text, /Cowabunga - please hesitate to reach out email me here: mailto:jbattaglia@libertyretail\.com\.au/);
  assert.equal(JSON.stringify((await usersLib.readUsers()).users), before, "no access was granted");
  assert.equal((await whFn(req("GET", "/api/visitor-log/visits", { cookie }))).status >= 400, true);
});

test("tool validation and who may ask", async () => {
  const email = "limited.two@libertyretail.com.au";
  const cookie = await userWithSession(email, { warehouse: true });
  const before = asks().length;
  assert.equal((await ask(cookie, { tool: "rm -rf" })).status, 400);
  assert.equal((await ask(cookie, { tool: "__proto__" })).status, 400);
  assert.equal((await ask(cookie, {})).status, 400);
  assert.equal((await ask(cookie, { tool: "assets", reason: { a: 1 } })).status, 400);
  assert.equal((await ask(cookie, { tool: "warehouse" })).status, 409, "already has it");
  assert.equal((await requestFn(req("POST", "/api/access-request", { body: { tool: "assets" } }))).status, 401);
  const head = await authFn(req("POST", "/api/auth", { body: { password: "test-pass-synthetic" } }));
  const headCookie = (head.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  assert.equal((await ask(headCookie, { tool: "assets" })).status, 403, "head office session is not an email-code user");
  const ownerSession = await (async () => { await cred.writePassword(JOSHUA, PW); const r = await passwordFn(req("POST", "/api/identity/password/login", { body: { email: JOSHUA, password: PW } })); return cookieOf(r); })();
  assert.equal((await ask(ownerSession, { tool: "assets" })).status, 403, "the owner has everything and never asks");
  const cross = new Request("https://expresshelp.site/api/access-request", { method: "POST", headers: { origin: "https://evil.example", cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal((await requestFn(cross)).status, 403);
  assert.equal(asks().length, before);
});

test("rate limits: 1 per tool per hour (and the Request sent state persists), 5 per day, hashes only", async () => {
  const email = "limited.rate@libertyretail.com.au";
  const cookie = await userWithSession(email, { warehouse: true });
  const status = async (tool) => (await (await requestFn(req("GET", "/api/access-request?tool=" + tool, { cookie }))).json());
  assert.deepEqual(await status("pos"), { sent: false });
  assert.equal((await ask(cookie, { tool: "pos" })).status, 200);
  const persisted = await status("pos");
  assert.equal(persisted.sent, true);
  const again = await ask(cookie, { tool: "pos", reason: "again" });
  assert.equal(again.status, 429);
  assert.equal((await again.json()).sent, true);
  assert.equal(asks().filter((m) => m.replyTo === email).length, 1);
  t += 61 * 60e3;
  assert.equal((await status("pos")).sent, false, "cooldown ended");
  assert.equal((await ask(cookie, { tool: "pos" })).status, 200);
  const codes = [];
  for (const tool of ["assets", "visitors", "tickets", "sites"]) codes.push((await ask(cookie, { tool })).status);
  assert.deepEqual(codes, [200, 200, 200, 429].slice(0, 4).map((c, i) => (i < 3 ? 200 : 429)));
  const keys = [...(await lib.rateStore().list({ prefix: "arq/" })).blobs.map((b) => b.key)].join("\n");
  assert.equal(/libertyretail|@|2001:db8/.test(keys), false);
  assert.ok(keys.includes("arq/d/") && keys.includes("arq/h/"));
  t += 25 * 3600e3;
  assert.equal((await ask(cookie, { tool: "sites" })).status, 200, "a new day");
});

test("mail trouble is a generic error, is not counted against the person, and sends nothing when mail is unavailable", async () => {
  const email = "limited.mail@libertyretail.com.au";
  const cookie = await userWithSession(email, { warehouse: true });
  mode = "failed";
  const failed = await ask(cookie, { tool: "assets" });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error, ar.REQUEST_FAILED);
  mode = "sent";
  assert.equal((await ask(cookie, { tool: "assets" })).status, 200, "the failed attempt did not use up the hour");
  mailLib.setMailTransport(null);
  const before = sent.length;
  assert.equal((await ask(cookie, { tool: "visitors" })).status, 503);
  assert.equal(sent.length, before);
  mailLib.setMailTransport(async (m) => { sent.push(m); return { status: mode, id: "mock" }; });
});

test("reason is trimmed to 500 characters and control characters are removed", () => {
  assert.equal(ar.cleanReason("x".repeat(900)).length, 500);
  assert.equal(ar.cleanReason("a\u0000b\u0007c\td"), "abc\td");
  assert.equal(ar.cleanReason(undefined), "");
});

test("menus: limited user sees granted tools and 'Other tools'; owner, head office and Entra are unchanged (static checks)", () => {
  const app = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  assert.match(html, /<details class="other-tools" id="other-tools"[^>]*hidden>\s*<summary[^>]*>[^]*?Other tools<\/span><\/summary>/);
  for (const needle of ["applyLimitedChrome", "restoreNav", "requestPage", "You don\\'t have access to ", "Request access", "Sending…", "/api/access-request", "request-sent", "maxlength=\"500\"", "state.userEdit = wanted", "get(\"edit\")"]) assert.ok(app.includes(needle), needle);
  // owner / head office / Entra: accessRoutes() stays null for them, so the full menu code path is used.
  assert.match(app, /if \(!a \|\| a\.kind !== "verified-identity" \|\| a\.provider !== "otp" \|\| a\.owner\) return null;/);
  // the sidebar highlight now covers the Other tools list too
  assert.match(app, /document\.querySelectorAll\("#sidebar \[data-go\]"\)/);
});
