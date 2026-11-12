import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("../public/", import.meta.url).pathname;
function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith(".html") ? [full] : [];
  });
}

test("every static HTML page loads the shared footer (future pages fail this test until they do)", () => {
  const files = htmlFiles(root);
  assert.ok(files.length >= 7);
  for (const file of files) assert.match(fs.readFileSync(file, "utf8"), /<script src="\/footer\.js" defer><\/script>/, file);
});

test("footer text, emoji code points and mailto are exact in both the script and the server helper", async () => {
  const script = fs.readFileSync(path.join(root, "footer.js"), "utf8");
  assert.match(script, /"Built, not bought, by J\.Batt "/);
  assert.match(script, /"\\u\{1F3CE\}\\uFE0E"/);
  assert.match(script, /" \\u2014 need changes\? "/);
  assert.match(script, /mailto:jbattaglia@libertyretail\.com\.au/);
  assert.match(script, /"email me here"/);
  assert.match(script, /Segoe UI Symbol/);
  const { footerHtml, FOOTER_CAR } = await import("../netlify/lib/footer.mjs");
  assert.deepEqual([...FOOTER_CAR].map((c) => c.codePointAt(0).toString(16)), ["1f3ce", "fe0e"]);
  const html = footerHtml();
  const text = html.replace(/<[^>]+>/g, "");
  assert.equal(text, "Built, not bought, by J.Batt \u{1F3CE}\uFE0E \u2014 need changes? email me here");
  assert.match(html, /<a href="mailto:jbattaglia@libertyretail\.com\.au"[^>]*>email me here<\/a>/);
  assert.match(html, /^<footer /);
});

test("server-rendered pages include the footer", async () => {
  process.env.PUBLIC_URL = "https://expresshelp.site";
  const lib = await import("../netlify/lib/lib.mjs");
  lib.setStoreFactory(lib.memoryBackend());
  const redirect = (await import("../netlify/functions/redirect.mjs")).default;
  const res = await redirect(new Request("https://expresshelp.site/r/nothing-here"), { params: { slug: "nothing-here" } });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /data-testid="eh-footer"/);
  assert.match(fs.readFileSync(new URL("../netlify/functions/pos-review.mjs", import.meta.url), "utf8"), /\$\{footerHtml\(\)\}/);
});

test("admin sign-in: Express Help, email code and password first, other ways below, no developer wording", () => {
  const html = fs.readFileSync(path.join(root, "admin/index.html"), "utf8");
  const login = html.slice(html.indexOf('<div id="login"'), html.indexOf('<div id="shell"'));
  assert.match(login, /<h1 id="signin-title">Express Help<\/h1>/);
  assert.equal(login.includes("Sign in to manage short links and QR codes."), false);
  const card = login.slice(login.indexOf('class="login-card signin-card"'), login.indexOf('class="signin-other"'));
  assert.ok(card.indexOf('id="otp-form"') > 0 && card.indexOf('id="login-form"') > card.indexOf('id="otp-form"'));
  const other = login.slice(login.indexOf('class="signin-other"'));
  assert.match(other, /Other ways to sign in/);
  assert.match(other, /id="identity-form"/);
  assert.match(other, /<div id="entra-card" class="signin-option" hidden>/);
  // Same ids/fields the sign-in code uses.
  for (const id of ["staff-email", "pw", "login-error", "otp-email", "otp-send", "otp-code-wrap", "otp-code", "otp-verify", "otp-status", "otp-error", "otp-setup", "entra-setup", "entra-signin", "ident-login", "ident-pw", "ident-error"]) assert.match(login, new RegExp('id="' + id + '"'), id);
  const app = fs.readFileSync(path.join(root, "admin/app.js"), "utf8");
  const states = app.slice(app.indexOf("async function entraLoginState()"), app.indexOf("async function copyText("));
  for (const words of [/fixture/i, /not operational/i, /allowlist/i, /tenant/i, /object id/i, /Local /, /mock/i]) {
    assert.equal(words.test(login.replace(/data-testid="[^"]*"/g, "")), false, String(words));
    assert.equal(words.test(states.replace(/\/\/[^\n]*/g, "").replace(/const mock[^\n]*\n/, "").replace(/if \(mock\)[^\n]*\n/, "")), false, String(words));
  }
  assert.match(states, /if \(card\) card\.hidden = true;/);
});

test("admin sign-in is centred on the page (card contents stay left-aligned)", () => {
  const css = fs.readFileSync(path.join(root, "admin/styles.css"), "utf8");
  assert.match(css, /\.signin\{[^}]*margin:0 auto[^}]*text-align:left/);
  assert.match(css, /\.signin-brand\{[^}]*justify-content:center/);
  assert.match(css, /\.signin-other h2\{[^}]*text-align:center/);
  assert.doesNotMatch(css, /7vw/);
});

test("every 'Sign in with email' button ends the session and opens the email-code sign-in", () => {
  const app = fs.readFileSync(path.join(root, "admin/app.js"), "utf8");
  const tickets = fs.readFileSync(path.join(root, "admin/tickets-ui.mjs"), "utf8");
  // Shared button used by Visitor log, Users and Support restricted cards.
  assert.match(app, /const EMAIL_SIGNIN_BUTTON = '<button[^']*data-act="email-signin"/);
  assert.match(app, /function visitorDenied\(\)[\s\S]{0,300}EMAIL_SIGNIN_BUTTON/);
  assert.match(app, /data-testid="users-denied"[\s\S]{0,200}EMAIL_SIGNIN_BUTTON/);
  assert.match(tickets, /function denied\(\)[\s\S]{0,500}data-act="email-signin"/);
  // The body click handler handles it before the per-page dispatchers (which swallowed it before).
  const click = app.slice(app.indexOf('document.body.addEventListener("click"'));
  const handled = click.indexOf('actEl.dataset.act === "email-signin"');
  assert.ok(handled > 0 && handled < click.indexOf('actEl.closest("#ticket-page")') && handled < click.indexOf('actEl.closest("#visitor-page")') && handled < click.indexOf('actEl.closest("#users-page")'));
  // Logout endpoint, then the sign-in with the email field focused.
  assert.match(app, /async function switchToEmailSignin\(\)[\s\S]{0,200}fetch\("\/api\/auth", \{ method: "DELETE"[\s\S]{0,300}showLogin\("", true\)/);
  assert.match(app, /getElementById\("otp-email"\)[\s\S]{0,80}focus\(\)/);
});

test("admin header and home page say Express Help", () => {
  const app = fs.readFileSync(path.join(root, "admin/app.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "admin/index.html"), "utf8");
  const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(admin, /<span id="brand-name">Express Help<\/span>/);
  assert.doesNotMatch(app, /brand-name"\)\.textContent = (state\.settings|"Liberty")/);
  assert.match(home, /<h1[^>]*>Express Help<\/h1>/);
  assert.match(home, /<title>Express Help<\/title>/);
});
