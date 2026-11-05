import { test } from "node:test";
import assert from "node:assert/strict";
import qrcode from "qrcode-generator";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
delete process.env.RESEND_API_KEY;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const auth = (await import("../netlify/functions/auth.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const pagesFn = (await import("../netlify/functions/pages.mjs")).default;
const compFn = (await import("../netlify/functions/competitions.mjs")).default;
const sitesFn = (await import("../netlify/functions/sites.mjs")).default;
const staffFn = (await import("../netlify/functions/staff.mjs")).default;
const templatesFn = (await import("../netlify/functions/templates.mjs")).default;
const vouchersFn = (await import("../netlify/functions/vouchers.mjs")).default;
const healthFn = (await import("../netlify/functions/health.mjs")).default;
const settingsFn = (await import("../netlify/functions/settings.mjs")).default;
const { competitionReminders } = await import("../netlify/lib/reminders.mjs");
const { melbourneDate } = await import("../netlify/lib/competitions.mjs");
const { checkDestination } = await import("../netlify/lib/health.mjs");
const { redeemVoucher, issueVoucher } = await import("../netlify/lib/vouchers.mjs");

function req(method, url, { cookie, body, ua, idem } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (ua) headers.set("user-agent", ua);
  if (idem) headers.set("idempotency-key", idem);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
  }
  return new Request("http://localhost" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text(), res };
}
function cookies(res) {
  return typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
}
function cookieNamed(res, name) {
  const hit = cookies(res).find((row) => row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function headCookie() {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  return cookieNamed(login, "qr_admin");
}
function qrMatches(svg, url) {
  const q = qrcode(0, "M");
  q.addData(url);
  q.make();
  const cell = 4;
  const margin = 4;
  const count = q.getModuleCount();
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const token = "M" + ((col + margin) * cell) + " " + ((row + margin) * cell) + "h" + cell;
      assert.equal(svg.includes(token), q.isDark(row, col), url + " @" + col + "," + row);
    }
  }
}

test("melbourne dates follow Australia/Melbourne across DST", () => {
  assert.equal(melbourneDate(new Date("2026-11-04T12:59:00Z")), "2026-11-04");
  assert.equal(melbourneDate(new Date("2026-11-04T13:00:00Z")), "2026-11-05");
  assert.equal(melbourneDate(new Date("2026-06-15T13:59:00Z")), "2026-06-15");
  assert.equal(melbourneDate(new Date("2026-06-15T14:00:00Z")), "2026-06-16");
  assert.equal(melbourneDate(new Date("2026-04-04T15:30:00Z")), "2026-04-05");
  assert.equal(melbourneDate(new Date("2026-04-04T16:30:00Z")), "2026-04-05");
});

test("draw reminders use Melbourne day boundaries and ignore drawn or ended competitions", () => {
  const base = { name: "Fuel", slug: "fuel", status: "active", start: "2026-11-01", end: "2026-12-01", schedule: { type: "weekly", count: 4 }, winners: [] };
  assert.deepEqual(competitionReminders(base, "2026-11-07").map((item) => item.kind), ["upcoming-draw"]);
  assert.deepEqual(competitionReminders(base, "2026-11-08").map((item) => item.kind), ["overdue-draw"]);
  assert.equal(competitionReminders(base, "2026-10-30").some((item) => item.kind.endsWith("draw")), false);
  const closing = { ...base, end: "2026-11-08" };
  assert.ok(competitionReminders(closing, "2026-11-01").some((item) => item.kind === "closing"));
  assert.equal(competitionReminders({ ...base, end: "2026-11-09" }, "2026-11-01").some((item) => item.kind === "closing"), false);
  assert.ok(competitionReminders({ ...base, end: "2026-11-04" }, "2026-11-05").some((item) => item.kind === "past-close"));
  assert.equal(competitionReminders({ ...base, status: "ended", end: "2026-11-01" }, "2026-11-08").length, 0);
  const drawn = { ...base, winners: [{ superseded: false }, { superseded: false }, { superseded: false }, { superseded: false }] };
  assert.equal(competitionReminders(drawn, "2026-12-01").some((item) => String(item.kind).includes("draw")), false);
  const moved = { ...base, winners: [{ superseded: false }] };
  assert.equal(competitionReminders(moved, "2026-11-08").some((item) => item.kind === "overdue-draw"), false);
});

test("templates and copies keep a new draft and leave entries, winners, and the original alone", async () => {
  const cookie = await headCookie();
  const created = await read(await compFn(req("POST", "/api/competitions", {
    cookie,
    body: { name: "Spring", slug: "spring-ops", status: "active", prize: "Hat", start: "2026-11-01", end: "2026-12-01", sites: ["North"], siteId: "" },
  })));
  assert.equal(created.status, 201);
  const entry = await read(await compFn(req("POST", "/c/spring-ops", {
    body: { name: "Ada", email: "ada-ops@example.com", phone: "0412000099", over18: "yes", consent: "yes" },
  }), { ip: "203.0.113.20" }));
  assert.equal(entry.body.status, "valid");
  const drawn = await read(await compFn(req("POST", "/api/competitions/spring-ops/draw", { cookie, body: {} })));
  assert.equal(drawn.status, 200);
  const saved = await read(await templatesFn(req("POST", "/api/templates", { cookie, body: { kind: "competition", slug: "spring-ops", name: "Spring template" } })));
  assert.equal(saved.status, 201);
  const stored = await lib.templatesStore().get(saved.body.id, { type: "json" });
  assert.equal(stored.snapshot.winners, undefined);
  assert.equal(stored.snapshot.codeSlug, undefined);
  assert.equal(JSON.stringify(stored).includes("ada-ops@example.com"), false);
  assert.equal(stored.snapshot.voucher.enabled, false);
  const used = await read(await templatesFn(req("POST", "/api/templates/" + saved.body.id + "/use", {
    cookie,
    body: { name: "Spring north", prize: "Cap", start: "2026-12-01", end: "2026-12-20", sites: ["North"] },
  })));
  assert.equal(used.status, 201);
  assert.notEqual(used.body.competition.slug, "spring-ops");
  assert.equal(used.body.competition.status, "draft");
  assert.equal(used.body.competition.codeSlug, "");
  assert.deepEqual(used.body.competition.winners, []);
  assert.equal(used.body.competition.prize, "Cap");
  assert.equal(used.body.competition.voucher.enabled, false);
  const copy = await read(await compFn(req("POST", "/api/competitions/spring-ops/copy", {
    cookie,
    body: { name: "Spring copy", prize: "Mug", start: "2027-01-01", end: "2027-01-31" },
  })));
  assert.equal(copy.status, 201);
  assert.notEqual(copy.body.slug, "spring-ops");
  assert.equal(copy.body.status, "draft");
  assert.deepEqual(copy.body.winners, []);
  const copiedEntries = await read(await compFn(req("GET", "/api/competitions/" + copy.body.slug, { cookie })));
  assert.equal(copiedEntries.body.entries.length, 0);
  const original = await read(await compFn(req("GET", "/api/competitions/spring-ops", { cookie })));
  assert.equal(original.body.competition.status, "active");
  assert.equal(original.body.entries.length, 1);
  assert.equal(original.body.competition.winners.filter((winner) => !winner.superseded).length, 1);

  const page = await read(await pagesFn(req("POST", "/api/pages", { cookie, body: { name: "Welcome", slug: "welcome-ops", status: "published" } })));
  assert.equal(page.status, 201);
  const sent = await read(await pagesFn(req("POST", "/p/welcome-ops", { body: { name: "Ada", email: "ada-page@example.com" } }), { ip: "203.0.113.21" }));
  assert.equal(sent.status, 200);
  const pageTemplate = await read(await templatesFn(req("POST", "/api/templates", { cookie, body: { kind: "page", slug: "welcome-ops" } })));
  const pageCopy = await read(await templatesFn(req("POST", "/api/templates/" + pageTemplate.body.id + "/use", { cookie, body: { name: "Welcome copy" } })));
  assert.equal(pageCopy.body.page.status, "draft");
  const pageDetail = await read(await pagesFn(req("GET", "/api/pages/" + pageCopy.body.page.slug, { cookie })));
  assert.equal(pageDetail.body.submissions.length, 0);
  const originalPage = await read(await pagesFn(req("GET", "/api/pages/welcome-ops", { cookie })));
  assert.equal(originalPage.body.submissions.length, 1);
});

test("poster QR modules encode the stable public URL at A4 and A3", async () => {
  const cookie = await headCookie();
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "Poster", slug: "poster-ops", status: "active", prize: "Sticker", heading: "Poster", body: "Come in" } }));
  for (const size of ["a4", "a3"]) {
    const poster = await read(await compFn(req("GET", "/api/competitions/poster-ops/poster?size=" + size, { cookie })));
    const url = "https://expresshelp.site/c/poster-ops";
    assert.equal(poster.status, 200);
    assert.match(poster.body, size === "a3" ? /A3/ : /A4/);
    assert.match(poster.body, /16mm/);
    assert.match(poster.body, new RegExp(size === "a3" ? "90mm" : "58mm"));
    assert.ok(poster.body.includes(url));
    qrMatches(poster.body, url);
  }
});

