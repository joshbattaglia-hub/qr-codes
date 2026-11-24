import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";

/** Site picker + site details on the visitor forms. Synthetic sites, synthetic ABNs, in-memory store, mail mocked, no network. */
const H = await import("./support/browser-harness.mjs");
const lib = await import("../netlify/lib/lib.mjs");
const sd = await import("../netlify/lib/site-details.mjs");
const owner = await H.otpCookie(H.JOSHUA);
const SYN_LIBERTY_ABN = "51 824 753 556";
const SYN_AGENT_ABN = "10 000 110 866";
const photo = () => jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 80).data.toString("base64");
const j = async (p) => { const r = await p; const t = r.headers.get("content-type") || ""; return { status: r.status, headers: r.headers, body: t.includes("json") ? await r.json() : await r.text() }; };

const SITES = [
  { id: "s00000a01", name: "Synthetic Ballarat North", loc: "LOC0101", address: "1 Example Rd, Ballarat North VIC 3350", lat: -37.53, lng: 143.86 },
  { id: "s00000a02", name: "Synthetic Bendigo East", loc: "LOC0102", address: "2 Sample St, Bendigo VIC 3550", lat: -36.76, lng: 144.29, siteType: "commission_agent", tradingName: "Synthetic Agent Pty Ltd", abn: SYN_AGENT_ABN, phone: "0412345678" },
  { id: "s00000a03", name: "Synthetic Geelong West", loc: "LOC0103", address: "3 Test Ave, Geelong West VIC 3218", siteType: "company" },
  { id: "s00000a04", name: "Synthetic Held Site", loc: "LOC0104", hold: true },
  { id: "s00000a05", name: "Synthetic Agent No Details", loc: "LOC0105", siteType: "commission_agent" },
];
for (const s of SITES) await lib.sitesStore().setJSON(s.id, s);
async function storeDump() {
  const out = {};
  for (const name of ["sites", "settings"]) {
    const store = name === "sites" ? lib.sitesStore() : lib.settingsStore();
    const { blobs } = await store.list();
    for (const b of blobs) out[name + "/" + b.key] = JSON.stringify(await store.get(b.key, { type: "json" }));
  }
  return out;
}

test("normalisers: ABN checksum, AU phone, site type words, CSV quoting", () => {
  assert.equal(sd.normaliseAbn("51824753556"), SYN_LIBERTY_ABN);
  assert.equal(sd.normaliseAbn("51 824 753 557"), null, "checksum fails");
  assert.equal(sd.normaliseAbn("1234"), null);
  assert.equal(sd.normaliseAbn(""), "");
  assert.equal(sd.normaliseSitePhone("(03) 9113-7191"), "03 9113 7191");
  assert.equal(sd.normaliseSitePhone("+61 412 345 678"), "0412 345 678");
  assert.equal(sd.normaliseSitePhone("call me"), null);
  for (const w of ["Commission Agent", "agent", "commission_agent", "CA"]) assert.equal(sd.normaliseSiteType(w), "commission_agent", w);
  for (const w of ["Liberty", "company", "Company run"]) assert.equal(sd.normaliseSiteType(w), "company", w);
  assert.equal(sd.normaliseSiteType("franchise"), null);
  assert.deepEqual(sd.parseCsv('\ufeffloc,trading_name\r\nLOC1,"Smith, Jones ""& Co"""\n\n'), [["loc", "trading_name"], ["LOC1", 'Smith, Jones "& Co"']]);
});

