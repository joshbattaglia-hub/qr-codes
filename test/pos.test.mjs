import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const auth = (await import("../netlify/functions/auth.mjs")).default;
const sitesFn = (await import("../netlify/functions/sites.mjs")).default;
const staffFn = (await import("../netlify/functions/staff.mjs")).default;
const compFn = (await import("../netlify/functions/competitions.mjs")).default;
const posFn = (await import("../netlify/functions/pos-drafts.mjs")).default;
const { PATTERNS } = await import("../netlify/lib/code128.mjs");
const { issueVoucher, redeemVoucher } = await import("../netlify/lib/vouchers.mjs");

function req(method, url, { cookie, body, origin, fetchSite } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  if (fetchSite) headers.set("sec-fetch-site", fetchSite);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json(), res };
  if (type.includes("zip")) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), res };
  return { status: res.status, body: await res.text(), res };
}
function cookieNamed(res, name) {
  const rows = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function headCookie() {
  const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
  return cookieNamed(login, "qr_admin");
}
const cookie = await headCookie();

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}
function unzip(buf) {
  const files = {};
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const crc = buf.readUInt32LE(offset + 14);
    const size = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extra = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLen + extra;
    const data = buf.subarray(start, start + size);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    assert.equal(method, 0, name);
    assert.equal(crc, crc32(data), name);
    assert.match(name, /^[a-z0-9.-]+$/);
    files[name] = data.toString("utf8");
    offset = start + size;
  }
  return files;
}

/** Reads bar geometry only. Does not call the encoder. */
function decodeCode128(svg) {
  const width = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  const dark = new Uint8Array(width);
  for (const match of svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="80"/g)) {
    dark.fill(1, Number(match[1]), Number(match[1]) + Number(match[2]));
  }
  const modules = [];
  for (let x = 0; x < width; x += 2) {
    if (dark[x] !== dark[x + 1]) throw new Error("split module");
    modules.push(dark[x]);
  }
  const first = modules.indexOf(1);
  const last = modules.lastIndexOf(1);
  assert.ok(first >= 10, "leading quiet zone");
  assert.ok(modules.length - 1 - last >= 10, "trailing quiet zone");
  const runs = [];
  let count = 1;
  for (let i = first + 1; i <= last; i++) {
    if (modules[i] === modules[i - 1]) count++;
    else { runs.push(count); count = 1; }
  }
  runs.push(count);
  const symbols = [];
  let cursor = 0;
  while (cursor < runs.length) {
    const six = runs.slice(cursor, cursor + 6).join("");
    const sixIndex = six.length === 6 ? PATTERNS.indexOf(six) : -1;
    if (sixIndex >= 0 && sixIndex !== 106) {
      symbols.push(sixIndex);
      cursor += 6;
      continue;
    }
    const seven = runs.slice(cursor, cursor + 7).join("");
    assert.equal(seven, "2331112");
    symbols.push(106);
    cursor += 7;
    break;
  }
  assert.equal(cursor, runs.length);
  assert.equal(symbols[0], 104);
  assert.equal(PATTERNS[0], "212222");
  assert.equal(PATTERNS[33], "111323");
  assert.equal(PATTERNS[104], "211214");
  assert.equal(PATTERNS[106], "2331112");
  const data = symbols.slice(1, -2);
  const checksum = symbols.at(-2);
  let sum = 104;
  data.forEach((symbol, index) => { sum += symbol * (index + 1); });
  assert.equal(sum % 103, checksum);
  return String.fromCharCode(...data.map((symbol) => symbol + 32));
}

const offer = {
  offer: "Saturday fuel",
  conditions: "One fill, in store",
  start: "2026-11-01",
  end: "2026-11-30",
  posRedemption: "single-use",
};

