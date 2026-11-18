import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
const JOSHUA = "jbattaglia@libertyretail.com.au";
const OTHER = "someone.else@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [OTHER]: { preparerClass: "regional-business-manager", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const tvTickets = await import("../netlify/lib/tv-tickets.mjs");
const tvFn = (await import("../netlify/functions/tv.mjs")).default;
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;

const otpMail = [];
otpLib.setOtpTestHooks({ deliver: async (m) => { otpMail.push(m); return { status: "sent", id: "otp-mock" }; } });
const store = () => lib.ticketStore();
const req = (method, url, { cookie = "", body } = {}) => new Request("https://expresshelp.site" + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
async function login(email) {
  await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }));
  const code = otpMail.at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  return verified.headers.getSetCookie().find((c) => c.startsWith("qr_otp=")).split(";")[0];
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const DAY = 86400000;
const SECRET_BITS = ["LEAK-DESC", "LEAK-MSG", "LEAK-PHONE", "LEAK-EMAIL", "LEAK-FILE", "LEAK-NOTE", "LEAK-ASSIGNEE", "LEAK-CLOSE"];
function row(n, over = {}) {
  return {
    id: "t" + String(n).padStart(16, "0"), number: n, queue: "signage", status: "new", subject: "Synthetic job " + n, siteId: "s00000001", siteLabel: "Synthetic Depot",
    requestType: "Replacement", priority: "normal", neededBy: "", description: "LEAK-DESC private details", requesterEmail: "LEAK-EMAIL@example.com", requesterName: "Sam Synthetic",
    requesterPhone: "LEAK-PHONE 0400 000 000", source: "portal", assignee: "LEAK-ASSIGNEE@example.com", createdAt: iso(3 * DAY), updatedAt: iso(DAY),
    messages: [{ id: "m1", kind: "internal", text: "LEAK-NOTE staff note", at: iso(DAY) }, { id: "m2", kind: "public", text: "LEAK-MSG reply", at: iso(DAY) }],
    closeOut: { note: "LEAK-CLOSE", photoId: "f1" }, files: [{ id: "f1", name: "LEAK-FILE.jpg", size: 10, contentType: "image/jpeg" }], statusHistory: [], ...over,
  };
}
async function seed() {
  const rows = [
    row(3001, { subject: "Replace sign A", status: "new", priority: "urgent", neededBy: "2020-01-01", createdAt: iso(9 * DAY) }),
    row(3002, { subject: "Needs a photo", status: "awaiting", queue: "screens", requesterName: "Alex Q. Smith-Jones" }),
    row(3003, { subject: "Install the screen", status: "in-progress", siteId: "national", siteLabel: "ignored", priority: "high", createdAt: iso(0) }),
    row(3004, { subject: "Old done job", status: "done", statusHistory: [{ from: "in-progress", to: "done", at: iso(30 * 3600000) }] }),
    row(3005, { subject: "Fresh done job", status: "done", statusHistory: [{ from: "in-progress", to: "done", at: iso(5 * 3600000) }] }),
    row(3006, { subject: "Closed today", status: "closed", statusHistory: [{ from: "done", to: "closed", at: iso(2 * 3600000) }] }),
    row(3007, { subject: "Call me on 0412 345 678 or bob@example.com", requesterName: "bob@example.com" }),
  ];
  for (const r of rows) await store().setJSON("ticket/" + r.id, r);
}

test("no key yet: the tickets feed is closed, the existing lounge feed still answers", async () => {
  assert.equal((await tvFn(req("GET", "/api/tv/tickets"))).status, 401);
  assert.equal((await tvFn(req("GET", "/api/tv/tickets?key=anything"))).status, 401);
  assert.deepEqual(await tvTickets.tvLinkStatus(), { configured: false });
});