test("managers are limited to assigned sites, including guessed ids, exports, and writes", async () => {
  const cookie = await headCookie();
  const north = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "North yard" } })));
  const south = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "South yard" } })));
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "North draw", slug: "north-draw", status: "active", siteId: north.body.id } }));
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "South draw", slug: "south-draw", status: "active", siteId: south.body.id, prize: "Secret prize" } }));
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "Old draw", slug: "old-draw", status: "active" } }));
  await codesFn(req("POST", "/api/codes", { cookie, body: { url: "https://example.com/north", slug: "north-code", siteId: north.body.id, type: "link" } }));
  await codesFn(req("POST", "/api/codes", { cookie, body: { url: "https://example.com/south", slug: "south-code", siteId: south.body.id, type: "link" } }));
  const created = await read(await staffFn(req("POST", "/api/staff", {
    cookie,
    body: { name: "Nina", email: "nina@example.com", password: "correct-horse", siteIds: [north.body.id], role: "head" },
  })));
  assert.equal(created.status, 400);
  const manager = await read(await staffFn(req("POST", "/api/staff", {
    cookie,
    body: { name: "Nina", email: "nina@example.com", password: "correct-horse", siteIds: [north.body.id] },
  })));
  assert.equal(manager.status, 201);
  assert.equal(JSON.stringify(manager.body).includes("correct-horse"), false);
  assert.equal(manager.body.passwordHash, undefined);
  assert.equal(manager.body.role, "manager");
  const login = await auth(req("POST", "/api/auth", { body: { email: "nina@example.com", password: "correct-horse" } }));
  const staffCookie = cookieNamed(login, "qr_staff");
  assert.ok(staffCookie);
  const list = await read(await compFn(req("GET", "/api/competitions", { cookie: staffCookie })));
  assert.deepEqual(list.body.map((row) => row.slug).sort(), ["north-draw"]);
  const guessed = await read(await compFn(req("GET", "/api/competitions/south-draw", { cookie: staffCookie })));
  assert.equal(guessed.status, 403);
  assert.equal(JSON.stringify(guessed.body).includes("Secret"), false);
  const exported = await read(await compFn(req("GET", "/api/competitions/south-draw/export", { cookie: staffCookie })));
  assert.equal(exported.status, 403);
  const write = await read(await compFn(req("PATCH", "/api/competitions/south-draw", { cookie: staffCookie, body: { name: "Taken", siteId: north.body.id } })));
  assert.equal(write.status, 403);
  const still = await read(await compFn(req("GET", "/api/competitions/south-draw", { cookie })));
  assert.equal(still.body.competition.name, "South draw");
  assert.equal(still.body.competition.siteId, south.body.id);
  const oldOne = await read(await compFn(req("GET", "/api/competitions/old-draw", { cookie: staffCookie })));
  assert.equal(oldOne.status, 403);
  const draw = await read(await compFn(req("POST", "/api/competitions/south-draw/draw", { cookie: staffCookie, body: {} })));
  assert.equal(draw.status, 403);
  const metrics = await read(await codesFn(req("GET", "/api/codes/south-code", { cookie: staffCookie })));
  assert.equal(metrics.status, 403);
  const codes = await read(await codesFn(req("GET", "/api/codes", { cookie: staffCookie })));
  assert.deepEqual(codes.body.map((row) => row.slug), ["north-code"]);
  const clearSite = await read(await compFn(req("PATCH", "/api/competitions/north-draw", { cookie: staffCookie, body: { siteId: "" } })));
  assert.equal(clearSite.status, 403);
  const staffWrite = await read(await staffFn(req("PATCH", "/api/staff/" + manager.body.id, { cookie: staffCookie, body: { siteIds: [south.body.id], role: "head" } })));
  assert.equal(staffWrite.status, 403);
  const settings = await read(await settingsFn(req("PATCH", "/api/settings", { cookie: staffCookie, body: { workspaceName: "Hijack" } })));
  assert.equal(settings.status, 403);

  await staffFn(req("PATCH", "/api/staff/" + manager.body.id, { cookie, body: { siteIds: [] } }));
  const revokedSites = await read(await compFn(req("GET", "/api/competitions/north-draw", { cookie: staffCookie })));
  assert.equal(revokedSites.status, 403);
  await staffFn(req("PATCH", "/api/staff/" + manager.body.id, { cookie, body: { siteIds: [north.body.id], disabled: true } }));
  const revoked = await read(await compFn(req("GET", "/api/competitions", { cookie: staffCookie })));
  assert.equal(revoked.status, 401);
  const legacy = await read(await compFn(req("GET", "/api/competitions/old-draw", { cookie })));
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.competition.voucher.enabled, false);
});

