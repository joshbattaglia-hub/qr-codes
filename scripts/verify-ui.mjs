import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.PORT = "8899";
const { start } = await import("./dev-server.mjs");
const server = await start(8899);
const base = "http://127.0.0.1:8899";
const shots = "/tmp/liberty-shots";
const downloads = "/tmp/liberty-dl";
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("response", (res) => { if (res.status() >= 400) errors.push(res.status() + " " + res.url()); });
await page.setViewport({ width: 1440, height: 1100 });
await page.evaluateOnNewDocument(() => {
  window.__downloads = [];
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[download]");
    if (!a) return;
    fetch(a.href).then((r) => r.blob()).then((blob) => {
      const reader = new FileReader();
      reader.onload = () => window.__downloads.push({ name: a.download, dataUrl: reader.result });
      reader.readAsDataURL(blob);
    });
  }, true);
});

const shot = async (name) => {
  const file = path.join(shots, name + ".png");
  await page.screenshot({ path: file, fullPage: true });
  fs.copyFileSync(file, path.join("/opt/cursor/artifacts", name + ".png"));
};
async function bodyText() { return page.evaluate(() => document.body.innerText); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitText(text, ms = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: ms }, text);
}

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

try {
  await page.goto(base + "/admin", { waitUntil: "networkidle0" });
  await waitText("Sign in");
  await page.type("#pw", "wrong-password");
  await page.click("#login-form button[type=submit]");
  await waitText("Invalid password");
  await shot("01-login");

  await page.$eval("#pw", (el) => { el.value = ""; });
  await page.type("#pw", "liberty-dev");
  await page.click("#login-form button[type=submit]");
  await waitText("Quick create: QR Code");
  await waitText("Also create a link for this QR Code");
  await waitText("Link clicks");
  await waitText("QR Code scans");
  await waitText("Page clicks");
  const nav = await bodyText();
  for (const label of ["Home", "Links", "QR Codes", "Pages", "Analytics", "Competitions", "Custom domains", "Settings", "Create new"]) {
    assert(nav.includes(label), "missing nav " + label);
  }
  assert(!nav.includes("Integrations"), "Integrations nav should be gone");
  assert(await page.$("#nav [data-go=integrations]") === null, "Integrations nav button still present");
  assert(!nav.includes("Bitly") && !nav.toLowerCase().includes("upgrade"), "trademark or upgrade copy leaked");

  await page.type("#dest-url", "https://example.com/keep-me");
  await page.click("[data-act=mode][data-mode=link]");
  await waitText("Quick create: Short link");
  const kept = await page.$eval("#dest-url", (el) => el.value);
  assert(kept === "https://example.com/keep-me", "toggle cleared the URL");
  await page.click("[data-act=mode][data-mode=qr]");
  await waitText("Also create a link for this QR Code");
  await page.$eval("#dest-url", (el) => { el.value = ""; });
  await page.type("#dest-url", "https://www.libertyconvention.com.au/24xpress-help/");
  await page.click("#also-link");
  await page.click("#create-form button[type=submit]");
  await waitText("Scan destination");
  await waitText("Website / URL");
  await waitText("Dynamic routing");
  await waitText("Code analytics");
  await waitText("Total scans");
  await waitText("Scans by location");
  await waitText("Scans by browser");
  await waitText("Scans by operating system");
  await waitText("No tags");
  const slug = await page.evaluate(() => location.hash.split("/")[2]);
  assert(slug && slug.length > 2, "missing slug");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC", "base64");
  fs.writeFileSync("/tmp/logo.png", png);
  await page.click("[data-act=customize]");
  await page.waitForSelector("#c-fg");
  await page.$eval("#c-fg", (el) => { el.value = "#123456"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.$eval("#c-bg", (el) => { el.value = "#f4efe6"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  const fileEl = await page.$("#c-file");
  await fileEl.uploadFile("/tmp/logo.png");
  await page.waitForFunction(() => document.querySelector("#c-logo-data")?.value.startsWith("data:image/png"));
  await page.click("#modal button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#modal") || document.querySelector("#modal").classList.contains("hidden") || !document.querySelector("#c-fg"));
  await waitText("Customization saved");
  const fill = await page.$eval("[data-testid=qr-preview] svg path", (el) => el.getAttribute("fill"));
  const bg = await page.$eval("[data-testid=qr-preview] svg rect", (el) => el.getAttribute("fill"));
  assert(fill === "#123456", "fg not saved: " + fill);
  assert(bg === "#f4efe6", "bg not saved: " + bg);
  const hasImage = await page.$("[data-testid=qr-preview] svg image");
  assert(hasImage, "logo missing from preview");

  await page.type("input[name=tag]", "Help desk");
  await page.click("form[data-act=add-tag] button");
  await waitText("Help desk");

  await page.click("[data-testid=qr-details] [data-act=edit]");
  await page.waitForSelector("form[data-act=save-edit] input[name=name]");
  await page.$eval("form[data-act=save-edit] input[name=name]", (el) => { el.value = "24Xpress Help Page"; });
  await page.click("form[data-act=save-edit] button[type=submit]");
  await waitText("24Xpress Help Page");

  await page.click("[data-act=toggle-rule]");
  await page.select("#rule-device", "ios");
  await page.type("#rule-url", "https://example.com/ios-help");
  await page.click("#rule-form button[type=submit]");
  await waitText("https://example.com/ios-help");

  async function hit(ua, qr, geo) {
    const res = await fetch(base + "/r/" + slug + (qr ? "?qr=1" : "") + (geo ? "&_geo=" + geo : ""), { redirect: "manual", headers: { "user-agent": ua } });
    return { status: res.status, location: res.headers.get("location") };
  }
  const ios = await hit(iphone, true);
  assert(ios.status === 302 && ios.location === "https://example.com/ios-help", JSON.stringify(ios));
  assert((await hit(iphone, true)).location === "https://example.com/ios-help");
  const and = await hit(android, true);
  assert(and.location === "https://www.libertyconvention.com.au/24xpress-help/", JSON.stringify(and));
  const click = await hit(desktop, false);
  assert(click.location === "https://www.libertyconvention.com.au/24xpress-help/", JSON.stringify(click));
  const us = await hit(desktop, true, "US");
  assert(us.location === "https://www.libertyconvention.com.au/24xpress-help/", JSON.stringify(us));

  await page.reload({ waitUntil: "networkidle0" });
  await waitText("24Xpress Help Page");
  await page.waitForFunction(() => {
    const boxes = [...document.querySelectorAll(".stat-box")].map((el) => el.innerText);
    return boxes[0] && boxes[0].includes("Total scans") && boxes[0].includes("3") && boxes[1] && boxes[1].includes("4");
  }, { timeout: 8000 }).catch(async () => {
    const boxes = await page.$$eval(".stat-box", (els) => els.map((el) => el.innerText));
    throw new Error("unexpected stat boxes: " + JSON.stringify(boxes));
  });
  const boxes = await page.$$eval(".stat-box", (els) => els.map((el) => el.innerText));
  assert(boxes[0].includes("Total scans") && boxes[0].includes("Unique") && boxes[0].includes("3"), JSON.stringify(boxes));
  assert(boxes[1].includes("Scans") && boxes[1].includes("Total") && boxes[1].includes("4"), JSON.stringify(boxes));
  const tables = await bodyText();
  assert(tables.includes("Australia"), "missing country");
  assert(tables.includes("Safari") && tables.includes("Chrome"), "missing browsers");
  assert(tables.includes("iOS") && tables.includes("Android"), "missing OS");
  await page.click("[data-act=loc-tab][data-tab=cities]");
  await waitText("Sydney, NSW");
  await shot("02-qr-detail");

  await page.evaluate(() => { window.__downloads = []; document.querySelector(".toolbar [data-act=dl-csv]").click(); });
  const csvUrl = await waitDownload(".csv");
  const csv = Buffer.from(csvUrl.split(",")[1], "base64").toString("utf8");
  assert(csv.includes("unique_scans,3"), csv);
  assert(csv.includes("total_scans,4"), csv);
  assert(csv.includes("Safari"), csv);
  assert(csv.includes("Australia") || csv.includes("AU"), csv);

  await page.evaluate(() => { window.__downloads = []; document.querySelector("[data-act=toggle-menu][data-menu=download]").click(); });
  await page.evaluate(() => document.querySelector("#menu-download [data-act=dl-png]").click());
  const pngUrl = await waitDownload(".png");
  const pngBytes = Buffer.from(pngUrl.split(",")[1], "base64");
  assert(pngBytes.subarray(0, 8).toString("hex").startsWith("89504e47"), "png magic");

  await page.evaluate(() => { window.__downloads = []; document.querySelector("[data-act=toggle-menu][data-menu=download]").click(); });
  await page.evaluate(() => document.querySelector("#menu-download [data-act=dl-svg]").click());
  const svgUrl = await waitDownload(".svg");
  const svg = Buffer.from(svgUrl.split(",")[1], "base64").toString("utf8");
  assert(svg.includes('fill="#123456"') && svg.includes("image"), svg.slice(0, 240));

  await page.click("a[href='#/links/" + slug + "']");
  await waitText("Link analytics");
  await waitText("Total clicks");
  const linkBoxes = await page.$$eval(".stat-box", (els) => els.map((el) => el.innerText));
  assert(linkBoxes[0].includes("1") && linkBoxes[1].includes("1"), JSON.stringify(linkBoxes));
  await shot("03-link-detail");

  await page.click("#nav [data-go=home]");
  await waitText("Total engagements");
  const home = await bodyText();
  assert(home.includes("QR Code scans"), home.slice(0, 500));
  await shot("04-home");

  await page.click("[data-go=analytics]");
  await waitText("Top QR codes");
  await waitText("By operating system");
  await shot("05-analytics");

  await page.click("[data-go=qrcodes]");
  await waitText("24Xpress Help Page");
  await page.click("[data-go=links]");
  await waitText("24Xpress Help Page");
  await page.click("#nav [data-go=pages]");
  await waitText("Create page");
  await page.click("[data-go='pages/new']");
  await waitText("Form");
  await page.type("#page-editor [name=name]", "Open day");
  await page.type("#page-editor [name=heading]", "Welcome aboard");
  await page.click("#page-editor button[type=submit]");
  await waitText("/p/");
  const pageUrl = await page.$eval("[data-testid=page-url]", (el) => el.textContent.trim());
  await page.click("[data-act=publish-page]");
  await waitText("Published");
  await page.click("[data-act=page-link]");
  await waitText("View short link");
  const publicPath = new URL(pageUrl).pathname;
  const published = await fetch(base + publicPath);
  assert(published.status === 200, "published page status " + published.status);
  assert((await published.text()).includes("Welcome aboard"), "public page missing heading");
  const submitted = await fetch(base + publicPath, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
  });
  assert(submitted.status === 200, "submit status " + submitted.status);
  await page.reload({ waitUntil: "networkidle0" });
  await waitText("ada@example.com");
  await page.click("#nav [data-go=home]");
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-testid=page-clicks]");
    return el && !el.textContent.includes("—") && Number.parseInt(el.textContent, 10) >= 1;
  });
  await page.click("#nav [data-go=competitions]");
  await waitText("No competitions yet");
  await page.click("[data-go='competitions/new']");
  await waitText("Entry form");
  await page.type("#comp-editor [name=name]", "Lansvale Free Fuel");
  await page.select("#comp-editor [name=status]", "active");
  await page.click("#comp-editor button[type=submit]");
  await waitText("/c/");
  const compUrl = await page.$eval("[data-testid=comp-url]", (el) => el.textContent.trim());
  await waitText("View short link");
  const compPath = new URL(compUrl).pathname;
  const compPage = await fetch(base + compPath + "?qr=1");
  const compHtml = await compPage.text();
  assert(compPage.status === 200, "competition page " + compPage.status);
  assert(compHtml.includes("<form") && compHtml.includes('name="name"') && compHtml.includes('name="email"'), "entry form missing");
  const entered = await fetch(base + compPath, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: "Ada", email: "ada@example.com", phone: "0412000111", receipt: "RCP-1", over18: "yes", consent: "yes" }),
  });
  const enteredBody = await entered.json();
  assert(entered.status === 200 && enteredBody.status === "valid", JSON.stringify(enteredBody));
  const duplicate = await fetch(base + compPath, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: "Ada", email: "ada@example.com", phone: "0412000222", receipt: "RCP-2", over18: "yes", consent: "yes" }),
  });
  const duplicateBody = await duplicate.json();
  assert(duplicateBody.status === "duplicate", JSON.stringify(duplicateBody));
  await page.reload({ waitUntil: "networkidle0" });
  await waitText("Ada");
  await page.click("#nav [data-go=home]");
  await waitText("Draw reminders");
  await shot("17-reminders");
  await page.goto(base + "/admin#/competitions/" + compPath.split("/").pop(), { waitUntil: "networkidle0" });
  await waitText("Ada");
  await page.evaluate(() => document.querySelector("[data-act=confirm-draw]") || document.querySelector("[data-act=comp-draw]").click());
  if (!await page.$("[data-act=confirm-draw]")) await page.click("[data-act=comp-draw]");
  await page.click("[data-act=confirm-draw]");
  await waitText("Winners");
  await waitText("Draw 1");
  await page.click("[data-go=domains]");
  await waitText("expresshelp.site");
  await page.click("[data-go=settings]");
  await waitText("ADMIN_PASSWORD");
  await waitText("Staff");
  await shot("06-settings");

  await page.click("[data-go=sites]");
  await waitText("New location");
  await page.type("[data-testid=create-site] input[name=name]", "QA Yard");
  await page.click("[data-testid=create-site] button[type=submit]");
  await waitText("QA Yard");
  await shot("09-sites-desktop");
  const compSlug = compPath.split("/").pop();
  await page.goto(base + "/admin#/competitions/" + compSlug, { waitUntil: "networkidle0" });
  await waitText("Poster, template, and copy");
  await waitText("Enable a single-use voucher");
  const voucherOff = await page.$eval("[name=voucherEnabled]", (el) => el.checked);
  assert(voucherOff === false, "voucher should stay off");
  await shot("10-competition-tools");
  await page.click("[data-act=winner-notice]");
  await waitText("has not been sent");
  await waitText("Review only");
  const notice = await page.$eval("[data-testid=notice-text]", (el) => el.textContent);
  assert(notice.includes("Ada"), "notice should use the recorded name");
  assert(!notice.toLowerCase().includes("mailto:"), "notice should not send mail");
  await shot("11-winner-notice");
  const sessionCookie = (await page.cookies()).map((c) => c.name + "=" + c.value).join("; ");
  const poster = await fetch(base + "/api/competitions/" + compSlug + "/poster?size=a4", { headers: { cookie: sessionCookie } });
  const posterHtml = await poster.text();
  assert(poster.status === 200, "poster " + poster.status);
  assert(posterHtml.includes("https://expresshelp.site/c/" + compSlug), "poster QR target missing");
  await page.evaluate(async () => {
    const response = await fetch("/api/codes", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1/health", type: "link", slug: "health-qa", name: "Health sample" }) });
    if (!response.ok) throw new Error("health sample " + response.status);
  });
  fs.writeFileSync("/tmp/poster-a4.html", posterHtml);
  await page.goto("file:///tmp/poster-a4.html", { waitUntil: "load" });
  await shot("12-poster-a4");
  const posterA3 = await fetch(base + "/api/competitions/" + compSlug + "/poster?size=a3", { headers: { cookie: sessionCookie } });
  const posterA3Html = await posterA3.text();
  assert(posterA3.status === 200 && posterA3Html.includes("A3") && posterA3Html.includes("https://expresshelp.site/c/" + compSlug), "A3 poster missing");
  fs.writeFileSync("/tmp/poster-a3.html", posterA3Html);
  await page.goto("file:///tmp/poster-a3.html", { waitUntil: "load" });
  await shot("18-poster-a3");
  await page.goto(base + "/admin#/links/health-qa", { waitUntil: "domcontentloaded" });
  await page.click("[data-act=check-link]");
  await waitText("Checked:");
  await waitText("unknown");
  await shot("13-link-health");

  await page.goto(base + "/admin#/qrcodes/" + slug, { waitUntil: "networkidle0" });
  await waitText("24Xpress Help Page");
  await page.click("[data-act=toggle-menu][data-menu=more]");
  await page.click("[data-act=pause]");
  await waitText("Paused");
  const paused = await hit(desktop, true);
  assert(paused.status === 404, "pause did not stop redirect " + paused.status);
  await page.click("[data-act=toggle-menu][data-menu=more]");
  await page.click("[data-act=pause]");
  await page.waitForFunction(() => !document.body.innerText.includes("Paused"));
  const resumed = await hit(android, true);
  assert(resumed.status === 302, "resume failed");

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => { location.hash = "#/home"; });
  await waitText("Quick create");
  const sidebarHidden = await page.$eval("#sidebar", (el) => getComputedStyle(el).transform !== "none");
  assert(sidebarHidden, "sidebar should be off-canvas on mobile");
  const menuBox = await page.$eval("#menu-btn", (el) => {
    const r = el.getBoundingClientRect();
    return { display: getComputedStyle(el).display, w: r.width, h: r.height, x: r.x, y: r.y };
  });
  if (menuBox.display === "none" || menuBox.w < 8) throw new Error("menu button not visible " + JSON.stringify(menuBox));
  await page.evaluate(() => document.querySelector("#menu-btn").click());
  await page.waitForFunction(() => document.querySelector("#sidebar").classList.contains("open"));
  await new Promise((r) => setTimeout(r, 350));
  await shot("07-mobile-menu");
  await page.evaluate(() => document.querySelector("#overlay").click());
  await new Promise((r) => setTimeout(r, 350));
  await shot("08-mobile-home");
  await page.evaluate(() => { location.hash = "#/sites"; });
  await waitText("QA Yard");
  await shot("14-sites-mobile");
  await page.evaluate((id) => { location.hash = "#/competitions/" + id; }, compSlug);
  await waitText("Poster, template, and copy");
  await shot("15-competition-mobile");
  await page.goto(base + compPath + "?qr=1", { waitUntil: "networkidle0" });
  await page.waitForSelector("form");
  await shot("16-public-entry-mobile");

  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(base + "/admin#/qrcodes/" + slug, { waitUntil: "networkidle0" });
  await waitText("24Xpress Help Page");
  await page.click("[data-act=toggle-menu][data-menu=more]");
  await page.click("[data-act=del]");
  await page.click("[data-act=confirm-del]");
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent.trim() === "QR Codes");
  const afterDelete = await bodyText();
  assert(!afterDelete.includes("24Xpress Help Page"), "deleted code still listed");
  const gone = await hit(desktop, true);
  assert(gone.status === 404, "deleted code still redirects");

  const jar = (await page.cookies()).map((c) => c.name + "=" + c.value).join("; ");
  const north = await fetch(base + "/api/sites", { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: JSON.stringify({ name: "North office" }) });
  const northBody = await north.json();
  const south = await fetch(base + "/api/sites", { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: JSON.stringify({ name: "South office" }) });
  const southBody = await south.json();
  assert(north.ok && south.ok, "sites for manager check");
  const managerPassword = "manager-local-pass";
  const createdManager = await fetch(base + "/api/staff", { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: JSON.stringify({ name: "North manager", email: "north.manager@example.com", password: managerPassword, siteIds: [northBody.id] }) });
  assert(createdManager.ok, "manager create " + createdManager.status);
  await fetch(base + "/api/competitions", { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: JSON.stringify({ name: "South only", slug: "south-only", status: "active", siteId: southBody.id }) });
  const managerContext = await browser.createBrowserContext();
  const managerPage = await managerContext.newPage();
  const managerStatuses = [];
  managerPage.on("response", (res) => { if (res.status() >= 400) managerStatuses.push(res.status() + " " + res.url()); });
  await managerPage.setViewport({ width: 390, height: 844 });
  await managerPage.goto(base + "/admin", { waitUntil: "networkidle0" });
  await managerPage.waitForSelector("#staff-email");
  await managerPage.type("#staff-email", "north.manager@example.com");
  await managerPage.type("#pw", managerPassword);
  await managerPage.click("#login-form button[type=submit]");
  try {
    await managerPage.waitForFunction(() => document.body.innerText.includes("Your sites"), { timeout: 8000 });
  } catch (err) {
    const text = await managerPage.evaluate(() => document.body.innerText.slice(0, 500));
    throw new Error("manager login did not open the home screen: " + text + " | " + managerStatuses.join(", "));
  }
  const managerHome = await managerPage.evaluate(() => document.body.innerText);
  assert(!managerHome.includes("South only"), "manager home shows another site");
  assert(!managerHome.includes("Staff"), "manager home shows staff tools");
  await managerPage.screenshot({ path: "/opt/cursor/artifacts/19-manager-mobile.png", fullPage: true });
  await managerPage.setViewport({ width: 1440, height: 1100 });
  await managerPage.evaluate(() => { location.hash = "#/settings"; });
  await managerPage.waitForFunction(() => document.body.innerText.includes("Workspace name"), { timeout: 8000 });
  assert(await managerPage.$("[data-testid=staff-editor]") === null, "manager can see the staff editor");
  await managerPage.screenshot({ path: "/opt/cursor/artifacts/20-manager-settings.png", fullPage: true });
  await managerPage.evaluate(() => { location.hash = "#/sites"; });
  await managerPage.waitForFunction(() => document.body.innerText.includes("North office"), { timeout: 8000 });
  const sitesText = await managerPage.evaluate(() => document.body.innerText);
  assert(!sitesText.includes("Add site"), "manager can create sites");
  assert(!sitesText.includes("South office"), "manager sees the other site");
  await managerPage.screenshot({ path: "/opt/cursor/artifacts/21-manager-sites.png", fullPage: true });
  await managerPage.goto(base + "/admin#/competitions/south-only", { waitUntil: "domcontentloaded" });
  await managerPage.waitForFunction(() => document.body.innerText.includes("Forbidden") || document.body.innerText.includes("Not found"), { timeout: 8000 });
  await managerContext.close();

  const realErrors = errors.filter((e) => !e.includes("401") && !e.includes("favicon.ico") && !e.startsWith("Failed to load resource"));
  if (realErrors.length) throw new Error("console errors:\n" + realErrors.join("\n"));
  console.log("UI verification passed");
} catch (err) {
  await shot("failure").catch(() => {});
  console.error(errors);
  throw err;
} finally {
  await browser.close();
  server.close();
}

function waitDownload(ext) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      page.evaluate((suffix) => (window.__downloads || []).find((d) => d.name.endsWith(suffix))?.dataUrl || "", ext).then((url) => {
        if (url) return resolve(url);
        if (Date.now() - start > 8000) {
          page.evaluate(() => ({
            hooked: !!window.__downloads,
            n: (window.__downloads || []).length,
            names: (window.__downloads || []).map((d) => d.name),
            buttons: [...document.querySelectorAll("[data-act=dl-csv], [data-act=dl-png], [data-act=dl-svg]")].map((b) => b.className + ":" + b.textContent + ":hidden=" + (b.offsetParent === null)),
          })).then((info) => reject(new Error("timed out waiting for download " + ext + " " + JSON.stringify(info)))).catch(reject);
          return;
        }
        setTimeout(tick, 100);
      }).catch(reject);
    };
    tick();
  });
}