test("draft fields round-trip in a provisional package and the barcode decodes", async () => {
  const north = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "North" } })));
  const south = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "=South, \"pump\"" } })));
  const created = await read(await posFn(req("POST", "/api/pos-drafts", {
    cookie,
    body: { ...offer, siteIds: [north.body.id, south.body.id], codeValue: "EH-POS-AB" },
  })));
  assert.equal(created.status, 201);
  assert.equal(created.body.confirmationStatus, "pending");
  assert.equal(created.body.codeType, "code128");
  assert.equal(created.body.compatibility, "unconfirmed");
  assert.match(created.body.codeValue, /^EH-POS-AB$/);
  const packed = await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id + "/package", { cookie })));
  assert.equal(packed.status, 200);
  assert.match(packed.res.headers.get("content-disposition"), /^attachment; filename="pos-setup-p[a-f0-9]{8}\.zip"$/);
  const files = unzip(packed.body);
  assert.deepEqual(Object.keys(files).sort(), ["barcode.svg", "config.json", "provisional.csv", "request-email.txt", "setup-instructions.txt"]);
  const config = JSON.parse(files["config.json"]);
  assert.equal(config.offer, "Saturday fuel");
  assert.equal(config.conditions, "One fill, in store");
  assert.equal(config.start, "2026-11-01");
  assert.equal(config.end, "2026-11-30");
  assert.equal(config.timezone, "Australia/Melbourne");
  assert.match(config.validity, /00:00:00 Australia\/Melbourne on 2026-11-01 inclusive through 23:59:59 Australia\/Melbourne on 2026-11-30 inclusive/);
  assert.deepEqual(config.sites.map((site) => site.id).sort(), [north.body.id, south.body.id].sort());
  assert.equal(config.posRedemption, "single-use");
  assert.equal(config.codeType, "code128");
  assert.equal(config.codeValue, "EH-POS-AB");
  assert.equal(config.confirmationStatus, "pending");
  assert.equal(config.compatibility, "unconfirmed");
  assert.match(config.warning, /not confirmed/);
  assert.match(files["provisional.csv"], /not a Quickfuel/);
  assert.match(files["provisional.csv"], /Australia\/Melbourne/);
  assert.match(files["provisional.csv"], new RegExp(north.body.id));
  assert.match(files["setup-instructions.txt"], /does not activate a web voucher/);
  assert.match(files["request-email.txt"], /REVIEW ONLY/);
  assert.match(files["request-email.txt"], /has not been sent/);
  assert.equal(files["request-email.txt"].includes("@"), false);
  assert.equal(decodeCode128(files["barcode.svg"]), "EH-POS-AB");
  const artwork = await read(await posFn(req("GET", "/api/pos-drafts/" + created.body.id + "/barcode.svg", { cookie })));
  assert.equal(decodeCode128(artwork.body), "EH-POS-AB");
});

test("dates, barcode values, unknown sites, and unsupported formats are rejected", async () => {
  const badDate = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, end: "2026-10-01" } })));
  assert.equal(badDate.status, 400);
  const impossible = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, end: "2026-02-31" } })));
  assert.equal(impossible.status, 400);
  const symbols = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, codeValue: "bad\nvalue" } })));
  assert.equal(symbols.status, 400);
  const format = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, codeType: "ean13", codeValue: "0123456789055" } })));
  assert.equal(format.status, 400);
  assert.match(format.body.error, /Code 128/);
  const missing = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, siteIds: ["s00000000"] } })));
  assert.equal(missing.status, 400);
  const confirmed = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, confirmationStatus: "confirmed" } })));
  assert.equal(confirmed.status, 400);
});

test("barcode values collide instead of overwriting, and exports escape active content", async () => {
  const first = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, codeValue: "SHARED-1" } })));
  const second = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, offer: "Other", codeValue: "SHARED-1" } })));
  assert.equal(second.status, 409);
  const still = await read(await posFn(req("GET", "/api/pos-drafts/" + first.body.id, { cookie })));
  assert.equal(still.body.offer, "Saturday fuel");
  const raced = await Promise.all([
    posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, codeValue: "RACE-1" } })),
    posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, offer: "Loser", codeValue: "RACE-1" } })),
  ]);
  const statuses = (await Promise.all(raced.map(read))).map((row) => row.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const hostile = await read(await posFn(req("POST", "/api/pos-drafts", {
    cookie,
    body: {
      ...offer,
      offer: '=HYPERLINK("http://evil.test")',
      conditions: "line\r\nBcc: hidden@evil.test\n<script>",
      codeValue: "A&<B>",
    },
  })));
  const packed = await read(await posFn(req("GET", "/api/pos-drafts/" + hostile.body.id + "/package", { cookie })));
  const files = unzip(packed.body);
  assert.match(files["provisional.csv"], /'=HYPERLINK/);
  assert.equal(files["provisional.csv"].includes("\r"), false);
  assert.equal(files["request-email.txt"].split("\n").some((line) => /^bcc:/i.test(line)), false);
  assert.equal(files["barcode.svg"].includes("<script"), false);
  assert.match(files["barcode.svg"], /A&amp;&lt;B&gt;/);
  assert.equal(decodeCode128(files["barcode.svg"]), "A&<B>");
  assert.equal(Object.keys(files).some((name) => name.includes("..") || name.includes("/")), false);
});