test("winner notices are review-only and collection does not replace the winner", async () => {
  const cookie = await headCookie();
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "Notice", slug: "notice-ops", status: "active", prize: "Mug" } }));
  await compFn(req("POST", "/c/notice-ops", { body: { name: "Bea", email: "bea@example.com", over18: "yes", consent: "yes" } }), { ip: "203.0.113.30" });
  const drawn = await read(await compFn(req("POST", "/api/competitions/notice-ops/draw", { cookie, body: {} })));
  const winner = drawn.body.winner;
  const draft = await read(await compFn(req("GET", "/api/competitions/notice-ops/winners/" + winner.id + "/notice", { cookie })));
  assert.equal(draft.body.sent, false);
  assert.equal(draft.body.delivery, "review-only");
  assert.equal(draft.body.to, "bea@example.com");
  assert.match(draft.body.text, /Bea/);
  assert.match(draft.body.text, /has not been sent/);
  const saved = await read(await compFn(req("POST", "/api/competitions/notice-ops/winners/" + winner.id + "/collection", {
    cookie,
    body: { status: "collected", notes: "Picked up" },
  })));
  assert.equal(saved.body.winner.id, winner.id);
  assert.equal(saved.body.winner.entryId, winner.entryId);
  assert.equal(saved.body.winner.name, "Bea");
  assert.equal(saved.body.winner.contact, winner.contact);
  assert.equal(saved.body.winner.collection.status, "collected");
  assert.equal(saved.body.winner.collectionLog.length, 1);
  const blank = { ...winner, id: "wblank", contact: "", name: "" };
  const { winnerNotice } = await import("../netlify/lib/notices.mjs");
  const unknown = winnerNotice({ name: "Notice" }, blank);
  assert.equal(unknown.to, null);
  assert.match(unknown.recipientNote, /No contact/);
  assert.equal(unknown.text.includes("@"), false);
});

