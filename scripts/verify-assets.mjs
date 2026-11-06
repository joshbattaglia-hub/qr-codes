import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "https://expresshelp.site";
const { start } = await import("./dev-server.mjs");
const server = await start(8916);
const base = "http://127.0.0.1:8916";
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
  window.__revoked = [];
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => {
    window.__revoked.push(url);
    return revoke(url);
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest("a[download]");
    if (!link) return;
    const name = link.download;
    const href = link.href;
    fetch(href).then((res) => res.arrayBuffer()).then((buf) => {
      window.__downloads.push({ name, bytes: Array.from(new Uint8Array(buf)) });
    }).catch((err) => {
      window.__downloads.push({ name, error: String(err) });
    });
  }, true);
});

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitText(text) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout: 8000 }, text);
}
async function shot(name) {
  await page.evaluate(() => {
    document.getElementById("toast")?.classList.add("hidden");
    window.scrollTo(0, 0);
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: path.join("/opt/cursor/artifacts", name + ".png"), fullPage: true });
}

try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + "/admin#/assets", { waitUntil: "networkidle0" });
  await page.type("#pw", "liberty-dev");
  await page.click("#login-form button[type=submit]");
  await waitText("Asset Barcodes");
  await waitText("LOC50924");
  await waitText("Liberty Oil Convenience");
  await waitText("]A0");
  assert(page.url().endsWith("#/assets"), page.url());
  const svg = await page.$eval("[data-testid=asset-barcode] svg", (el) => el.outerHTML);
  assert(svg.includes('fill="#fff"'), "missing white field");
  assert(svg.includes('fill="#000"'), "missing black bars");
  assert(!svg.includes("#1f4bdb") && !svg.includes("]A0"), svg.slice(0, 180));
  assert(svg.includes(">LOC50924<"), "human text is not the payload");
  await shot("asset-desktop");

  await page.click("[data-testid=asset-heading]", { clickCount: 3 });
  await page.type("[data-testid=asset-heading]", "Tank 4");
  await page.click("[data-testid=asset-id]", { clickCount: 3 });
  await page.type("[data-testid=asset-id]", "TEST-1");
  await waitText("TEST-1");
  const edited = await page.$eval("[data-testid=asset-barcode] svg", (el) => el.outerHTML);
  assert(edited.includes(">TEST-1<"), "edit did not redraw");
  assert(edited.includes(">Tank 4<"), "heading did not redraw");
  await shot("asset-desktop-edit");

  await page.click("[data-testid=asset-id]", { clickCount: 3 });
  await page.type("[data-testid=asset-id]", "loc50924");
  await waitText("Lower-case");
  await shot("asset-desktop-lowercase");
  await page.click("#asset-form input[name=uppercase]");
  await waitText("Encoded LOC50924");
  await page.click("#asset-form input[name=uppercase]");
  await page.click("[data-testid=asset-id]", { clickCount: 3 });
  await page.type("[data-testid=asset-id]", "LOC50924");
  await page.waitForSelector("[data-testid=asset-barcode] svg");

  await page.type("[data-testid=asset-batch]", "LOC50924\n\nA\nTEST-1");
  await waitText("TEST-1");
  await page.waitForSelector("[data-testid=asset-batch]");
  await shot("asset-desktop-batch");

  await page.$eval("[name=labelWidthMm]", (el) => { el.value = "20"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await waitText("not shrunk");
  const wide = await page.$eval("[data-testid=asset-barcode] svg rect[fill='#000']", (el) => el.getAttribute("width"));
  assert(Number(wide) >= 0.33, "bars were shrunk: " + wide);
  await shot("asset-desktop-overflow");
  await page.$eval("[name=labelWidthMm]", (el) => { el.value = "90"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForFunction(() => !document.body.innerText.includes("not shrunk"));

  await page.evaluate(() => {
    const write = navigator.clipboard && navigator.clipboard.writeText;
    window.__write = write;
    if (navigator.clipboard) navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    document.execCommand = () => false;
  });
  await page.click("[data-act=asset-copy]");
  await waitText("Copy was blocked");
  const blocked = await page.$eval("[data-testid=asset-status]", (el) => el.textContent);
  assert(blocked.startsWith("Copy was blocked"), blocked);
  await shot("asset-copy-blocked");
  await page.evaluate(() => {
    if (navigator.clipboard) navigator.clipboard.writeText = async () => {};
  });
  await page.click("[data-act=asset-copy]");
  await waitText("SVG copied.");

  await page.click("[data-act=asset-download]");
  await page.waitForFunction(() => window.__downloads.some((item) => item.name && item.name.endsWith(".svg") && item.bytes));
  await page.click("[data-act=asset-zip]");
  await page.waitForFunction(() => window.__downloads.some((item) => item.name === "asset-barcodes.zip" && item.bytes));
  await new Promise((resolve) => setTimeout(resolve, 1700));
  const files = await page.evaluate(() => ({
    downloads: window.__downloads.map((item) => ({ name: item.name, size: item.bytes ? item.bytes.length : 0, error: item.error || "" })),
    revoked: window.__revoked.length,
  }));
  assert(files.downloads.some((item) => item.name.startsWith("asset-LOC50924") && item.size > 200), JSON.stringify(files));
  assert(files.downloads.some((item) => item.name === "asset-barcodes.zip" && item.size > 200), JSON.stringify(files));
  assert(files.revoked >= 2, JSON.stringify(files));
  const zipBytes = await page.evaluate(() => window.__downloads.find((item) => item.name === "asset-barcodes.zip").bytes);
  fs.writeFileSync("/tmp/asset-barcodes.zip", Buffer.from(zipBytes));

  await page.evaluate(() => {
    const frame = document.getElementById("asset-print-frame");
    if (frame && frame.contentWindow) {
      frame.contentWindow.print = () => { window.__printed = (frame.contentDocument.body || {}).innerText || ""; };
    }
  });
  await page.click("[data-act=asset-sheet]");
  await waitText("Print dialog opened");
  const printed = await page.evaluate(() => {
    const frame = document.getElementById("asset-print-frame");
    frame.style.cssText = "position:fixed;left:16px;top:70px;width:640px;height:780px;border:1px solid #1f4bdb;background:#fff;z-index:50";
    return frame.contentDocument.body.innerText;
  });
  assert(printed.includes("LOC50924") && printed.includes("TEST-1") && printed.includes("Tank 4"), printed);
  assert(!printed.includes("]A0"), printed);
  await shot("asset-print-sheet");
  await page.evaluate(() => {
    const frame = document.getElementById("asset-print-frame");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  });

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await shot("asset-mobile");
  const mobile = await page.evaluate(() => {
    const id = document.querySelector("[data-testid=asset-id]");
    const heading = document.querySelector("#asset-page h1");
    const pageBox = document.querySelector("#asset-page").getBoundingClientRect();
    const box = id.getBoundingClientRect();
    return { width: document.documentElement.clientWidth, id: box.width, heading: heading.textContent, pageWidth: pageBox.width };
  });
  assert(mobile.width === 390, JSON.stringify(mobile));
  assert(mobile.heading === "Asset Barcodes", mobile.heading);
  assert(mobile.id > 200 && mobile.id < 390, JSON.stringify(mobile));
  assert(mobile.pageWidth <= 390, JSON.stringify(mobile));
  await page.click("#menu-btn");
  await page.waitForSelector("#nav [data-go=assets].active");
  await shot("asset-mobile-nav");

  assert(errors.length === 0, errors.join("\n"));
  console.log("asset ui ok", JSON.stringify(files));
} finally {
  await browser.close();
  server.close();
}
