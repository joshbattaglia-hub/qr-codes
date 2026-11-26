import { test } from "node:test";
import assert from "node:assert/strict";

/** Head-office tools accept the owner's email-code session; other email-code users are 403; password access is unchanged. */
const H = await import("./support/browser-harness.mjs");
const users = await import("../netlify/lib/users.mjs");
const owner = await H.otpCookie(H.JOSHUA);
const j = async (p) => {
  const r = await p;
  const t = r.headers.get("content-type") || "";
  return { status: r.status, body: t.includes("json") ? await r.json() : await r.text() };
};

test("the owner signed in with an email code can use QR codes, competitions, settings, templates and vouchers", async () => {
  const created = await j(H.call("POST", "/api/codes", {
    cookie: owner,
    body: { url: "https://example.com/otp-office", slug: "otp-office-code", name: "OTP office code", type: "qr" },
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.slug, "otp-office-code");

  const listed = await j(H.call("GET", "/api/codes", { cookie: owner }));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.some((c) => c.slug === "otp-office-code"), true);

  const patched = await j(H.call("PATCH", "/api/codes/otp-office-code", { cookie: owner, body: { name: "OTP office code renamed" } }));
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, "OTP office code renamed");

  const comp = await j(H.call("POST", "/api/competitions", {
    cookie: owner,
    body: { name: "OTP office competition", slug: "otp-office-comp" },
  }));
  assert.equal(comp.status, 201, JSON.stringify(comp.body));

  const comps = await j(H.call("GET", "/api/competitions", { cookie: owner }));
  assert.equal(comps.status, 200);
  assert.equal(comps.body.some((c) => c.slug === "otp-office-comp"), true);

  const settings = await j(H.call("GET", "/api/settings", { cookie: owner }));
  assert.equal(settings.status, 200);
  assert.ok(settings.body.defaultFg);

  const savedSettings = await j(H.call("PATCH", "/api/settings", {
    cookie: owner,
    body: { workspaceName: settings.body.workspaceName, defaultFg: settings.body.defaultFg, defaultBg: settings.body.defaultBg },
  }));
  assert.equal(savedSettings.status, 200);

  const tmpl = await j(H.call("POST", "/api/templates", {
    cookie: owner,
    body: { kind: "competition", slug: "otp-office-comp", name: "OTP office template" },
  }));
  assert.equal(tmpl.status, 201, JSON.stringify(tmpl.body));
  const tmpls = await j(H.call("GET", "/api/templates", { cookie: owner }));
  assert.equal(tmpls.status, 200);
  assert.equal(tmpls.body.some((row) => row.name === "OTP office template"), true);

  const vouchers = await j(H.call("GET", "/api/vouchers", { cookie: owner }));
  assert.equal(vouchers.status, 200);
  assert.ok(Array.isArray(vouchers.body));
});

test("password sign-in still works, other email-code users get 403, and a validation error is not a 401", async () => {
  const head = await j(H.call("GET", "/api/codes", { cookie: H.head }));
  assert.equal(head.status, 200);

  const added = await users.saveUser(H.OWNER, { mode: "add", email: "staff.office@libertyretail.com.au", visitor: "view", tickets: [], assets: "none", warehouse: false });
  assert.equal(added.status, 200, added.error);
  const staff = await H.otpCookie("staff.office@libertyretail.com.au");
  for (const path of ["/api/codes", "/api/competitions", "/api/settings", "/api/templates", "/api/vouchers"]) {
    const res = await j(H.call("GET", path, { cookie: staff }));
    assert.equal(res.status, 403, path + " " + res.status);
  }
  const anon = await j(H.call("GET", "/api/codes"));
  assert.equal(anon.status, 401);

  const bad = await j(H.call("POST", "/api/codes", { cookie: owner, body: { url: "not-a-url", name: "Bad", type: "qr" } }));
  assert.equal(bad.status, 400);
  assert.notEqual(bad.status, 401);
});

test("preview deploys refuse writes to the other head-office tools", async () => {
  const codesFn = (await import("../netlify/functions/codes.mjs")).default;
  const settingsFn = (await import("../netlify/functions/settings.mjs")).default;
  const ctx = { deploy: { context: "production" } };
  const codeReq = new Request("https://pages-save-pr79--liberty-qr-353.netlify.app/api/codes", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner },
    body: JSON.stringify({ url: "https://example.com/preview", name: "Preview", type: "qr" }),
  });
  const blocked = await codesFn(codeReq, ctx);
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /preview/);

  const settingsReq = new Request("https://pages-save-pr79--liberty-qr-353.netlify.app/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: owner },
    body: JSON.stringify({ workspaceName: "Hijack", defaultFg: "#111827", defaultBg: "#ffffff" }),
  });
  const settingsBlocked = await settingsFn(settingsReq, ctx);
  assert.equal(settingsBlocked.status, 403);
});