test("vouchers stay off, issue once, and redeem exactly once under concurrency", async () => {
  const cookie = await headCookie();
  const legacy = { slug: "legacy-ops", name: "Legacy", status: "active", winners: [], schedule: { type: "single", count: 1 }, fields: [], eligibility: { dedupeEmail: true }, currentPeriod: 1, start: "2026-11-01" };
  await lib.competitionsStore().setJSON("legacy-ops", legacy);
  const before = JSON.stringify(await lib.competitionsStore().get("legacy-ops", { type: "json" }));
  const seen = await read(await compFn(req("GET", "/api/competitions/legacy-ops", { cookie })));
  assert.equal(seen.body.competition.voucher.enabled, false);
  assert.equal(JSON.stringify(await lib.competitionsStore().get("legacy-ops", { type: "json" })), before);
  const entered = await read(await compFn(req("POST", "/c/legacy-ops", { body: { name: "Cam", email: "cam@example.com", over18: "yes", consent: "yes" } }), { ip: "203.0.113.40" }));
  assert.equal(entered.body.voucherToken, undefined);

  const site = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "Voucher yard" } })));
  await compFn(req("POST", "/api/competitions", {
    cookie,
    body: { name: "Offer", slug: "offer-ops", status: "active", siteId: site.body.id, voucher: { enabled: true, label: "", terms: "", expires: "2026-12-01" } },
  }));
  const first = await read(await compFn(req("POST", "/c/offer-ops", {
    idem: "same-key",
    body: { name: "Dee", email: "dee@example.com", over18: "yes", consent: "yes" },
  }), { ip: "203.0.113.41" }));
  const replay = await read(await compFn(req("POST", "/c/offer-ops", {
    idem: "same-key",
    body: { name: "Dee", email: "dee@example.com", over18: "yes", consent: "yes" },
  }), { ip: "203.0.113.41" }));
  assert.equal(first.body.voucherToken.length, 64);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.voucherToken, first.body.voucherToken);
  const detail = await read(await compFn(req("GET", "/api/competitions/offer-ops", { cookie })));
  assert.equal(detail.body.entries.length, 1);
  assert.equal(JSON.stringify(detail.body).includes(first.body.voucherToken), false);
  const listed = await read(await vouchersFn(req("GET", "/api/vouchers", { cookie })));
  assert.equal(JSON.stringify(listed.body).includes(first.body.voucherToken), false);
  assert.equal(listed.body.length, 1);

  const races = await Promise.all(Array.from({ length: 20 }, () => vouchersFn(req("POST", "/api/vouchers/redeem", { cookie, body: { token: first.body.voucherToken } })).then(read)));
  assert.equal(races.filter((row) => row.status === 200).length, 1);
  const again = await read(await vouchersFn(req("POST", "/api/vouchers/redeem", { cookie, body: { token: first.body.voucherToken } })));
  assert.equal(again.status, 400);

  await codesFn(req("POST", "/api/codes", {
    cookie,
    body: { url: "https://example.com/offer", slug: "offer-code", type: "qr", siteId: site.body.id, voucher: { enabled: true, expires: "2026-12-01" } },
  }));
  const statsBefore = await lib.stats().get("offer-code", { type: "json" });
  const claimA = await read(await vouchersFn(req("POST", "/api/vouchers/claim", { ua: "voucher-a", body: { code: "offer-code" } }), { ip: "203.0.113.50" }));
  const claimB = await read(await vouchersFn(req("POST", "/api/vouchers/claim", { ua: "voucher-a", body: { code: "offer-code" } }), { ip: "203.0.113.50" }));
  assert.equal(claimA.body.token, claimB.body.token);
  assert.equal(claimB.body.created, false);
  assert.deepEqual(await lib.stats().get("offer-code", { type: "json" }), statsBefore);
  const audits = await read(await vouchersFn(req("GET", "/api/vouchers", { cookie })));
  assert.equal(audits.body.filter((row) => row.source === "qr").length, 1);

  await compFn(req("PATCH", "/api/competitions/offer-ops", { cookie, body: { voucher: { enabled: false } } }));
  const blocked = await read(await compFn(req("POST", "/c/offer-ops", { body: { name: "Eve", email: "eve@example.com", over18: "yes", consent: "yes" } }), { ip: "203.0.113.42" }));
  assert.equal(blocked.body.voucherToken, undefined);

  const direct = lib.memoryBackend()("race");
  const issued = await issueVoucher(direct, { competition: "c", siteId: "s", source: "entry", sourceId: "e1", expires: "2099-01-01" });
  const parallel = await Promise.all(Array.from({ length: 25 }, () => redeemVoucher(direct, issued.token, { actorId: "head" })));
  assert.equal(parallel.filter((row) => row.ok).length, 1);

  let writes = 0;
  const closed = await redeemVoucher({
    async getWithMetadata() { return { data: { status: "issued", id: "v", expires: "", disabled: false }, etag: "" }; },
    async setJSON() { writes += 1; return { modified: true }; },
  }, "a".repeat(64));
  assert.equal(closed.ok, false);
  assert.equal(writes, 0);
});

