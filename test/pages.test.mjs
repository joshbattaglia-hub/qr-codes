import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.RESEND_TO;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const pagesFn = (await import("../netlify/functions/pages.mjs")).default;
const auth = (await import("../netlify/functions/auth.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const redirectFn = (await import("../netlify/functions/redirect.mjs")).default;
const { viewsIn, submissionsCsv, readSubmission } = await import("../netlify/lib/pages.mjs");

function req(method, url, { cookie, body, ua, jsonBody = true } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (ua) headers.set("user-agent", ua);
  if (body !== undefined && jsonBody) headers.set("content-type", "application/json");
  if (body !== undefined && jsonBody) headers.set("accept", "application/json");
  return new Request("http://localhost" + url, {
    method,
    headers,
    body: body !== undefined ? (jsonBody ? JSON.stringify(body) : body) : undefined,
  });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body, res };
}
function cookieOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return (list[0] || "").split(";")[0];
}

test("draft pages stay private, published pages count views and store submissions", async () => {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const cookie = cookieOf(login);
  const created = await read(await pagesFn(req("POST", "/api/pages", {
    cookie,
    body: { name: "Open day", heading: "Welcome", slug: "open-day", fields: [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "email", type: "email", label: "Email", required: true },
      { id: "hear", type: "dropdown", label: "How did you hear", required: false, options: ["Friend", "QR"] },
    ] },
  }), {}));
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "draft");
  assert.equal(created.body.colors.accent, "#0e1b4d");

  const hidden = await pagesFn(req("GET", "/p/open-day"), { ip: "203.0.113.8" });
  assert.equal(hidden.status, 404);
  assert.match(await hidden.text(), /not available/);

  const published = await read(await pagesFn(req("PATCH", "/api/pages/open-day", { cookie, body: { status: "published" } }), {}));
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "published");

  const ip = "203.0.113.8";
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1";
  const first = await pagesFn(req("GET", "/p/open-day", { ua }), { ip });
  const second = await pagesFn(req("GET", "/p/open-day", { ua }), { ip });
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Welcome/);
  assert.match(await second.text(), /Welcome/);

  const bad = await read(await pagesFn(req("POST", "/p/open-day", { body: { name: "Ada" } }), { ip }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Email/);

  const ok = await read(await pagesFn(req("POST", "/p/open-day", { body: { name: "Ada", email: "ada@example.com", hear: "QR" } }), { ip }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  const detail = await read(await pagesFn(req("GET", "/api/pages/open-day", { cookie }), {}));
  assert.equal(detail.body.submissions.length, 1);
  assert.equal(detail.body.submissions[0].values.email, "ada@example.com");
  assert.equal(JSON.stringify(detail.body).includes(ip), false);
  const rolled = viewsIn(detail.body.stats, Object.keys(detail.body.stats.daily));
  assert.equal(detail.body.stats.total, 2);
  assert.equal(rolled.unique, 1);
  const csv = submissionsCsv(detail.body.page, detail.body.submissions);
  assert.match(csv, /ada@example.com/);
  assert.match(csv, /How did you hear/);

  const list = await read(await pagesFn(req("GET", "/api/pages", { cookie }), {}));
  assert.equal(list.body[0].views, 2);
  assert.equal(list.body[0].submissions, 1);
  assert.equal(list.body[0].daily[Object.keys(detail.body.stats.daily)[0]], 2);
  assert.equal(JSON.stringify(list.body).includes(detail.body.stats.visitors[Object.keys(detail.body.stats.visitors)[0]][0]), false);

  const anon = await read(await pagesFn(req("POST", "/api/pages", { body: { name: "Nope" } }), {}));
  assert.equal(anon.status, 401);
});

test("optional email is skipped without Resend env and does not block a bad send", async () => {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const cookie = cookieOf(login);
  await pagesFn(req("POST", "/api/pages", { cookie, body: { name: "Mail", slug: "mail-page", status: "published" } }), {});
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return new Response("no", { status: 500 });
  };
  try {
    const quiet = await read(await pagesFn(req("POST", "/p/mail-page", { body: { name: "Ada", email: "ada@example.com" } }), { ip: "203.0.113.9" }));
    assert.equal(quiet.status, 200);
    assert.equal(calls.length, 0);
    process.env.RESEND_API_KEY = "test-key";
    process.env.RESEND_FROM = "Liberty <hello@expresshelp.site>";
    process.env.RESEND_TO = "joshua@example.com";
    const noisy = await read(await pagesFn(req("POST", "/p/mail-page", { body: { name: "Grace", email: "grace@example.com" } }), { ip: "203.0.113.9" }));
    assert.equal(noisy.status, 200);
    assert.equal(calls.some((url) => url.includes("api.resend.com")), true);
    const detail = await read(await pagesFn(req("GET", "/api/pages/mail-page", { cookie }), {}));
    assert.equal(detail.body.submissions.length, 2);
  } finally {
    globalThis.fetch = original;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.RESEND_TO;
  }
});

test("linked short link can point at the public page", async () => {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const cookie = cookieOf(login);
  await pagesFn(req("POST", "/api/pages", { cookie, body: { name: "Linked", slug: "linked-page", status: "published" } }), {});
  const code = await read(await codesFn(req("POST", "/api/codes", {
    cookie,
    body: { url: "https://expresshelp.site/p/linked-page", name: "Linked", type: "link" },
  }), { params: {} }));
  assert.equal(code.status, 201);
  const patched = await read(await pagesFn(req("PATCH", "/api/pages/linked-page", { cookie, body: { codeSlug: code.body.slug } }), {}));
  assert.equal(patched.body.codeSlug, code.body.slug);
  const hit = await redirectFn(req("GET", "/r/" + code.body.slug), { params: { slug: code.body.slug }, ip: "203.0.113.20", geo: {} });
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get("location"), "https://expresshelp.site/p/linked-page");
});

test("readSubmission rejects a dropdown value outside the options", () => {
  const result = readSubmission([{ id: "hear", type: "dropdown", label: "Hear", required: true, options: ["QR"] }], { hear: "Other" });
  assert.match(result.error, /invalid/);
});