test("display rules: company sites use the one Liberty setting, agents their own, empty fields hidden, phone defaults to 03 9113 7191", () => {
  const company = { abn: SYN_LIBERTY_ABN, tradingName: "Synthetic Liberty Trading" };
  const a = sd.displaySite({ id: "s1", name: "A", siteType: "company", abn: SYN_AGENT_ABN, tradingName: "Ignored" }, company);
  assert.equal(a.tradingName, "Synthetic Liberty Trading"); assert.equal(a.abn, SYN_LIBERTY_ABN, "a company site never shows its own ABN");
  assert.equal(a.phone, "03 9113 7191"); assert.equal(a.phoneHref, "tel:0391137191");
  const untyped = sd.displaySite({ id: "s2", name: "B" }, company);
  assert.equal(untyped.type, "company", "a site without a type counts as a Liberty site");
  const agent = sd.displaySite({ id: "s3", name: "C", siteType: "commission_agent", tradingName: "Agent Co", abn: SYN_AGENT_ABN, phone: "0412 345 678" }, company);
  assert.equal(agent.tradingName, "Agent Co"); assert.equal(agent.abn, SYN_AGENT_ABN); assert.equal(agent.phone, "0412 345 678");
  const bare = sd.displaySite({ id: "s4", name: "D", siteType: "commission_agent" }, { abn: "", tradingName: "" });
  assert.equal(bare.tradingName, ""); assert.equal(bare.abn, ""); assert.equal(bare.address, "");
});

test("public site directory: active sites only, display fields only, nothing about visitors, map points when known", async () => {
  sd.clearSiteDirectoryCache();
  const r = await j(H.call("GET", "/api/visit/sites"));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /public/);
  const names = r.body.sites.map((s) => s.name);
  assert.ok(!names.includes("Synthetic Held Site"), "held sites are not offered");
  assert.equal(r.body.total, 4); assert.equal(r.body.withCoordinates, 2);
  const keys = new Set(r.body.sites.flatMap((s) => Object.keys(s)));
  for (const k of keys) assert.ok(["id", "loc", "name", "suburb", "type", "address", "tradingName", "abn", "phone", "phoneHref", "lat", "lng"].includes(k), "unexpected public field " + k);
  const agent = r.body.sites.find((s) => s.loc === "LOC0102");
  assert.equal(agent.type, "commission_agent"); assert.equal(agent.tradingName, "Synthetic Agent Pty Ltd"); assert.equal(agent.phone, "0412 345 678");
});