test("a pending draft cannot activate a web voucher, and reusable does not change single-use redemption", async () => {
  const before = await read(await compFn(req("GET", "/api/competitions", { cookie })));
  const draft = await read(await posFn(req("POST", "/api/pos-drafts", {
    cookie,
    body: { ...offer, posRedemption: "reusable", status: "active", enabled: true, voucher: { enabled: true } },
  })));
  assert.equal(draft.body.confirmationStatus, "pending");
  assert.equal(draft.body.posRedemption, "reusable");
  const after = await read(await compFn(req("GET", "/api/competitions", { cookie })));
  assert.equal(after.body.length, before.body.length);
  const comp = await read(await compFn(req("POST", "/api/competitions", {
    cookie,
    body: { name: "Keep offer", slug: "keep-offer", status: "active", voucher: { enabled: true, label: "Coffee", terms: "One cup", expires: "2026-12-31", maxIssues: 5 } },
  })));
  const snapshot = await lib.competitionsStore().get("keep-offer", { type: "json" });
  assert.equal(snapshot.voucher.enabled, true);
  await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, posRedemption: "reusable", codeValue: "REUSE-1" } }));
  const again = await lib.competitionsStore().get("keep-offer", { type: "json" });
  assert.deepEqual(again.voucher, snapshot.voucher);
  const issued = await issueVoucher(lib.vouchersStore(), { competition: "keep-offer", source: "test", sourceId: "person", expires: "2026-12-31", label: "Coffee" });
  const first = await redeemVoucher(lib.vouchersStore(), issued.token);
  const second = await redeemVoucher(lib.vouchersStore(), issued.token);
  assert.equal(first.ok, true);
  assert.equal(second.conflict, true);
  const packed = await read(await posFn(req("GET", "/api/pos-drafts/" + draft.body.id + "/package", { cookie })));
  const files = unzip(packed.body);
  const joined = Object.values(files).join("\n");
  assert.equal(joined.includes(issued.token), false);
  assert.match(files["setup-instructions.txt"], /stay single-use/);
});

test("managers cannot view, export, or reassign another site", async () => {
  const north = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "Manager North" } })));
  const south = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "Manager South" } })));
  await staffFn(req("POST", "/api/staff", { cookie, body: { name: "Nora", email: "nora@example.com", password: "north-pass-1", siteIds: [north.body.id] } }));
  const login = await auth(req("POST", "/api/auth", { body: { email: "nora@example.com", password: "north-pass-1" } }));
  const manager = cookieNamed(login, "qr_staff");
  const own = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: manager, body: { ...offer, siteIds: [north.body.id], codeValue: "NORTH-1" } })));
  assert.equal(own.status, 201);
  const foreign = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, siteIds: [south.body.id], codeValue: "SOUTH-1" } })));
  const loose = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, body: { ...offer, siteIds: [], codeValue: "LOOSE-1" } })));
  const list = await read(await posFn(req("GET", "/api/pos-drafts", { cookie: manager })));
  assert.equal(list.body.some((row) => row.id === own.body.id), true);
  assert.equal(list.body.some((row) => row.id === foreign.body.id || row.id === loose.body.id), false);
  assert.equal((await read(await posFn(req("GET", "/api/pos-drafts/" + foreign.body.id, { cookie: manager })))).status, 403);
  assert.equal((await read(await posFn(req("GET", "/api/pos-drafts/" + foreign.body.id + "/package", { cookie: manager })))).status, 403);
  assert.equal((await read(await posFn(req("DELETE", "/api/pos-drafts/" + foreign.body.id, { cookie: manager })))).status, 403);
  const moved = await read(await posFn(req("PATCH", "/api/pos-drafts/" + own.body.id, { cookie: manager, body: { siteIds: [south.body.id] } })));
  assert.equal(moved.status, 403);
  const emptied = await read(await posFn(req("PATCH", "/api/pos-drafts/" + own.body.id, { cookie: manager, body: { siteIds: [] } })));
  assert.equal(emptied.status, 403);
  const unassigned = await read(await posFn(req("POST", "/api/pos-drafts", { cookie: manager, body: { ...offer, siteIds: [] } })));
  assert.equal(unassigned.status, 403);
  const kept = await read(await posFn(req("GET", "/api/pos-drafts/" + foreign.body.id, { cookie })));
  assert.deepEqual(kept.body.siteIds, [south.body.id]);
});

test("anonymous and cross-site writes are refused", async () => {
  assert.equal((await read(await posFn(req("GET", "/api/pos-drafts")))).status, 401);
  const blocked = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, origin: "https://evil.test", body: offer })));
  assert.equal(blocked.status, 403);
  const fetched = await read(await posFn(req("POST", "/api/pos-drafts", { cookie, fetchSite: "cross-site", body: offer })));
  assert.equal(fetched.status, 403);
});
