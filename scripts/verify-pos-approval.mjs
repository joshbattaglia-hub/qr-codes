import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.IDENTITY_BIND_TOKEN = "fixture-bind-token-value";
process.env.IDENTITY_SESSION_SECRET = "fixture-session-secret-value";
process.env.ALLOW_FIXTURE_IDENTITY_BIND = "1";
process.env.POS_MAIL_MOCK = "1";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
fs.writeFileSync("/tmp/pos-mail-mock.jsonl", "");
const { start } = await import("./dev-server.mjs");
const server = await start(8902);
const base = "http://127.0.0.1:8902";
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
const browser = await puppeteer.launch({ executablePath: "/usr/local/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitText(text) { await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 8000 }, text); }
async function shot(name) {
  await page.evaluate(() => { document.getElementById("toast")?.classList.add("hidden"); document.documentElement.scrollLeft = 0; });
  await page.screenshot({ path: path.join("/opt/cursor/artifacts", name + ".png"), fullPage: false });
}
async function loginIdentity(login, password) {
  await page.goto(base + "/admin", { waitUntil: "networkidle0" });
  const result = await page.evaluate(async (login, password) => {
    const res = await fetch("/api/identity/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ login, password }) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }, login, password);
  if (result.status !== 200) throw new Error(JSON.stringify(result));
  await page.reload({ waitUntil: "networkidle0" });
  await waitText("POS setup");
}

try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + "/admin", { waitUntil: "networkidle0" });
  await page.type("#pw", "liberty-dev");
  await page.click("#login-form button[type=submit]");
  await waitText("Create QR code");
  const ids = await page.evaluate(async () => {
    const site = await (await fetch("/api/sites", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mail Fixture" }) })).json();
    const headers = { "content-type": "application/json", "x-identity-bind-token": "fixture-bind-token-value" };
    const bind = (body) => fetch("/api/identity/bind", { method: "POST", credentials: "omit", headers, body: JSON.stringify(body) }).then((res) => res.json());
    const preparer = await bind({ kind: "preparer", preparerClass: "regional-business-manager", displayName: "Fixture RBM", contactEmail: "requester@fixture.test", password: "preparer-pass-1", siteIds: [site.id] });
    await bind({ kind: "approver", approverKey: "neil", password: "neil-pass-123", siteIds: [site.id] });
    await bind({ kind: "approver", approverKey: "joshua", password: "joshua-pass-123", siteIds: [site.id] });
    if (!preparer.identity?.id) throw new Error(JSON.stringify(preparer));
    return { preparer: preparer.identity.id, site: site.id };
  });
  await loginIdentity(ids.preparer, "preparer-pass-1");
  await page.click("#nav [data-go=pos]");
  await waitText("New draft");
  await page.click(".page-head [data-go='pos/new']");
  await waitText("Offer");
  await page.type("[name=offer]", "Mock approval fuel");
  await page.type("[name=conditions]", "Fixture conditions");
  await page.$eval("[name=start]", (el) => { el.value = "2026-11-01"; });
  await page.$eval("[name=end]", (el) => { el.value = "2026-11-30"; });
  await page.click("input[name=siteIds]");
  await page.click("[data-testid=pos-editor] button[type=submit]");
  await waitText("Send to Quickfuel is hidden");
  assert(await page.$("[data-testid=pos-quickfuel]") === null, "box shown on a draft");
  await shot("pos-mail-draft-desktop");
  await page.click("[data-act=pos-approval-request]");
  await waitText("local mail mock");
  await waitText("Send to Quickfuel is hidden");
  assert(await page.$("[data-testid=pos-quickfuel]") === null, "box shown while pending");
  const draftPath = await page.evaluate(() => location.hash);
  await shot("pos-mail-pending-desktop");
  const mail = fs.readFileSync("/tmp/pos-mail-mock.jsonl", "utf8");
  assert(mail.includes("nanderson@libertyretail.com.au"), "neil missing");
  assert(mail.includes("jbattaglia@libertyretail.com.au"), "joshua missing");
  assert(!mail.includes("support@quickfuel.com.au"), "quickfuel sent early");
  await loginIdentity("nanderson@libertyretail.com.au", "neil-pass-123");
  await page.goto(base + "/admin" + draftPath, { waitUntil: "networkidle0" });
  await waitText("Your decision");
  await page.click("[data-act=pos-approve]");
  await page.waitForSelector("[data-testid=pos-quickfuel]");
  await loginIdentity(ids.preparer, "preparer-pass-1");
  await page.goto(base + "/admin" + draftPath, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid=pos-quickfuel]");
  await waitText("support@quickfuel.com.au");
  await shot("pos-mail-approved-desktop");
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.evaluate(() => document.querySelector("[data-testid=pos-quickfuel]")?.scrollIntoView({ block: "center" }));
  await shot("pos-mail-approved-mobile");
  await page.setViewport({ width: 1280, height: 900 });
  await page.click("#pos-confirm-send");
  await page.click("[data-act=pos-send-quickfuel]");
  let after = "";
  for (let i = 0; i < 20 && !after.includes("support@quickfuel.com.au"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = fs.readFileSync("/tmp/pos-mail-mock.jsonl", "utf8");
  }
  assert(after.includes("support@quickfuel.com.au"), "quickfuel mock missing");
  assert(errors.filter((row) => !row.includes("favicon")).length === 0, errors.join("\n"));
  console.log("pos approval ui ok");
} finally {
  await browser.close();
  server.close();
}