test("health checks block private targets and redirects and do not count visits", async () => {
  const calls = [];
  const lookup = async (host) => host === "public.example" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.1.1.1", family: 4 }];
  const fetchImpl = async (url, opts) => {
    calls.push(String(url));
    assert.equal(opts.headers.authorization, undefined);
    assert.equal(opts.headers.cookie, undefined);
    if (String(url).includes("redirect")) return new Response("", { status: 302, headers: { location: "http://127.0.0.1/meta" } });
    if (String(url).includes("deny")) return new Response("no", { status: 403 });
    if (String(url).includes("limit")) return new Response("no", { status: 429 });
    if (String(url).includes("missing")) return new Response("no", { status: 404 });
    if (String(url).includes("down")) return new Response("no", { status: 500 });
    if (String(url).includes("hang")) return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" }))));
    return new Response("ok", { status: 200 });
  };
  const blocked = await checkDestination("http://127.0.0.1/secret", { fetch: fetchImpl, lookup });
  assert.equal(blocked.reason, "blocked");
  assert.equal(calls.length, 0);
  assert.equal((await checkDestination("http://10.0.0.8/", { fetch: fetchImpl, lookup })).reason, "blocked");
  assert.equal((await checkDestination("http://169.254.169.254/", { fetch: fetchImpl, lookup })).reason, "blocked");
  assert.equal((await checkDestination("http://user:pass@public.example/a", { fetch: fetchImpl, lookup })).reason, "credentials");
  assert.equal((await checkDestination("file:///etc/passwd", { fetch: fetchImpl, lookup })).reason, "scheme");
  assert.equal((await checkDestination("http://intranet.local/a", { fetch: fetchImpl, lookup })).reason, "blocked");
  const redirected = await checkDestination("https://public.example/redirect", { fetch: fetchImpl, lookup });
  assert.equal(redirected.reason, "blocked");
  assert.equal(calls.length, 1);
  assert.equal((await checkDestination("https://public.example/deny", { fetch: fetchImpl, lookup })).status, "unknown");
  assert.equal((await checkDestination("https://public.example/limit", { fetch: fetchImpl, lookup })).status, "unknown");
  assert.equal((await checkDestination("https://public.example/missing", { fetch: fetchImpl, lookup })).status, "broken");
  assert.equal((await checkDestination("https://public.example/down", { fetch: fetchImpl, lookup })).status, "broken");
  assert.equal((await checkDestination("https://public.example/ok", { fetch: fetchImpl, lookup })).status, "ok");
  assert.equal((await checkDestination("https://public.example/hang", { fetch: fetchImpl, lookup, timeoutMs: 20 })).reason, "timeout");
  assert.notEqual((await checkDestination("https://public.example/hang", { fetch: fetchImpl, lookup, timeoutMs: 20 })).status, "broken");
  let lookups = 0;
  const flipping = async () => {
    lookups += 1;
    return lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  };
  const rebound = await checkDestination("http://public.example/rebind", { lookup: flipping, timeoutMs: 500 });
  assert.equal(rebound.reason, "blocked");
  assert.equal(lookups >= 2, true);

  const cookie = await headCookie();
  await codesFn(req("POST", "/api/codes", { cookie, body: { url: "http://127.0.0.1/admin", slug: "health-ops", type: "link" } }));
  await lib.stats().setJSON("health-ops", { v: 2, days: {}, scans: 3, clicks: 1, total: 4 });
  const checked = await read(await healthFn(req("POST", "/api/health", { cookie, body: { slug: "health-ops" } })));
  assert.equal(checked.body.checked[0].status, "unknown");
  assert.equal(checked.body.checked[0].reason, "blocked");
  const stats = await lib.stats().get("health-ops", { type: "json" });
  assert.equal(stats.scans, 3);
  assert.equal(stats.total, 4);
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "Closed", slug: "closed-ops", status: "ended", end: "2020-01-01" } }));
  const report = await read(await healthFn(req("GET", "/api/health", { cookie })));
  assert.equal(report.body.promotions.find((row) => row.slug === "closed-ops").status, "expired");
  assert.equal(report.body.links.find((row) => row.slug === "health-ops").status, "unknown");
});
