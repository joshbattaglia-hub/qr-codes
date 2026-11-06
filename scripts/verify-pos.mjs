import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "https://expresshelp.site";
const { start } = await import("./dev-server.mjs");
const server = await start(8901);
const base = "http://127.0.0.1:8901";
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
await page.evaluateOnNewDocument(() => {
  window.__downloads = [];
  document.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest("a[download]");
    if (!link) return;
    fetch(link.href).then((res) => res.arrayBuffer()).then((buf) => {
      window.__downloads.push({ name: link.download, bytes: Array.from(new Uint8Array(buf)) });
    });
  }, true);
});

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitText(text) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 8000 }, text);
}
async function shot(name, fullPage = true) {
  await page.evaluate(() => {
    document.getElementById("toast")?.classList.add("hidden");
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  });
  const file = path.join("/opt/cursor/artifacts", name + ".png");
  await page.screenshot({ path: file, fullPage });
}

try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + "/admin", { waitUntil: "networkidle0" });
  await page.type("#pw", "liberty-dev");
  await page.click("#login-form button[type=submit]");
  await waitText("Create QR code");
  const site = await page.evaluate(async () => {
    const res = await fetch("/api/sites", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fixture North" }) });
    return res.json();
  });
  assert(site.id, JSON.stringify(site));
  await page.reload({ waitUntil: "networkidle0" });
  await waitText("Create QR code");
  await page.click("#nav [data-go=pos]");
  await waitText("No POS drafts");
  await waitText("Quickfuel has not confirmed");
  await shot("pos-desktop-empty");
  await page.click("[data-go='pos/new']");
  await waitText("Save the draft to preview");
  await page.type("[name=offer]", "Fixture Saturday fuel");
  await page.type("[name=conditions]", "One fill at the fixture site");
  await page.$eval("[name=start]", (el) => { el.value = "2026-11-01"; });
  await page.$eval("[name=end]", (el) => { el.value = "2026-11-30"; });
  await page.click("input[name=siteIds][value='" + site.id + "']");
  await page.select("[name=posRedemption]", "single-use");
  await page.click("[data-testid=pos-editor] button[type=submit]");
  await page.waitForSelector("[data-testid=pos-barcode]");
  await waitText("Neil or Joshua may approve");
  await waitText("Draft / unapproved");
  await waitText("not published");
  await waitText("Email is not configured");
  await waitText("support@quickfuel.com.au");
  await page.waitForFunction(() => (document.querySelector("[name=codeValue]")?.value || "").startsWith("EH-POS-"));
  await page.waitForFunction(() => {
    const img = document.querySelector("[data-testid=pos-barcode]");
    return img && img.complete && img.naturalWidth > 40;
  });
  const preview = await page.$eval("[data-testid=pos-barcode]", (img) => img.naturalWidth);
  assert(preview > 40, "barcode did not render");
  await shot("pos-desktop-editor");
  await page.click("[data-act=pos-download]");
  await page.waitForFunction(() => window.__downloads.length === 1);
  const download = await page.evaluate(() => window.__downloads[0]);
  assert(download.name.startsWith("pos-setup-p"), download.name);
  assert(download.bytes[0] === 0x50 && download.bytes[1] === 0x4b, "zip signature");
  await page.$eval("[name=offer]", (el) => { el.value = ""; });
  await page.type("[name=offer]", "Fixture Sunday fuel");
  await page.click("[data-testid=pos-editor] button[type=submit]");
  await waitText("Fixture Sunday fuel");
  await page.click("[data-go=pos]");
  await waitText("Fixture Sunday fuel");
  await shot("pos-desktop-list");
  await page.click("#nav [data-go=sites]");
  await waitText("Import locations");
  await page.$eval("#import-rows", (el) => { el.value = JSON.stringify([{ loc: "LOC1", name: "Fixture North", address: "1 Fixture Street", operationalRegion: "North", geographicState: "", sourceRef: "fixture-1", hold: true, holdReason: "Held for review" }]); });
  await page.click("[data-testid=site-import] button[type=submit]");
  await waitText("held");
  await shot("pos-desktop-import");
  await page.click("#nav [data-go=pos]");
  await waitText("Fixture Sunday fuel");

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector("[data-testid=pos-list] tr.clickable").click());
  await page.waitForSelector("[data-testid=pos-barcode]");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await shot("pos-mobile-editor", false);
  await page.evaluate(() => document.querySelector("[data-testid=pos-barcode]")?.scrollIntoView({ block: "center" }));
  await shot("pos-mobile-preview", false);
  await page.click(".page-head [data-go=pos]");
  await waitText("Fixture Sunday fuel");
  await shot("pos-mobile-list", false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow < 24, "mobile page overflows by " + overflow);
  assert(errors.filter((row) => !row.includes("favicon")).length === 0, errors.join("\n"));
  console.log("pos ui ok");
} finally {
  await browser.close();
  server.close();
}
