import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const JOSHUA = "jbattaglia@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({ [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] } });

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const mail = await import("../netlify/lib/mail.mjs");
const otpLib = await import("../netlify/lib/otp.mjs");
const digest = await import("../netlify/lib/support-digest.mjs");
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;
const scheduled = (await import("../netlify/functions/support-digest.mjs")).default;

const sent = [];
let slowSend = 0;
mail.setMailTransport(async (message) => { if (slowSend) await new Promise((r) => setTimeout(r, slowSend)); sent.push(message); return { status: "sent", id: "fake" }; });
const otpMail = [];
otpLib.setOtpTestHooks({ deliver: async (m) => { otpMail.push(m); return { status: "sent", id: "otp-mock" }; } });

const store = () => lib.ticketStore();
async function seed() {
  const rows = [
    { id: "t0000000000000001", number: 2001, queue: "signage", status: "new", subject: "Synthetic sign A", siteId: "s00000001", siteLabel: "Synthetic Site", requestType: "Replacement", priority: "high", neededBy: "2026-11-10", requesterName: "Test Person", requesterEmail: "test.person@libertyretail.com.au", createdAt: "2026-11-01T00:00:00Z" },
    { id: "t0000000000000002", number: 2002, queue: "signage", status: "in-progress", subject: "Synthetic sign B", siteId: "national", siteLabel: "x", requestType: "Print or reprint", priority: "normal", neededBy: "2026-11-20", requesterEmail: "b@libertyretail.com.au", createdAt: "2026-11-05T00:00:00Z", assignee: "jbattaglia@libertyretail.com.au" },
    { id: "t0000000000000003", number: 2003, queue: "signage", status: "awaiting", subject: "Synthetic sign C", siteId: "other", siteLabel: "Free text", requestType: "Other", priority: "low", neededBy: "", requesterEmail: "c@libertyretail.com.au", createdAt: "2026-11-02T00:00:00Z" },
    { id: "t0000000000000004", number: 2004, queue: "signage", status: "new", subject: "Synthetic sign D", siteId: "s00000001", siteLabel: "Synthetic Site", requestType: "Other", priority: "urgent", neededBy: "2026-11-15", requesterEmail: "d@libertyretail.com.au", createdAt: "2026-11-03T00:00:00Z" },
    { id: "t0000000000000005", number: 2005, queue: "signage", status: "done", subject: "Done job", siteId: "s00000001", siteLabel: "Synthetic Site", requestType: "Other", priority: "normal", neededBy: "2026-11-01", requesterEmail: "e@libertyretail.com.au", createdAt: "2026-10-01T00:00:00Z" },
    { id: "t0000000000000006", number: 2006, queue: "screens", status: "new", subject: "Screens job", siteId: "s00000001", siteLabel: "Synthetic Site", requestType: "Other", priority: "normal", neededBy: "2026-11-11", requesterEmail: "f@libertyretail.com.au", createdAt: "2026-11-04T00:00:00Z" },
    { id: "t0000000000000007", number: 2007, queue: "signage", status: "scheduled", subject: "Due today", siteId: "s00000001", siteLabel: "Synthetic Site", requestType: "Other", priority: "normal", neededBy: "2026-11-17", requesterEmail: "g@libertyretail.com.au", createdAt: "2026-11-06T00:00:00Z" },
  ];
  for (const row of rows) await store().setJSON("ticket/" + row.id, row);
}
const AT_0645 = Date.parse("2026-11-16T19:45:00Z"); // 6:45am AEDT Tue 17 Nov
const AT_0700 = Date.parse("2026-11-16T20:00:00Z");
const AT_0715 = Date.parse("2026-11-16T20:15:00Z");
const AT_1100 = Date.parse("2026-11-17T00:00:00Z");

test("Melbourne time and due text are DST-correct", () => {
  assert.deepEqual(digest.melbourneParts(AT_0700), { date: "2026-11-17", minutes: 420 });
  assert.deepEqual(digest.melbourneParts(Date.parse("2026-06-16T21:00:00Z")), { date: "2026-06-17", minutes: 420 }, "AEST in winter");
  assert.equal(digest.dueInfo("2026-11-10", "2026-11-17").text, "7 days overdue");
  assert.equal(digest.dueInfo("2026-11-16", "2026-11-17").text, "1 day overdue");
  assert.equal(digest.dueInfo("2026-11-17", "2026-11-17").text, "Due today");
  assert.equal(digest.dueInfo("2026-11-20", "2026-11-17").text, "Due in 3 days");
  assert.equal(digest.dueInfo("", "2026-11-17").text, "No due date");
});

test("defaults: on, 7:00, Signage only, Joshua, skip empty days", async () => {
  assert.deepEqual(await digest.readDigestSettings(), { enabled: true, time: "07:00", recipients: [JOSHUA], queues: ["signage"], emptyDay: "skip" });
});

