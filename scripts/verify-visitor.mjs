import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import jpeg from "jpeg-js";

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "https://expresshelp.site";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.VISITOR_ACCESS_MAP;
delete process.env.VISITOR_SHEETS_SPREADSHEET_ID;

const { start } = await import("./dev-server.mjs");
const visitLib = await import("../netlify/lib/visitor-log.mjs");
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function shot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join("/opt/cursor/artifacts", name + ".png"), fullPage: true });
}

const server = await start(8920);
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8920/visit/sign-in", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Sign in is not open"));
  assert(!(await page.$("[data-testid=visit-receipt-input]")), "sign-in page has a receipt field");
  await page.goto("http://127.0.0.1:8920/visit/sign-out", { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid=visit-out-name]");
  assert(!(await page.$("[data-testid=visit-photo]")), "sign-out page has a photo field");
  assert(!(await page.$("[name=receipt]")), "sign-out page has a receipt field");
  assert((await page.$eval("[data-testid=visit-card]", (el) => el.checked)) === false, "card radio starts checked");
  await page.goto("http://127.0.0.1:8920/visit", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("The form is not open"));
  await page.waitForFunction(() => document.body.innerText.includes("90 days"));
  await shot(page, "visit-closed-desktop");
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await shot(page, "visit-closed-mobile");

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8920/admin", { waitUntil: "networkidle0" });
  await page.type("#pw", "liberty-dev");
  await page.click("#login-form button[type=submit]");
  await page.waitForFunction(() => document.body.innerText.includes("Visitor log"));
  await page.click("#nav [data-go=visitors]");
  await page.waitForFunction(() => document.body.innerText.includes("shared password"));
  await shot(page, "visitor-admin-denied-desktop");

  visitLib.setVisitorTestHooks({ collect: true });
  process.env.VISITOR_COLLECTION = "open";
  process.env.VISITOR_ACCESS_MAP = JSON.stringify({ joshuaOtp: true });
  process.env.VISITOR_SHEETS_SPREADSHEET_ID = "local-sheet";
  process.env.VISITOR_SHEETS_CLIENT_EMAIL = "visitor-log@example.iam.gserviceaccount.com";
  process.env.VISITOR_SHEETS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nlocal\n-----END PRIVATE KEY-----";
  const { setVisitorSheetFetch } = await import("../netlify/lib/visitor-sheet.mjs");
  setVisitorSheetFetch(async () => new Response(JSON.stringify({ values: [["visit_id"]], updates: { updatedRange: "Visits!A2:N2" }, access_token: "local", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8920/visit", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Sign in"));
  await page.evaluate(() => {
    const banner = document.createElement("p");
    banner.textContent = "Synthetic local test. Not a real visitor or ID.";
    banner.setAttribute("data-testid", "synthetic-banner");
    document.querySelector("main").prepend(banner);
  });
  await page.type("[data-testid=visit-location]", "Synthetic suburb");
  await page.type("[name=name]", "Synthetic Visitor");
  await page.type("[name=phone]", "0400000000");
  await page.type("[name=company]", "Synthetic Co");
  const wide = Buffer.alloc(64 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const i = (y * 64 + x) * 4;
      const left = x < 32;
      wide[i] = left ? 255 : 0;
      wide[i + 2] = left ? 0 : 255;
      wide[i + 3] = 255;
    }
  }
  const oriented = jpeg.encode({ data: wide, width: 64, height: 16 }, 90).data;
  const entry = Buffer.alloc(12);
  entry.writeUInt16LE(0x0112, 0);
  entry.writeUInt16LE(3, 2);
  entry.writeUInt32LE(1, 4);
  entry.writeUInt16LE(6, 8);
  const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00]), entry, Buffer.from([0, 0, 0, 0])]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  const turned = Buffer.concat([oriented.subarray(0, 2), app1, oriented.subarray(2)]);
  const big = jpeg.encode({ data: Buffer.alloc(2400 * 1800 * 4, 180), width: 2400, height: 1800 }, 90).data;
  const photo = jpeg.encode({ data: Buffer.alloc(4 * 4 * 4, 200), width: 4, height: 4 }, 80).data;
  const file = path.join("/tmp", "synthetic-id.jpg");
  fs.writeFileSync(file, photo);
  const bigFile = path.join("/tmp", "synthetic-large.jpg");
  const turnedFile = path.join("/tmp", "synthetic-turned.jpg");
  fs.writeFileSync(bigFile, big);
  fs.writeFileSync(turnedFile, turned);
  const boxes = await page.$$eval(".photo-action", (els) => els.map((el) => el.getBoundingClientRect().height));
  assert(boxes.length === 2 && boxes.every((height) => height >= 44), "chromium photo controls are smaller than 44px: " + boxes.join(","));
  const heic = path.join("/tmp", "synthetic-id.heic");
  fs.writeFileSync(heic, Buffer.concat([Buffer.from("....ftypheic"), Buffer.alloc(24)]));
  await page.waitForFunction(() => typeof window.visitorIdPhoto === "function");
  await (await page.$("[data-testid=visit-photo]")).uploadFile(heic);
  await page.waitForFunction(() => document.body.innerText.includes("This photo is HEIC"));
  assert((await page.$eval("#photo-preview", (el) => el.hidden)) === true, "HEIC preview was shown");
  await (await page.$("[data-testid=visit-photo]")).uploadFile(file);
  await page.waitForFunction(() => document.querySelector("#photo-preview") && !document.querySelector("#photo-preview").hidden);
  await shot(page, "visit-synthetic-form-mobile");
  await page.click("#in-form button[type=submit]");
  await page.waitForFunction(() => document.body.innerText.includes("Thanks for signing in"));
  await shot(page, "visit-synthetic-receipt-mobile");
  await page.type("[data-testid=visit-out-name]", "Synthetic Visitor");
  await page.type("[data-testid=visit-out-company]", "Synthetic Co");
  await page.click("[data-testid=visit-card]");
  await page.click("#out-form button[type=submit]");
  await page.waitForFunction(() => document.body.innerText.includes("Thanks, you’ve signed out"));
  await shot(page, "visit-synthetic-signed-out-mobile");
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8920/visit/sign-in", { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid=visit-form]");
  assert(!(await page.$("[data-testid=visit-receipt-input]")), "open sign-in page has a receipt field");
  await shot(page, "visit-sign-in-desktop");
  await page.setViewport({ width: 390, height: 844 });
  const signInBoxes = await page.$$eval(".photo-action", (els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  assert(signInBoxes.length === 2 && signInBoxes.every((height) => height >= 44), "sign-in photo controls: " + signInBoxes.join(","));
  const cameraCapture = await page.$eval("#photo-camera", (el) => el.getAttribute("capture"));
  const libraryCapture = await page.$eval("#photo-library", (el) => el.hasAttribute("capture"));
  assert(cameraCapture === "environment" && libraryCapture === false, "camera and library inputs are not separate");
  await shot(page, "visit-sign-in-mobile");
  await page.waitForFunction(() => typeof window.visitorIdPhoto === "function");
  await (await page.$("[data-testid=visit-photo]")).uploadFile(bigFile);
  await page.waitForFunction(() => document.body.innerText.includes("Photo ready."));
  const reduced = await page.evaluate(() => {
    const img = document.querySelector("#photo-preview");
    return { w: img.naturalWidth, h: img.naturalHeight, size: window.visitorIdPhoto().size, hidden: img.hidden };
  });
  assert(reduced.hidden === false && Math.max(reduced.w, reduced.h) <= 1600 && reduced.size > 0 && reduced.size <= 1_000_000, JSON.stringify(reduced));
  await page.evaluate(() => { document.getElementById("photo-note").textContent = ""; });
  await (await page.$("[data-testid=visit-photo]")).uploadFile(turnedFile);
  await page.waitForFunction(() => document.getElementById("photo-note").textContent.includes("Photo ready."));
  const turnedPixels = await page.evaluate(() => {
    const img = document.querySelector("#photo-preview");
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const top = ctx.getImageData(Math.floor(canvas.width / 2), 1, 1, 1).data;
    return { w: canvas.width, h: canvas.height, r: top[0], b: top[2] };
  });
  assert(turnedPixels.h > turnedPixels.w && turnedPixels.r > turnedPixels.b, JSON.stringify(turnedPixels));
  await page.type("[data-testid=visit-location]", "Synthetic route");
  await page.type("[name=name]", "Synthetic Route");
  await page.type("[name=phone]", "0400000001");
  await page.type("[name=company]", "Synthetic Co");
  await (await page.$("[data-testid=visit-photo]")).uploadFile(file);
  await page.click("#in-form button[type=submit]");
  await page.waitForFunction(() => document.body.innerText.includes("Thanks for signing in"));
  await page.waitForFunction(() => document.body.innerText.includes("Sign Out QR Code"));
  await page.goto("http://127.0.0.1:8920/visit/sign-out", { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid=visit-out-name]");
  assert(!(await page.$("[name=location]")), "sign-out page has a location field");
  assert((await page.$eval("[data-testid=visit-signed-out]", (el) => el.hidden)) === true, "sign-out success is visible before submit");
  await shot(page, "visit-sign-out-mobile");
  await page.setViewport({ width: 1280, height: 900 });
  await shot(page, "visit-sign-out-desktop");
  await page.type("[data-testid=visit-out-name]", "Synthetic Route");
  await page.type("[data-testid=visit-out-company]", "Synthetic Co");
  await page.click("[data-testid=visit-card]");
  await page.click("#out-form button[type=submit]");
  await page.waitForFunction(() => document.body.innerText.includes("Thanks, you’ve signed out"));
  process.env.OTP_SESSION_SECRET = "local-otp-session-secret-32-characters";
  process.env.OTP_ALLOWLIST = JSON.stringify({ "jbattaglia@libertyretail.com.au": { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] } });
  const otp = await import("../netlify/lib/otp.mjs");
  const inbox = [];
  otp.setOtpTestHooks({ deliver: async (message) => { inbox.push(message); return { status: "sent", id: "local-mock" }; } });
  const { visitorStore } = await import("../netlify/lib/lib.mjs");
  const stored = await visitorStore().list({ prefix: "visit/" });
  let record = null;
  for (const blob of stored.blobs) {
    const row = await visitorStore().get(blob.key, { type: "json" });
    if (row && row.location === "Synthetic suburb") record = row;
  }
  assert(record && record.id && record.cardReturned === true, "synthetic visit missing");
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8920/admin#/visitors/" + record.id, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("shared password"));
  await page.evaluate(() => fetch("/api/auth", { method: "DELETE", credentials: "same-origin" }));
  await page.goto("http://127.0.0.1:8920/admin", { waitUntil: "networkidle0" });
  await page.waitForSelector("#otp-email");
  await page.type("#otp-email", "jbattaglia@libertyretail.com.au");
  await page.click("#otp-send");
  await page.waitForSelector("#otp-code", { visible: true });
  const code = inbox.at(-1).text.match(/code is (\d{8})/)[1];
  await page.type("#otp-code", code);
  await page.click("#otp-verify");
  await page.waitForFunction(() => (document.querySelector("#account-label")?.textContent || "").includes("email code"));
  await page.goto("http://127.0.0.1:8920/admin#/visitors/" + record.id, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Synthetic suburb"));
  await page.waitForSelector("[data-testid=visitor-record]");
  await shot(page, "visitor-joshua-record-desktop");
  await page.click("#visitor-delete-confirm");
  await page.click("[data-act=visitor-delete]");
  await page.waitForFunction(() => location.hash === "#/visitors" && !document.body.innerText.includes("Synthetic suburb"));
  await shot(page, "visitor-joshua-deleted-desktop");
  console.log("visitor ui ok");
} finally {
  await browser.close();
  server.close();
}