test("company details: owner-only setting, ABN checked, saved centrally and shown on every company site", async () => {
  const bad = await j(H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51 824 753 557", tradingName: "X" } }));
  assert.equal(bad.status, 400);
  const anon = await j(H.call("POST", "/api/visitor-log/company", { body: { abn: SYN_LIBERTY_ABN } }));
  assert.equal(anon.status, 401);
  const ok = await j(H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51824753556", tradingName: "Synthetic Liberty Trading" } }));
  assert.equal(ok.status, 200); assert.equal(ok.body.abn, SYN_LIBERTY_ABN);
  sd.clearSiteDirectoryCache();
  const dir = (await j(H.call("GET", "/api/visit/sites"))).body.sites;
  for (const s of dir.filter((x) => x.type === "company")) { assert.equal(s.abn, SYN_LIBERTY_ABN); assert.equal(s.tradingName, "Synthetic Liberty Trading"); }
});

test("sign-in with a picked site stores a snapshot (name, LOC, type, trading name, ABN); typed sites still work; no coordinates are accepted or stored", async () => {
  const base = { name: "Synthetic Visitor", phone: "0400 000 001", company: "Synthetic Co", photo: photo() };
  const a = await j(H.call("POST", "/api/visit/sign-in", { body: { ...base, location: "whatever was typed", siteId: "s00000a02", lat: -37.1, lng: 144.1, idempotencyKey: "k-site-1-aaaaaaaaaaaaaaaa" } }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await j(H.call("POST", "/api/visit/sign-in", { body: { ...base, name: "Typed Visitor", location: "Some unlisted yard", idempotencyKey: "k-site-2-aaaaaaaaaaaaaaaa" } }));
  assert.equal(b.status, 200);
  const c = await j(H.call("POST", "/api/visit/sign-in", { body: { ...base, name: "Bogus Id", location: "Typed fallback", siteId: "s00000a04", idempotencyKey: "k-site-3-aaaaaaaaaaaaaaaa" } }));
  assert.equal(c.status, 200, "a held or unknown site id falls back to the typed text");
  const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
  const visits = await Promise.all(blobs.map((x) => lib.visitorStore().get(x.key, { type: "json" })));
  const agentVisit = visits.find((v) => v.name === "Synthetic Visitor");
  assert.equal(agentVisit.location, "Synthetic Bendigo East (LOC0102)");
  assert.deepEqual(agentVisit.site, { siteId: "s00000a02", loc: "LOC0102", name: "Synthetic Bendigo East", siteType: "commission_agent", tradingName: "Synthetic Agent Pty Ltd", abn: SYN_AGENT_ABN });
  assert.ok(!JSON.stringify(visits).includes("-37.1") && !JSON.stringify(visits).includes("144.1"), "visitor coordinates are never stored");
  assert.equal(visits.find((v) => v.name === "Typed Visitor").site, undefined);
  assert.equal(visits.find((v) => v.name === "Bogus Id").location, "Typed fallback");
  assert.equal(H.mailbox.filter((m) => !/code is \d{8}/.test(m.text || "")).length, 0, "no visitor notification email was sent (notifications off in tests)");
  // Later edits to the site never rewrite the snapshot.
  await lib.sitesStore().setJSON("s00000a02", { ...SITES[1], tradingName: "Renamed Later Pty Ltd" });
  const again = await lib.visitorStore().get("visit/" + agentVisit.id, { type: "json" });
  assert.equal(again.site.tradingName, "Synthetic Agent Pty Ltd");
  await lib.sitesStore().setJSON("s00000a02", SITES[1]);
});

test("log filters: All, Company sites (with older untagged sign-ins), each commission agent; older rows are read as untagged without any write", async () => {
  const legacyId = "v" + "c".repeat(32);
  const legacy = { id: legacyId, location: "Old typed site", name: "Legacy Visitor", phone: "0400 000 009", company: "Old Co", signedInAt: new Date(Date.now() - 86400000).toISOString(), signedOutAt: "", photoStatus: "none" };
  await lib.visitorStore().setJSON("visit/" + legacyId, legacy);
  const before = JSON.stringify(await lib.visitorStore().get("visit/" + legacyId, { type: "json" }));
  const list = async (q) => (await j(H.call("GET", "/api/visitor-log/visits?" + q, { cookie: owner }))).body;
  const all = await list("");
  assert.ok(all.visits.length >= 4);
  const company = await list("siteType=company");
  assert.ok(company.visits.every((v) => v.siteType !== "commission_agent"));
  assert.ok(company.visits.some((v) => v.name === "Legacy Visitor" && v.siteType === "untagged"));
  const agents = all.agents.map((a) => a.label);
  assert.ok(agents.includes("Synthetic Agent Pty Ltd"));
  assert.ok(agents.some((l) => l.startsWith("Synthetic Agent No Details")), "an agent site without a trading name still gets a filter");
  const key = all.agents.find((a) => a.label === "Synthetic Agent Pty Ltd").key;
  assert.equal(key, "abn:10000110866");
  const one = await list("siteType=agent&agent=" + encodeURIComponent(key));
  assert.deepEqual(one.visits.map((v) => v.name), ["Synthetic Visitor"]);
  assert.equal(one.visits[0].tradingName, "Synthetic Agent Pty Ltd"); assert.equal(one.visits[0].abn, SYN_AGENT_ABN);
  const untagged = await list("siteType=untagged");
  assert.ok(untagged.visits.every((v) => v.siteType === "untagged"));
  assert.equal(JSON.stringify(await lib.visitorStore().get("visit/" + legacyId, { type: "json" })), before, "no migration write");
  const csv = await j(H.call("GET", "/api/visitor-log/export", { cookie: owner }));
  assert.match(csv.body.split("\n")[0], /photo_status","?site_type"?,"?trading_name"?,"?abn"?$|photo_status,site_type,trading_name,abn$/);
});

test("CSV import: preview writes nothing, flags problems, needs an explicit apply; apply writes only good rows and keeps every other field", async () => {
  const csv = [
    "LOC,Site name,Type,Trading name,ABN,Phone,Address,Latitude,Longitude,Notes",
    "LOC0101,,company,,,,,,,",
    'LOC0103,Synthetic Geelong West,commission agent,"Geelong Agent, Pty Ltd",10000110866,(03) 5555 0000,,-38.15,144.35,x',
    "LOC0102,,,,12345678901,,,,,",
    "LOC9999,,company,,,,,,,",
    ",Synthetic Agent No Details,,Synthetic Bare Agent,,,,,,",
    "LOC0101,,company,,,,,,,",
  ].join("\r\n");
  const before = await storeDump();
  const prev = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv } }));
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.dryRun, true);
  assert.deepEqual(await storeDump(), before, "preview writes nothing");
  assert.deepEqual(prev.body.ignoredColumns, ["Notes"]);
  const byLine = Object.fromEntries(prev.body.rows.map((r) => [r.line, r]));
  assert.deepEqual(byLine[2].changes, { site_type: ["", "company"] });
  assert.deepEqual(byLine[3].changes.site_type, ["company", "commission_agent"]);
  assert.deepEqual(byLine[3].changes.phone, ["", "03 5555 0000"]);
  assert.deepEqual(byLine[3].changes.trading_name, ["", "Geelong Agent, Pty Ltd"]);
  assert.match(byLine[4].errors[0], /ABN/);
  assert.match(byLine[5].errors[0], /No site with LOC LOC9999/);
  assert.equal(byLine[6].site.id, "s00000a05", "matched on exact name when loc is blank");
  assert.match(byLine[7].errors[0], /earlier row/);
  assert.equal(prev.body.summary.errors, 3);
  const noConfirm = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv, dryRun: false } }));
  assert.equal(noConfirm.status, 400);
  assert.deepEqual(await storeDump(), before);
  const anon = await j(H.call("POST", "/api/visitor-log/site-details/import", { body: { csv } }));
  assert.equal(anon.status, 401);
  const applied = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv, dryRun: false, confirm: "APPLY" } }));
  assert.equal(applied.status, 200); assert.equal(applied.body.written, 3);
  const geelong = await lib.sitesStore().get("s00000a03", { type: "json" });
  assert.equal(geelong.siteType, "commission_agent"); assert.equal(geelong.abn, SYN_AGENT_ABN); assert.equal(geelong.lat, -38.15);
  assert.equal(geelong.address, SITES[2].address, "untouched fields stay"); assert.equal(geelong.name, "Synthetic Geelong West");
  const bendigo = await lib.sitesStore().get("s00000a02", { type: "json" });
  assert.equal(bendigo.abn, SYN_AGENT_ABN, "a row with an error is not written at all");
  const clear = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv: "loc,phone\nLOC0103,CLEAR", dryRun: false, confirm: "APPLY" } }));
  assert.equal(clear.status, 200);
  assert.equal((await lib.sitesStore().get("s00000a03", { type: "json" })).phone, undefined, "CLEAR removes the override, so the default phone shows again");
  const dl = await j(H.call("GET", "/api/visitor-log/site-details.csv", { cookie: owner }));
  assert.equal(dl.status, 200);
  assert.equal(dl.body.split("\n")[0], sd.CSV_COLUMNS.join(","));
  assert.ok(!dl.body.includes("Synthetic Held Site"));
  const view = await j(H.call("GET", "/api/visitor-log/site-details", { cookie: owner }));
  assert.equal(view.body.defaultPhone, "03 9113 7191");
  assert.equal(view.body.counts.total, 4);
});

test("privacy: location is only asked for on the button tap, worked out in the browser, and never sent", () => {
  const js = fs.readFileSync("public/visit/site-pick.js", "utf8");
  const calls = js.split("getCurrentPosition").length - 1;
  assert.equal(calls, 1);
  const handler = js.slice(js.indexOf('nearBtn.addEventListener("click"'));
  assert.ok(handler.includes("getCurrentPosition"), "geolocation sits inside the button's click handler");
  assert.ok(!/watchPosition/.test(js));
  assert.ok(!/fetch\([^)]*(lat|coords)/.test(js), "coordinates are never put in a request");
  for (const page of ["public/visit/sign-in.html", "public/visit.html"]) {
    const html = fs.readFileSync(page, "utf8");
    assert.ok(html.includes('/visit/site-pick.js'));
    assert.ok(!/geolocation/.test(html));
    assert.match(html, /siteId: data\.get\("siteId"\)/);
    assert.ok(!/\blat\b|coords/.test(html.slice(html.indexOf("build: async"))), "the sign-in payload carries no coordinates");
  }
  assert.ok(!/=>|\bconst\b|\blet\b|`/.test(js), "plain ES5 for older browsers");
});
