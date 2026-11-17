import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.RESEND_API_KEY = "re_synthetic_test_key";
process.env.RESEND_FROM = "Express Help <noreply@example.test>";
const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const diag = await import("../netlify/lib/mail-diag.mjs");

const calls = [];
const NOW = Date.parse("2026-11-17T02:30:00Z");
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || "GET", auth: init.headers?.authorization });
  const u = new URL(url);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.pathname === "/emails") return reply({ object: "list", data: [
    { id: "e1", to: ["jbattaglia@libertyretail.com.au"], from: "Express Help <noreply@example.test>", subject: "[TEST] digest", created_at: "2026-11-17 02:00:37+00", last_event: "delivered" },
    { id: "e2", to: ["someone.else@example.test"], from: "x", subject: "other", created_at: "2026-11-17 01:00:00+00", last_event: "sent" },
    { id: "e3", to: ["JBattaglia@libertyretail.com.au"], from: "x", subject: "Visitor log sign-in", created_at: "2026-11-12 04:09:37+00" },
    { id: "e4", to: ["jbattaglia@libertyretail.com.au"], from: "x", subject: "old", created_at: "2026-10-01 00:00:00+00", last_event: "delivered" },
  ] });
  if (u.pathname === "/emails/e3") return reply({ id: "e3", last_event: "bounced" });
  if (u.pathname === "/domains") return reply({ data: [{ id: "d1", name: "example.test", status: "verified", region: "us-east-1" }] });
  if (u.pathname === "/domains/d1") return reply({ records: [{ record: "DKIM", type: "TXT", name: "resend._domainkey", status: "verified", value: "p=SECRETISH" }, { record: "SPF", type: "TXT", name: "send", status: "verified", value: "v=spf1 ip4:192.0.2.1 ~all" }] });
  return reply({ name: "not_found", message: "nope" }, 404);
};

test("mail diag: GET only, admin emails only, last events filled, domain record values dropped, runs once", async () => {
  assert.equal(await diag.processMailDiagRequest({ at: NOW }), null, "no request, nothing runs");
  await lib.ticketStore().setJSON("mail-diag/request", { id: "diag-1", requestedAt: new Date(NOW - 60000).toISOString() });
  const r = await diag.processMailDiagRequest({ at: NOW });
  assert.equal(r.outcome, "diag");
  assert.ok(calls.every((c) => c.method === "GET"), "read-only");
  const done = await lib.ticketStore().get("mail-diag/done/diag-1", { type: "json" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.emails.map((e) => [e.id, e.last_event]), [["e1", "delivered"], ["e3", "bounced"]]);
  assert.equal(done.fromDomain, "example.test");
  assert.equal(done.domains[0].status, "verified");
  const raw = JSON.stringify(done);
  assert.ok(!raw.includes("SECRETISH") && !raw.includes("192.0.2.1") && !raw.includes("re_synthetic"), "no record values, IPs or key");
  assert.equal(await lib.ticketStore().get("mail-diag/request", { type: "json" }), null, "request consumed");
  await lib.ticketStore().setJSON("mail-diag/request", { id: "diag-1", requestedAt: new Date(NOW).toISOString() });
  assert.equal((await diag.processMailDiagRequest({ at: NOW })).outcome, "diag-already-processed");
  await lib.ticketStore().setJSON("mail-diag/request", { id: "diag-2", requestedAt: new Date(NOW - 3 * 3600e3).toISOString() });
  assert.equal((await diag.processMailDiagRequest({ at: NOW })).outcome, "diag-expired");
});

test("mail diag reports a restricted key error instead of failing", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }), { status: 401 });
  const out = await diag.runMailDiag({ at: NOW });
  assert.match(out.errors.list, /restricted_api_key/);
  assert.deepEqual(out.emails, []);
  globalThis.fetch = saved;
});