test("only the ticket admin can make, replace or switch off the TV link; the key is shown once and stored hashed", async () => {
  assert.equal((await ticketFn(req("POST", "/api/tickets/tv-link"))).status, 401);
  const other = await login(OTHER);
  assert.equal((await ticketFn(req("POST", "/api/tickets/tv-link", { cookie: other }))).status, 403);
  assert.equal((await ticketFn(req("GET", "/api/tickets/tv-link", { cookie: other }))).status, 403);
  const cookie = await login(JOSHUA);
  const made = await ticketFn(req("POST", "/api/tickets/tv-link", { cookie }));
  assert.equal(made.status, 200);
  assert.equal(made.headers.get("cache-control"), "private, no-store");
  const { key } = await made.json();
  assert.match(key, /^[A-Za-z0-9_-]{40,}$/);
  const stored = JSON.stringify(await store().get("tv-link", { type: "json" }));
  assert.ok(!stored.includes(key), "plain key is never stored");
  assert.ok(stored.includes(crypto.createHash("sha256").update(key).digest("hex")), "only the SHA-256 hash is stored");
  const status = await (await ticketFn(req("GET", "/api/tickets/tv-link", { cookie }))).json();
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes(key) && !("hash" in status) && !("key" in status));
  // the settings screen and the settings PUT can never touch or expose it
  const settings = JSON.stringify(await (await ticketFn(req("GET", "/api/tickets/settings", { cookie }))).json());
  assert.ok(!settings.includes(key) && !settings.includes("hash"));
  // replacing switches the old key off immediately
  const second = (await (await ticketFn(req("POST", "/api/tickets/tv-link", { cookie }))).json()).key;
  assert.notEqual(second, key);
  assert.equal(await tvTickets.verifyTvKey(key), false);
  assert.equal(await tvTickets.verifyTvKey(second), true);
  // switching off closes the feed
  assert.equal((await ticketFn(req("DELETE", "/api/tickets/tv-link", { cookie }))).status, 200);
  assert.equal(await tvTickets.verifyTvKey(second), false);
  assert.equal((await tvFn(req("GET", "/api/tv/tickets?key=" + second))).status, 401);
});

test("feed: wrong, missing, empty, and over-long keys are 401 with no data; the right key is 200, no-store, read-only", async () => {
  await seed();
  const cookie = await login(JOSHUA);
  const { key } = await (await ticketFn(req("POST", "/api/tickets/tv-link", { cookie }))).json();
  for (const bad of ["", "nope", key + "x", key.slice(1), "A".repeat(500)]) {
    const res = await tvFn(req("GET", "/api/tv/tickets" + (bad ? "?key=" + bad : "")));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorised" });
    assert.match(res.headers.get("cache-control"), /no-store/);
  }
  assert.equal((await tvFn(req("POST", "/api/tv/tickets?key=" + key))).status, 405);
  assert.equal((await tvFn(req("DELETE", "/api/tv/tickets?key=" + key))).status, 405);
  const ok = await tvFn(req("GET", "/api/tv/tickets?key=" + key));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
  assert.match(ok.headers.get("x-robots-tag"), /noindex/);
  assert.ok(!ok.headers.get("access-control-allow-origin"), "not open to other websites");
  globalThis.__tvKey = key;
});

test("feed does not leak any non-sanitised field", async () => {
  const res = await tvFn(req("GET", "/api/tv/tickets?key=" + globalThis.__tvKey));
  const text = await res.text();
  for (const bit of SECRET_BITS) assert.ok(!text.includes(bit), "leaked " + bit);
  assert.ok(!/@/.test(text), "no email addresses at all");
  assert.ok(!/0400 000 000|0412 345 678/.test(text), "no phone numbers");
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ["counts", "generatedAt", "overdue", "tickets", "truncated"]);
  const allowed = ["column", "daysOpen", "doneHoursAgo", "firstName", "number", "overdue", "priority", "queue", "site", "subject"];
  for (const t of body.tickets) {
    assert.ok(Object.keys(t).every((k) => allowed.includes(k)), "unexpected field in " + JSON.stringify(Object.keys(t)));
    for (const k of ["id", "description", "requesterEmail", "requesterPhone", "requesterName", "messages", "files", "assignee", "closeOut", "source", "statusHistory", "createdAt", "neededBy"]) assert.ok(!(k in t), k + " must not be sent");
  }
});

