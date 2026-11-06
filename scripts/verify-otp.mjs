import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

process.env.ADMIN_PASSWORD = "liberty-dev";
process.env.PUBLIC_URL = "https://expresshelp.site";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.POS_MAIL_MOCK;
delete process.env.OTP_SESSION_SECRET;
delete process.env.OTP_ALLOWLIST;

const { start } = await import("./dev-server.mjs");
const otp = await import("../netlify/lib/otp.mjs");
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

const disabled = await start(8917);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8917/admin", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Email codes are not operational"));
  await shot(page, "otp-disabled-desktop");
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await shot(page, "otp-disabled-mobile");
} finally {
  await page.close();
  disabled.close();
}

process.env.OTP_SESSION_SECRET = "local-otp-session-secret-32chars-min";
process.env.OTP_ALLOWLIST = JSON.stringify({
  "nanderson@libertyretail.com.au": { approverKey: "neil", siteIds: ["s0000abcd"] },
});
const inbox = [];
otp.setOtpTestHooks({
  deliver: async (message) => {
    inbox.push({ to: message.to, subject: message.subject, text: message.text });
    return { status: "sent", id: "local-mock" };
  },
});
const enabled = await start(8918);
const live = await browser.newPage();
live.on("pageerror", (err) => errors.push(String(err)));
try {
  await live.setViewport({ width: 1280, height: 900 });
  await live.goto("http://127.0.0.1:8918/admin", { waitUntil: "networkidle0" });
  await live.waitForFunction(() => document.body.innerText.includes("Local mock mail"));
  await live.type("#otp-email", "nanderson@libertyretail.com.au");
  await live.click("#otp-send");
  await live.waitForFunction(() => document.body.innerText.includes("If this address is approved"));
  assert(inbox.length === 1, "expected one local mock message");
  assert(inbox[0].subject === "Express Help sign-in code", inbox[0].subject);
  const code = inbox[0].text.match(/code is (\d{8})/)[1];
  await shot(live, "otp-mock-sent-desktop");
  const wrong = code === "00000000" ? "11111111" : "00000000";
  await live.type("#otp-code", wrong);
  await live.click("#otp-verify");
  await live.waitForFunction(() => document.body.innerText.includes("That code was not accepted"));
  await shot(live, "otp-mock-error-desktop");
  await live.$eval("#otp-code", (el, value) => { el.value = value; }, code);
  await live.click("#otp-verify");
  await live.waitForFunction(() => (document.querySelector("#account-label")?.textContent || "").includes("email code"));
  await live.click("[data-pop=account]");
  await shot(live, "otp-mock-signed-in-desktop");
  await live.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await shot(live, "otp-mock-signed-in-mobile");
  assert(errors.length === 0, errors.join("\n"));
  console.log("otp ui ok");
} finally {
  await browser.close();
  enabled.close();
}
