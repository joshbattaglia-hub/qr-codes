import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const tickets = await import("../netlify/lib/tickets.mjs");
const supportAuth = await import("../netlify/lib/support-auth.mjs");
const supportFn = (await import("../netlify/functions/support.mjs")).default;
const authFn = (await import("../netlify/functions/auth.mjs")).default;
const mail = [];
supportAuth.setSupportTestHooks({ deliver: async (message) => { mail.push(message); return { status: "sent", id: "local" }; } });
tickets.setTicketTestHooks({ now: () => Date.parse("2026-11-10T02:00:00.000Z") });

function req(method, url, { cookie = "", body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json() };
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}
async function signIn(email) {
  const before = mail.length;
  const started = await read(await supportFn(req("POST", "/api/support/start", { body: { email } })));
  assert.equal(started.status, 200);
  const code = mail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await supportFn(req("POST", "/api/support/verify", { body: { email, code } }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_support");
}

test("requesters see their own tickets and not internal notes", async () => {
  await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
  await lib.sitesStore().setJSON("s00000002", { id: "s00000002", name: "Example South", operationalRegion: "South" });
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    requesters: [
      { email: "a@example.com", sites: ["s00000001"] },
      { email: "b@example.com", sites: ["s00000002"] },
      { email: "c@example.com", sites: ["s00000001"], area: "North" },
    ],
    visibility: "own-and-sites",
  }));
  const before = mail.length;
  const unknown = await read(await supportFn(req("POST", "/api/support/start", { body: { email: "nobody@example.com" } })));
  assert.equal(unknown.status, 200);
  assert.equal(mail.length, before);
  const ada = await signIn("a@example.com");
  const created = await read(await supportFn(req("POST", "/api/support/tickets", { cookie: ada, body: {
    queue: "screens", requestType: "Fault or repair", siteId: "s00000001", priority: "normal",
    subject: "Example blank screen", description: "The example player is blank.",
  } })));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.ticket.id;
  const raw = await lib.ticketStore().get("ticket/" + id, { type: "json" });
  raw.messages = [{ id: "m1", at: raw.createdAt, actor: "staff@example.com", kind: "internal", text: "Hidden supplier note" }];
  await lib.ticketStore().setJSON("ticket/" + id, raw);
  const own = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: ada })));
  assert.equal(JSON.stringify(own.body).includes("Hidden supplier note"), false);
  const bee = await signIn("b@example.com");
  const hidden = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: bee })));
  assert.equal(hidden.status, 404);
  const cee = await signIn("c@example.com");
  const shared = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: cee })));
  assert.equal(shared.body.ticket.access, "read");
  const blocked = await read(await supportFn(req("POST", "/api/support/tickets/" + id + "/comment", { cookie: cee, body: { text: "I should not write this" } })));
  assert.equal(blocked.status, 403);
  const comment = await read(await supportFn(req("POST", "/api/support/tickets/" + id + "/comment", { cookie: ada, body: { text: "Still blank" } })));
  assert.equal(comment.status, 200);
  let limited = 0;
  for (let i = 0; i < 4; i++) {
    const res = await read(await supportFn(req("POST", "/api/support/start", { body: { email: "a@example.com" } })));
    if (res.status === 429) limited += 1;
  }
  assert.equal(limited >= 1, true);
  await lib.ticketStore().setJSON("settings", tickets.normaliseSettings({
    requesters: [{ email: "c@example.com", sites: ["s00000001"] }],
    visibility: "own-only",
  }));
  const strict = await read(await supportFn(req("GET", "/api/support/tickets/" + id, { cookie: cee })));
  assert.equal(strict.status, 404);
  const headLogin = await authFn(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const head = cookieNamed(headLogin, "qr_admin");
  const staffDenied = await read(await supportFn(req("GET", "/api/support/tickets", { cookie: head })));
  assert.equal(staffDenied.status, 401);
  const page = fs.readFileSync(new URL("../public/support/index.html", import.meta.url), "utf8");
  assert.match(page, /Liberty Oil Convenience/);
  assert.match(page, /overflow-x:\s*clip/);
  assert.equal(page.includes("internal"), false);
});