test("feed content: open tickets, Done only for 24h, grouped, first names, days open, overdue, national site, scrubbed titles", async () => {
  const body = await (await tvFn(req("GET", "/api/tv/tickets?key=" + globalThis.__tvKey))).json();
  const byNum = Object.fromEntries(body.tickets.map((t) => [t.number, t]));
  assert.ok(!byNum[3004], "done 30h ago is hidden");
  assert.ok(byNum[3005] && byNum[3006], "done within 24h shows (Closed counts as Done)");
  assert.equal(byNum[3005].column, "done");
  assert.equal(byNum[3005].doneHoursAgo, 5);
  assert.equal(byNum[3006].doneHoursAgo, 2);
  assert.deepEqual(body.counts, { submitted: 2, "needs-info": 1, "in-progress": 1, done: 2 });
  assert.equal(byNum[3001].overdue, true);
  assert.equal(byNum[3001].daysOpen, 9);
  assert.equal(byNum[3001].priority, "urgent");
  assert.equal(byNum[3003].daysOpen, 0);
  assert.equal(byNum[3003].site, "All sites / National");
  assert.equal(byNum[3002].queue, "Screens");
  assert.equal(byNum[3001].queue, "Signage");
  assert.equal(byNum[3002].firstName, "Alex");
  assert.equal(byNum[3007].firstName, "", "an email typed as a name is not shown");
  assert.equal(byNum[3007].subject, "Call me on (number removed) or (email removed)");
  assert.equal(body.overdue, 1);
  // grouped by column, overdue first within a column
  const order = body.tickets.map((t) => t.column);
  assert.deepEqual(order, [...order].sort((a, b) => ["submitted", "needs-info", "in-progress", "done"].indexOf(a) - ["submitted", "needs-info", "in-progress", "done"].indexOf(b)));
  assert.equal(body.tickets[0].number, 3001);
});

test("feed is capped and says so", async () => {
  for (let n = 4000; n < 4070; n++) await store().setJSON("ticket/t" + String(n).padStart(16, "0"), row(n));
  const body = await (await tvFn(req("GET", "/api/tv/tickets?key=" + globalThis.__tvKey))).json();
  assert.equal(body.tickets.length, 60);
  assert.equal(body.truncated, true);
  assert.ok(body.counts.submitted > 60, "counts still show the true totals");
});

test("sanitising helpers", () => {
  assert.equal(tvTickets.firstName("  Jo-Anne van Dyk"), "Jo-Anne");
  assert.equal(tvTickets.firstName("x@y.com"), "");
  assert.equal(tvTickets.firstName(""), "");
  assert.equal(tvTickets.cleanSubject("  A   b\n c "), "A b c");
  assert.ok(tvTickets.cleanSubject("x".repeat(200)).length <= 90);
});

test("the lounge TV is unchanged without a key: same feed path, key never forwarded to its API or cache", () => {
  const js = fs.readFileSync("public/tv/truckies-lounge.js", "utf8");
  assert.ok(!/["']key["']|[?&]key=/.test(js.replace(/var key = decodeURIComponent/g, "")), "lounge script never reads the TV key");
  const rotate = fs.readFileSync("public/tv/tv-rotate.js", "utf8");
  assert.match(rotate, /if \(!key \|\| !window\.EHTicketsTV\) return;/, "no key: rotation does nothing");
  const toml = fs.readFileSync("netlify.toml", "utf8");
  assert.match(toml, /from = "\/tv\/truckies-lounge"\n\s+to = "\/tv\/truckies-lounge\.html"/);
  assert.match(toml, /from = "\/tv\/support-tickets"\n\s+to = "\/tv\/support-tickets\.html"/);
});

test("TV scripts are plain ES5 (Fire TV Silk) and the pages carry the shared footer script and no emoji", () => {
  for (const f of ["tickets-screen.js", "support-tickets.js", "tv-rotate.js"]) {
    const src = fs.readFileSync("public/tv/" + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/=>/.test(src), f + " has an arrow function");
    assert.ok(!/\b(let|const|class|async|await)\b/.test(src.replace(/"[^"\n]*"|'[^'\n]*'/g, "")), f + " uses ES6 keywords");
    assert.ok(!/\bfetch\s*\(/.test(src), f + " uses fetch");
    assert.ok(!/`/.test(src), f + " uses a template literal");
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(src), f + " has an emoji");
  }
  for (const f of ["support-tickets.html", "truckies-lounge.html"]) {
    const html = fs.readFileSync("public/tv/" + f, "utf8");
    assert.match(html, /<script src="\/footer\.js" defer><\/script>/);
    assert.match(html, /rel="icon" href="\/favicon\.svg"/);
    assert.match(html, /name="referrer" content="no-referrer"/);
  }
});