test("digest content: open Signage jobs only, most overdue then due soonest then no due date, links and footer", async () => {
  await seed();
  const jobs = await digest.collectJobs(["signage"], AT_0700);
  assert.deepEqual(jobs.map((j) => j.number), [2001, 2004, 2007, 2002, 2003]);
  assert.equal(jobs[0].due.text, "7 days overdue");
  assert.equal(jobs[3].siteLabel, "All sites / National");
  const d = digest.buildDigest({ jobs, queues: ["signage"], date: "2026-11-17" });
  assert.match(d.subject, /^Support digest: 5 open Signage jobs \(2 overdue\)/);
  assert.match(d.text, /T-2001 · Synthetic sign A\n  7 days overdue \(needed by/);
  assert.match(d.text, /Synthetic Site · Replacement · High priority · Submitted/);
  assert.match(d.text, /Submitted by Test Person/);
  assert.match(d.text, /https:\/\/expresshelp\.site\/admin\/#\/tickets\/t0000000000000001/);
  assert.match(d.text, /Support: https:\/\/expresshelp\.site\/admin\/#\/tickets/);
  assert.match(d.text, /Cowabunga - please hesitate to reach out email me here: mailto:jbattaglia@libertyretail\.com\.au/);
  assert.match(d.html, /Cowabunga - please hesitate to reach out <a href="mailto:jbattaglia@libertyretail\.com\.au"[^>]*>email me here<\/a>/);
  assert.match(d.html, /<a href="mailto:jbattaglia@libertyretail\.com\.au"[^>]*>email me here<\/a>/);
  assert.doesNotMatch(d.text, /Done job|Screens job/);
  assert.match(digest.buildDigest({ jobs, queues: ["signage"], date: "2026-11-17", test: true }).subject, /^\[TEST\] /);
});

test("schedule: nothing before the set time, one send at/after it, never twice, not after the window", async () => {
  sent.length = 0;
  assert.equal((await digest.runDigest({ at: AT_0645 })).outcome, "not-yet");
  const first = await digest.runDigest({ at: AT_0700 });
  assert.equal(first.outcome, "sent");
  assert.equal(first.count, 5);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JOSHUA);
  assert.equal((await digest.runDigest({ at: AT_0715 })).outcome, "already-sent");
  assert.equal((await digest.runDigest({ at: AT_1100 })).outcome, "window-passed");
  assert.equal(sent.length, 1);
  const marker = await store().get("digest/sent/2026-11-17", { type: "json" });
  assert.equal(marker.state, "done");
  assert.equal(JSON.stringify(marker).includes("@"), false, "marker stores hashed recipients only");
});

test("races: concurrent scheduled runs send exactly once", async () => {
  sent.length = 0;
  slowSend = 20;
  const at = Date.parse("2026-11-17T20:05:00Z"); // 7:05am Wed 18 Nov
  const results = await Promise.all(Array.from({ length: 8 }, () => digest.runDigest({ at })));
  slowSend = 0;
  assert.equal(results.filter((r) => r.outcome === "sent").length, 1);
  assert.equal(results.filter((r) => r.outcome === "already-sent").length, 7);
  assert.equal(sent.length, 1);
});

test("a run that crashes after claiming the day does not resend later that day", async () => {
  sent.length = 0;
  const at = Date.parse("2026-11-18T20:00:00Z"); // 7:00 Thu 19 Nov
  mail.setMailTransport(async () => { throw new Error("provider down"); });
  const first = await digest.runDigest({ at });
  assert.equal(first.outcome, "sent");
  assert.equal(first.results[0].status, "unknown");
  mail.setMailTransport(async (m) => { sent.push(m); return { status: "sent" }; });
  assert.equal((await digest.runDigest({ at: at + 15 * 60000 })).outcome, "already-sent");
  assert.equal(sent.length, 0);
});

test("settings: validation like Visitor Log recipients, multiple recipients get separate emails, empty-day behaviour, off switch", async () => {
  assert.equal(digest.validateDigestBody({ time: "7am", recipients: [JOSHUA], queues: ["signage"] }).error, "Choose a time like 07:00.");
  assert.match(digest.validateDigestBody({ time: "07:00", recipients: ["x@gmail.com"], queues: ["signage"] }).error, /exact @libertyretail\.com\.au/);
  assert.match(digest.validateDigestBody({ time: "07:00", recipients: ["a@shop.libertyretail.com.au"], queues: ["signage"] }).error, /exact/);
  assert.equal(digest.validateDigestBody({ time: "07:00", recipients: [], queues: ["signage"] }).error, "Add at least one recipient.");
  assert.equal(digest.validateDigestBody({ time: "07:00", recipients: [JOSHUA], queues: [] }).error, "Choose at least one queue.");
  const many = Array.from({ length: 11 }, (_, i) => "p" + i + "@libertyretail.com.au");
  assert.match(digest.validateDigestBody({ time: "07:00", recipients: many, queues: ["signage"] }).error, /Up to 10/);
  const saved = await digest.saveDigestSettings(JOSHUA, { enabled: true, time: "06:30", recipients: [" JBattaglia@LibertyRetail.com.au ", "second@libertyretail.com.au", JOSHUA], queues: ["screens"], emptyDay: "note" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.recipients, [JOSHUA, "second@libertyretail.com.au"]);
  sent.length = 0;
  const at = Date.parse("2026-11-19T19:30:00Z"); // 6:30 Fri 20 Nov
  const run = await digest.runDigest({ at });
  assert.equal(run.outcome, "sent");
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
  assert.match(sent[0].subject, /1 open Screens job \(1 overdue\)/);
  // Empty day with "note".
  await store().delete("ticket/t0000000000000006");
  sent.length = 0;
  await digest.runDigest({ at: at + 86400000 });
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /nothing open in Screens/);
  // Empty day with "skip": marker written, nothing sent.
  await digest.saveDigestSettings(JOSHUA, { enabled: true, time: "06:30", recipients: [JOSHUA], queues: ["screens"], emptyDay: "skip" });
  sent.length = 0;
  assert.equal((await digest.runDigest({ at: at + 2 * 86400000 })).outcome, "skipped-empty");
  assert.equal(sent.length, 0);
  await digest.saveDigestSettings(JOSHUA, { enabled: false, time: "06:30", recipients: [JOSHUA], queues: ["signage"] });
  assert.equal((await digest.runDigest({ at: at + 3 * 86400000 })).outcome, "disabled");
  assert.equal(sent.length, 0);
  await digest.saveDigestSettings(JOSHUA, { enabled: true, time: "07:00", recipients: [JOSHUA], queues: ["signage"], emptyDay: "skip" });
});

test("test digest: [TEST], only the ticket admin, cooldown, never sets the daily marker; one-off request processed once", async () => {
  await digest.saveDigestSettings(JOSHUA, { enabled: true, time: "07:00", recipients: [JOSHUA, "other@libertyretail.com.au"], queues: ["signage"] });
  sent.length = 0;
  const at = Date.parse("2026-11-24T01:43:00Z");
  const r = await digest.sendTestDigest({ at });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JOSHUA);
  assert.match(sent[0].subject, /^\[TEST\] Support digest/);
  assert.equal((await digest.sendTestDigest({ at: at + 1000 })).status, 429);
  assert.equal(await store().get("digest/sent/2026-11-24", { type: "json" }), null);
  sent.length = 0;
  const later = at + 30 * 60000;
  await store().setJSON("digest/test-request", { id: "release-1", requestedAt: new Date(later - 60000).toISOString() });
  const out = await digest.processTestRequest({ at: later });
  assert.equal(out.outcome, "test");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, JOSHUA);
  assert.equal(await digest.processTestRequest({ at: later + 1000 }), null, "request removed after processing");
  await store().setJSON("digest/test-request", { id: "release-1", requestedAt: new Date(later).toISOString() });
  assert.equal((await digest.processTestRequest({ at: later + 2000 })).outcome, "test-already-processed");
  assert.equal(sent.length, 1);
  await store().setJSON("digest/test-request", { id: "old-1", requestedAt: "2026-11-01T00:00:00Z" });
  assert.equal((await digest.processTestRequest({ at: later + 3000 })).outcome, "test-expired");
  assert.equal(sent.length, 1);
  await digest.saveDigestSettings(JOSHUA, { enabled: true, time: "07:00", recipients: [JOSHUA], queues: ["signage"], emptyDay: "skip" });
});

test("endpoints: ticket admin only; scheduled function returns 204", async () => {
  const req = (method, url, { cookie = "", body } = {}) => new Request("https://expresshelp.site" + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await ticketFn(req("GET", "/api/tickets/digest"))).status, 401);
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email: JOSHUA } }));
  assert.equal(started.status, 200);
  const code = otpMail.at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email: JOSHUA, code } }));
  const cookie = (verified.headers.getSetCookie ? verified.headers.getSetCookie() : []).find((c) => c.startsWith("qr_otp=")).split(";")[0];
  const got = await ticketFn(req("GET", "/api/tickets/digest", { cookie }));
  assert.equal(got.status, 200);
  const body = await got.json();
  assert.equal(body.time, "07:00");
  assert.equal(body.windowMinutes, 180);
  const bad = await ticketFn(req("PUT", "/api/tickets/digest", { cookie, body: { time: "07:00", recipients: ["x@example.com"], queues: ["signage"] } }));
  assert.equal(bad.status, 400);
  const res = await scheduled(new Request("https://expresshelp.site/.netlify/functions/support-digest", { method: "POST" }));
  assert.equal(res.status, 204);
});
