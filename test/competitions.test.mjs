import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
delete process.env.RESEND_API_KEY;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const auth = (await import("../netlify/functions/auth.mjs")).default;
const compFn = (await import("../netlify/functions/competitions.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;
const redirectFn = (await import("../netlify/functions/redirect.mjs")).default;
const { normalisePhone, normaliseEmail, chooseWinner, melbourneDate } = await import("../netlify/lib/competitions.mjs");

function req(method, url, { cookie, body, ua } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (ua) headers.set("user-agent", ua);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
  }
  return new Request("http://localhost" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}
function cookieOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return (list[0] || "").split(";")[0];
}

test("australian phone and email normalisation", () => {
  assert.equal(normalisePhone("0412 345 678"), "412345678");
  assert.equal(normalisePhone("+61 412 345 678"), "412345678");
  assert.equal(normaliseEmail(" Ada@Example.com "), "ada@example.com");
  assert.match(melbourneDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test("dedupe, weekly draw, archive, and redraw", async () => {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const cookie = cookieOf(login);
  const today = melbourneDate();
  const created = await read(await compFn(req("POST", "/api/competitions", {
    cookie,
    body: {
      name: "Lansvale Free Fuel", slug: "lansvale-free-fuel", status: "active", prize: "Free fuel",
      sites: ["Lansvale"], start: today, schedule: { type: "weekly", count: 8 },
    },
  }), {}));
  assert.equal(created.status, 201);
  assert.equal(created.body.schedule.count, 8);

  const hidden = await compFn(req("GET", "/c/does-not-exist"), { ip: "203.0.113.5" });
  assert.equal(hidden.status, 404);

  const page = await compFn(req("GET", "/c/lansvale-free-fuel", { ua: "Mozilla/5.0 (iPhone) Safari" }), { ip: "203.0.113.5" });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Lansvale Free Fuel/);

  const enter = (extra) => compFn(req("POST", "/c/lansvale-free-fuel", { body: extra }), { ip: "203.0.113.5" });
  const ada = await read(await enter({ name: "Ada", email: "ada@example.com", phone: "0412000001", receipt: "R-100", over18: "yes", consent: "yes" }));
  assert.equal(ada.body.status, "valid");
  const dupeEmail = await read(await enter({ name: "Ada Two", email: "Ada@Example.com", phone: "0412000002", receipt: "R-200", over18: "yes", consent: "yes" }));
  assert.equal(dupeEmail.body.status, "duplicate");
  assert.match(dupeEmail.body ? "" : "", /.*/);
  const detailAfter = await read(await compFn(req("GET", "/api/competitions/lansvale-free-fuel", { cookie }), {}));
  const dupe = detailAfter.body.entries.find((e) => e.contactNorm === "adatwo@example.com" || e.name === "Ada Two");
  assert.equal(dupe.status, "duplicate");
  assert.match(dupe.duplicateReason, /email/i);

  const sameReceipt = await read(await enter({ name: "Bea", email: "bea@example.com", receipt: "r100", over18: "yes", consent: "yes" }));
  assert.equal(sameReceipt.body.status, "duplicate");

  const cam = await read(await enter({ name: "Cam", email: "cam@example.com", phone: "0412000003", receipt: "R-300", over18: "yes", consent: "yes" }));
  assert.equal(cam.body.status, "valid");

  const drawn = await read(await compFn(req("POST", "/api/competitions/lansvale-free-fuel/draw", { cookie, body: {} }), {}));
  assert.equal(drawn.status, 200);
  assert.equal(drawn.body.winner.poolSize, 2);
  assert.equal(drawn.body.competition.currentPeriod, 2);
  assert.equal(drawn.body.winner.pool, "period-1");

  const again = await read(await enter({ name: "Ada", email: "ada@example.com", receipt: "R-400", over18: "yes", consent: "yes" }));
  assert.equal(again.body.status, "valid");
  const reused = await read(await enter({ name: "Dee", email: "dee@example.com", receipt: "R-100", over18: "yes", consent: "yes" }));
  assert.equal(reused.body.status, "duplicate");

  const redraw = await read(await compFn(req("POST", "/api/competitions/lansvale-free-fuel/draw", { cookie, body: { redraw: true, drawNumber: 1 } }), {}));
  assert.equal(redraw.status, 200);
  assert.equal(redraw.body.winner.drawNumber, 1);
  assert.equal(redraw.body.winner.redraw, true);
  assert.notEqual(redraw.body.winner.entryId, drawn.body.winner.entryId);

  const after = await read(await compFn(req("GET", "/api/competitions/lansvale-free-fuel", { cookie }), {}));
  assert.equal(after.body.stats.winnersDrawn, 1);
  assert.equal(after.body.stats.drawsRemaining, 7);
  assert.ok(after.body.stats.duplicates >= 3);
  const superseded = after.body.competition.winners.filter((w) => w.drawNumber === 1 && w.superseded);
  assert.equal(superseded.length, 1);

  const empty = chooseWinner([{ id: "x", period: 3, status: "duplicate" }], 3);
  assert.match(empty.error, /No valid entries/);
});

test("import keeps sheet duplicate status and a short link can point at the entry page", async () => {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  const cookie = cookieOf(login);
  await compFn(req("POST", "/api/competitions", { cookie, body: { name: "Import cup", slug: "import-cup", status: "active", start: melbourneDate() } }), {});
  const imported = await read(await compFn(req("POST", "/api/competitions/import-cup/import", {
    cookie,
    body: { entries: [
      { "Entry ID": "e-old-1", Name: "Ada", Contact: "ada@example.com", "Contact Type": "email", "Normalised Contact": "ada@example.com", Status: "valid", Timestamp: "2026-10-01T00:00:00.000Z" },
      { "Entry ID": "e-old-2", Name: "Ada", Contact: "ada@example.com", "Contact Type": "email", "Duplicate Reason": "Same email", Status: "duplicate", "Matched Entry ID": "e-old-1" },
    ] },
  }), {}));
  assert.equal(imported.body.imported, 2);
  const detail = await read(await compFn(req("GET", "/api/competitions/import-cup", { cookie }), {}));
  assert.equal(detail.body.stats.valid, 1);
  assert.equal(detail.body.stats.duplicates, 1);

  const code = await read(await codesFn(req("POST", "/api/codes", {
    cookie,
    body: { url: "https://expresshelp.site/c/import-cup", name: "Import cup", type: "qr", alsoLink: true },
  }), { params: {} }));
  assert.equal(code.status, 201);
  assert.equal(code.body.hasQr, true);
  assert.equal(code.body.hasLink, true);
  const hit = await redirectFn(req("GET", "/r/" + code.body.slug), { params: { slug: code.body.slug }, ip: "203.0.113.30", geo: {} });
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get("location"), "https://expresshelp.site/c/import-cup");
});
