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
  { id: "s00000a06", name: "Synthetic Unattended Moe", loc: "LOC0106", address: "92-98 Albert St, Moe VIC 3825", lat: -38.17, lng: 146.26, siteType: "unattended" },
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
  assert.equal(sd.normaliseAbn("11111"), null, "only the exact 1111 placeholder is allowed");
  assert.equal(sd.normaliseAbn("11111111111"), null, "11 ones still fail the checksum");
  assert.equal(sd.normaliseAbn("1111"), sd.PLACEHOLDER_ABN);
  assert.equal(sd.normaliseAbn(" 1111 "), sd.PLACEHOLDER_ABN, "placeholder spacing is ignored");
  assert.equal(sd.normaliseAbn(""), "");
  assert.equal(sd.normaliseSitePhone("(03) 9113-7191"), "03 9113 7191");
  assert.equal(sd.normaliseSitePhone("+61 412 345 678"), "0412 345 678");
  assert.equal(sd.normaliseSitePhone("call me"), null);
  for (const w of ["Commission Agent", "agent", "commission_agent", "CA", "LOC CA", "loc-ca"]) assert.equal(sd.normaliseSiteType(w), "commission_agent", w);
  for (const w of ["Liberty", "company", "Company run", "VEA Retail", "VEA"]) assert.equal(sd.normaliseSiteType(w), "company", w);
  for (const w of ["Unattended", "unattended", "unattended_site", "unmanned", "Unattended service station"]) assert.equal(sd.normaliseSiteType(w), "unattended", w);
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
  const u = sd.displaySite({ id: "s5", name: "E", siteType: "unattended", abn: SYN_AGENT_ABN, tradingName: "Synthetic Unattended Pty Ltd" }, company);
  assert.equal(u.type, "unattended");
  assert.equal(u.tradingName, "Synthetic Unattended Pty Ltd", "Unattended sites use their own trading name");
  assert.equal(u.abn, SYN_AGENT_ABN, "Unattended sites use their own ABN, not the central VEA Retail one");
  assert.equal(u.phone, "03 9113 7191");
  const bareU = sd.displaySite({ id: "s6", name: "F", siteType: "unattended" }, company);
  assert.equal(bareU.tradingName, ""); assert.equal(bareU.abn, "");
  const viva = sd.displaySite({ id: "s7", name: "G", siteType: "unattended", abn: "1111" }, company);
  assert.equal(viva.abn, "1111", "the 1111 placeholder is shown on Unattended cards");
  assert.equal(viva.tradingName, "");
  assert.equal(sd.usesCompanyDetails("unattended"), false);
  assert.equal(sd.usesCompanyDetails("company"), true);
  assert.equal(sd.usesCompanyDetails(""), true, "untyped sites count as VEA Retail");
  assert.equal(sd.usesCompanyDetails("commission_agent"), false);
});

test("public site directory: the visitor picker lists only Unattended sites, not VEA Retail or LOC CA", async () => {
  sd.clearSiteDirectoryCache();
  const r = await j(H.call("GET", "/api/visit/sites"));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /public/);
  assert.equal(r.body.picker, "unattended");
  const names = r.body.sites.map((s) => s.name);
  assert.deepEqual(names, ["Synthetic Unattended Moe"]);
  assert.ok(!names.includes("Synthetic Held Site"), "held sites are not offered");
  assert.ok(!names.includes("Synthetic Ballarat North") && !names.includes("Synthetic Bendigo East") && !names.includes("Synthetic Geelong West"), "retail sites stay out of the picker");
  assert.equal(r.body.picker, "unattended");
  assert.equal(r.body.total, 1); assert.equal(r.body.withCoordinates, 1);
  assert.deepEqual(names, ["Synthetic Unattended Moe"]);
  assert.equal(r.body.sites[0].type, "unattended");
  const keys = new Set(r.body.sites.flatMap((s) => Object.keys(s)));
  for (const k of keys) assert.ok(["id", "loc", "name", "suburb", "type", "address", "tradingName", "abn", "phone", "phoneHref", "lat", "lng", "picker", "proposed"].includes(k), "unexpected public field " + k);
  const full = await sd.publicSiteDirectory({ picker: false });
  assert.ok(full.sites.some((s) => s.name === "Synthetic Ballarat North"), "the master list still has retail sites");
  assert.ok(full.sites.some((s) => s.type === "company"));
  assert.ok(full.sites.some((s) => s.type === "commission_agent"));
  assert.equal((await sd.publicSiteDirectory({ picker: true })).sites.every((s) => s.type === "unattended"), true);
});

test("company details: owner-only setting, ABN checked, saved centrally and shown on every company site", async () => {
  const bad = await j(H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51 824 753 557", tradingName: "X" } }));
  assert.equal(bad.status, 400);
  const anon = await j(H.call("POST", "/api/visitor-log/company", { body: { abn: SYN_LIBERTY_ABN } }));
  assert.equal(anon.status, 401);
  const ok = await j(H.call("POST", "/api/visitor-log/company", { cookie: owner, body: { abn: "51824753556", tradingName: "Synthetic Liberty Trading" } }));
  assert.equal(ok.status, 200); assert.equal(ok.body.abn, SYN_LIBERTY_ABN);
  sd.clearSiteDirectoryCache();
  const dir = (await sd.publicSiteDirectory({ picker: false })).sites;
  assert.ok(dir.some((s) => s.type === "company"));
  for (const s of dir.filter((x) => x.type === "company")) { assert.equal(s.abn, SYN_LIBERTY_ABN); assert.equal(s.tradingName, "Synthetic Liberty Trading"); }
  const unatt = dir.find((s) => s.type === "unattended");
  assert.ok(unatt); assert.equal(unatt.abn, ""); assert.equal(unatt.tradingName, "");
  const picker = (await j(H.call("GET", "/api/visit/sites"))).body.sites;
  assert.ok(picker.every((s) => s.type === "unattended"));
  assert.ok(!picker.some((s) => s.type === "company" || s.type === "commission_agent"));
  assert.equal(picker[0].abn, "", "Unattended sites do not inherit the central VEA Retail ABN");
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
  assert.equal(view.body.counts.total, 5);
  assert.equal(view.body.counts.unattended, 1);
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

test("deploy previews are look-only for the Visitor Log: POSTs are refused before anything runs; production and GETs are unaffected", async () => {
  const pub = await import("../netlify/functions/visitor-public.mjs");
  const adm = await import("../netlify/functions/visitor-admin.mjs");
  const before = await storeDump();
  const post = (path, body) => new Request("https://preview.example" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const r1 = await pub.default(post("/api/visit/sign-in", { location: "x" }), { deploy: { context: "deploy-preview" } });
  assert.equal(r1.status, 403); assert.match((await r1.json()).error, /preview/);
  const r2 = await adm.default(post("/api/visitor-log/company", { abn: "51824753556" }), { deploy: { context: "branch-deploy" } });
  assert.equal(r2.status, 403);
  const r3 = await pub.default(new Request("https://preview.example/api/visit/sites"), { deploy: { context: "deploy-preview" } });
  assert.equal(r3.status, 200, "the site list can still be viewed on a preview");
  assert.equal(pub.previewReadOnly(new Request("https://x/api/visit/sign-in", { method: "POST" }), { deploy: { context: "production" } }), false);
  assert.equal(pub.previewReadOnly(new Request("https://x/api/visit/sign-in", { method: "POST" }), undefined), false);
  assert.equal(pub.previewReadOnly(new Request("https://expresshelp.site/api/visit/sign-in", { method: "POST" }), { deploy: { context: "production" } }), false);
  const aliasPost = new Request("https://visitor-unattended-pr67--liberty-qr-353.netlify.app/api/visit/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(pub.previewReadOnly(aliasPost, { deploy: { context: "production" } }), true, "CLI draft/alias URLs are look-only even if context says production");
  assert.equal(pub.previewReadOnly(aliasPost, undefined), true);
  const aliasBlocked = await pub.default(aliasPost, { deploy: { context: "production" } });
  assert.equal(aliasBlocked.status, 403);
  assert.deepEqual(await storeDump(), before);
});

test("sign-out: the picked site narrows duplicate name matches, is optional, is recorded, and never blocks a unique name match", async () => {
  const photo2 = photo();
  const signIn = (name, company, siteId, k) => j(H.call("POST", "/api/visit/sign-in", { body: { name, phone: "0400 000 0" + k, company, location: "typed", siteId, photo: photo2, idempotencyKey: "so-" + k + "-aaaaaaaaaaaaaaaaaaaa" } }));
  assert.equal((await signIn("Dup Synthetic", "Twin Co", "s00000a01", "11")).status, 200);
  assert.equal((await signIn("Dup Synthetic", "Twin Co", "s00000a03", "12")).status, 200);
  const out = (body) => j(H.call("POST", "/api/visit/sign-out", { body: { cardReturned: true, ...body } }));
  const amb = await out({ name: "Dup Synthetic", company: "Twin Co" });
  assert.equal(amb.status, 400, "two open visits, no site: still refused as before");
  const ok = await out({ name: "Dup Synthetic", company: "Twin Co", siteId: "s00000a03" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const visits = async () => { const { blobs } = await lib.visitorStore().list({ prefix: "visit/" }); return Promise.all(blobs.map((x) => lib.visitorStore().get(x.key, { type: "json" }))); };
  let dups = (await visits()).filter((v) => v.name === "Dup Synthetic");
  assert.equal(dups.find((v) => v.site.siteId === "s00000a03").signedOutAt !== "", true);
  assert.equal(dups.find((v) => v.site.siteId === "s00000a01").signedOutAt, "", "the other visit stays open");
  // Unique match with a different (or typed) site: signs out, records what was given, keeps the sign-in snapshot.
  const last = await out({ name: "Dup Synthetic", company: "Twin Co", location: "Somewhere typed" });
  assert.equal(last.status, 200);
  dups = (await visits()).filter((v) => v.name === "Dup Synthetic");
  const v1 = dups.find((v) => v.site.siteId === "s00000a01");
  assert.ok(v1.signedOutAt); assert.equal(v1.signOutLocation, "Somewhere typed"); assert.equal(v1.site.from, undefined);
  const listed = (await j(H.call("GET", "/api/visitor-log/visits", { cookie: owner }))).body.visits.find((v) => v.id === v1.id);
  assert.equal(listed.signOutSite, "Somewhere typed"); assert.equal(listed.siteFrom, "sign-in");
  assert.equal(H.mailbox.filter((m) => !/code is \d{8}/.test(m.text || "")).length, 0);
});

test("labels: visitors and admins see VEA Retail, LOC CA and Unattended, never the old Liberty site / Commission agent tags", () => {
  const js = fs.readFileSync("public/visit/site-pick.js", "utf8");
  assert.match(js, /"LOC CA"/);
  assert.match(js, /"VEA Retail"/);
  assert.match(js, /"Unattended"/);
  assert.ok(!js.includes('"Liberty site"') && !js.includes('"Commission agent"'));
  const app = fs.readFileSync("public/admin/app.js", "utf8");
  for (const t of ["VEA Retail sites", "All LOC CA sites", "Unattended sites", "LOC CA sites", ">VEA Retail</span>", "LOC CA site", ">Unattended</span>"]) assert.ok(app.includes(t), t);
  for (const t of [">Company sites<", "All commission agents", ">Liberty</span>", '"Commission agents"']) assert.ok(!app.includes(t), t);
});

test("CSV import can add a new Unattended site after preview, and will not add a name that already exists", async () => {
  const csv = [
    "loc,site_name,site_type,address,phone",
    ",Synthetic Unattended Horsham,unattended,\"170-172 Firebrace St, Horsham VIC 3400\",03 9113 7191",
    "LOC0106,Synthetic Unattended Moe,unattended,,",
    "LOC9998,,unattended,,,",
    "LOC9997,Synthetic Ballarat North,unattended,,",
  ].join("\n");
  const before = await storeDump();
  const prev = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv } }));
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.dryRun, true);
  assert.deepEqual(await storeDump(), before, "preview writes nothing");
  const byLine = Object.fromEntries(prev.body.rows.map((r) => [r.line, r]));
  assert.equal(byLine[2].action, "add");
  assert.equal(byLine[2].site.added, true);
  assert.equal(byLine[2].site.name, "Synthetic Unattended Horsham");
  assert.equal(byLine[3].action, "update");
  assert.equal(byLine[3].site.id, "s00000a06");
  assert.match(byLine[4].errors[0], /No site with LOC LOC9998/);
  assert.match(byLine[5].errors[0], /already belongs to/);
  assert.equal(prev.body.summary.added, 1);
  const applied = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv, dryRun: false, confirm: "APPLY" } }));
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.written, 1);
  const addRow = applied.body.rows.find((r) => r.action === "add");
  assert.ok(addRow.site.id && /^s[a-f0-9]{8}$/.test(addRow.site.id));
  const created = await lib.sitesStore().get(addRow.site.id, { type: "json" });
  assert.equal(created.siteType, "unattended");
  assert.equal(created.name, "Synthetic Unattended Horsham");
  assert.match(created.address, /Horsham/);
  sd.clearSiteDirectoryCache();
  const picker = (await j(H.call("GET", "/api/visit/sites"))).body.sites.map((s) => s.name).sort();
  assert.deepEqual(picker, ["Synthetic Unattended Horsham", "Synthetic Unattended Moe"]);
  const view = await j(H.call("GET", "/api/visitor-log/site-details", { cookie: owner }));
  assert.equal(view.body.counts.unattended, 2);
});

test("CSV import accepts the 1111 placeholder ABN on an Unattended site and still rejects other invalid ABNs", async () => {
  const csv = [
    "site_name,abn",
    "Synthetic Unattended Moe,1111",
    "Synthetic Unattended Moe,1234",
  ].join("\n");
  const prev = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv: "site_name,abn\nSynthetic Unattended Moe,1111" } }));
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.dryRun, true);
  assert.equal(prev.body.summary.changed, 1);
  assert.deepEqual(prev.body.rows[0].changes.abn, ["", "1111"]);
  assert.deepEqual(Object.keys(prev.body.rows[0].changes), ["abn"]);
  const bad = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv: "site_name,abn\nSynthetic Unattended Moe,1234" } }));
  assert.equal(bad.status, 200);
  assert.match(bad.body.rows[0].errors[0], /ABN/);
  const applied = await j(H.call("POST", "/api/visitor-log/site-details/import", { cookie: owner, body: { csv: "site_name,abn\nSynthetic Unattended Moe,1111", dryRun: false, confirm: "APPLY" } }));
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.written, 1);
  const moe = await lib.sitesStore().get("s00000a06", { type: "json" });
  assert.equal(moe.abn, "1111");
  assert.equal(moe.address, SITES[5].address, "only ABN is written");
  assert.equal(moe.phone, SITES[5].phone);
  sd.clearSiteDirectoryCache();
  const card = (await j(H.call("GET", "/api/visit/sites"))).body.sites.find((s) => s.name === "Synthetic Unattended Moe");
  assert.equal(card.abn, "1111");
});


test("deploy previews overlay proposed Unattended sites on the picker without writing them; production is unchanged", async () => {
  const pub = await import("../netlify/functions/visitor-public.mjs");
  const before = await storeDump();
  sd.clearSiteDirectoryCache();
  const preview = await pub.default(new Request("https://preview.example/api/visit/sites"), { deploy: { context: "deploy-preview" } });
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.ok(body.proposed >= 25, "proposed Unattended sites are overlaid on a preview");
  const moe = body.sites.find((s) => s.name === "Reddy Express Moe");
  assert.equal(moe?.type, "unattended");
  assert.equal(moe?.proposed, true);
  assert.ok(!body.sites.some((s) => s.type === "company" || s.type === "commission_agent"), "retail sites stay out of the picker");
  assert.deepEqual(await storeDump(), before, "the overlay is not written");
  sd.clearSiteDirectoryCache();
  const live = await j(H.call("GET", "/api/visit/sites"));
  assert.ok(!live.body.sites.some((s) => s.name === "Reddy Express Moe"), "production/test list is only stored Unattended sites");
  sd.clearSiteDirectoryCache();
  const alias = await pub.default(new Request("https://visitor-unattended-pr67--liberty-qr-353.netlify.app/api/visit/sites"), { deploy: { context: "production" } });
  const aliasBody = await alias.json();
  assert.ok(aliasBody.proposed >= 25, "CLI draft/alias URLs overlay proposed sites even if context says production");
  assert.ok(aliasBody.sites.some((s) => s.name === "Reddy Express Moe" && s.proposed));
  assert.deepEqual(await storeDump(), before);
});


const SYN_UNATTENDED_ABN = "20 000 000 190";

test("site manager: add, edit, hide, unhide, soft-remove and restore; past snapshots stay; picker types are a setting", async () => {
  const beforeVisits = await (async () => {
    const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
    return Promise.all(blobs.map((x) => lib.visitorStore().get(x.key, { type: "json" })));
  })();
  const snapBefore = beforeVisits.filter((v) => v.site).map((v) => ({ id: v.id, site: v.site }));

  const anon = await j(H.call("POST", "/api/visitor-log/sites", { body: { name: "Nope", siteType: "unattended" } }));
  assert.equal(anon.status, 401);

  const badAbn = await j(H.call("POST", "/api/visitor-log/sites", { cookie: owner, body: { name: "Synthetic Manager New", siteType: "unattended", abn: "51 824 753 557", address: "1 Test St, Moe VIC 3825" } }));
  assert.equal(badAbn.status, 400); assert.match(badAbn.body.error, /ABN/);

  const created = await j(H.call("POST", "/api/visitor-log/sites", { cookie: owner, body: { name: "Synthetic Manager New", siteType: "unattended", loc: "LOC0801", address: "1 Test St, Moe VIC 3825", phone: "03 9113 7191", tradingName: "Synthetic Manager Pty Ltd", abn: SYN_UNATTENDED_ABN, lat: -38.172, lng: 146.261 } }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.siteType, "unattended");
  assert.equal(created.body.tradingName, "Synthetic Manager Pty Ltd");
  assert.equal(created.body.abn, SYN_UNATTENDED_ABN);
  assert.equal(created.body.visibility, "visible");
  assert.equal(created.body.inPicker, true);
  const id = created.body.id;
  assert.match(id, /^s[a-f0-9]{8}$/);

  const clash = await j(H.call("POST", "/api/visitor-log/sites", { cookie: owner, body: { name: "Synthetic Manager New", siteType: "unattended" } }));
  assert.equal(clash.status, 409);

  const edited = await j(H.call("POST", "/api/visitor-log/sites/" + id, { cookie: owner, body: { name: "Synthetic Manager New", siteType: "unattended", loc: "LOC0801", address: "2 Test St, Moe VIC 3825", phone: "03 9113 7191", tradingName: "Synthetic Manager Pty Ltd", abn: SYN_UNATTENDED_ABN, lat: -38.172, lng: 146.261 } }));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.match(edited.body.address, /2 Test St/);

  sd.clearSiteDirectoryCache();
  const inPicker = (await j(H.call("GET", "/api/visit/sites"))).body.sites.map((s) => s.name);
  assert.ok(inPicker.includes("Synthetic Manager New"));

  const hidden = await j(H.call("POST", "/api/visitor-log/sites/" + id + "/hide", { cookie: owner, body: {} }));
  assert.equal(hidden.status, 200); assert.equal(hidden.body.visibility, "hidden"); assert.equal(hidden.body.inPicker, false);
  sd.clearSiteDirectoryCache();
  assert.ok(!(await j(H.call("GET", "/api/visit/sites"))).body.sites.some((s) => s.id === id), "hidden sites leave the picker");

  const unhidden = await j(H.call("POST", "/api/visitor-log/sites/" + id + "/unhide", { cookie: owner, body: {} }));
  assert.equal(unhidden.status, 200); assert.equal(unhidden.body.visibility, "visible");

  const noConfirm = await j(H.call("POST", "/api/visitor-log/sites/" + id + "/remove", { cookie: owner, body: {} }));
  assert.equal(noConfirm.status, 400);
  const removed = await j(H.call("POST", "/api/visitor-log/sites/" + id + "/remove", { cookie: owner, body: { confirm: "REMOVE" } }));
  assert.equal(removed.status, 200); assert.equal(removed.body.visibility, "removed");
  assert.ok(await lib.sitesStore().get(id, { type: "json" }), "remove is a soft archive, the record stays");
  sd.clearSiteDirectoryCache();
  assert.ok(!(await j(H.call("GET", "/api/visit/sites"))).body.sites.some((s) => s.id === id));
  const list = await j(H.call("GET", "/api/visitor-log/site-details", { cookie: owner }));
  assert.ok(list.body.sites.some((s) => s.id === id && s.archived));
  assert.ok(list.body.counts.removed >= 1);

  const restored = await j(H.call("POST", "/api/visitor-log/sites/" + id + "/restore", { cookie: owner, body: {} }));
  assert.equal(restored.status, 200); assert.equal(restored.body.visibility, "visible");

  const types = await j(H.call("POST", "/api/visitor-log/picker-types", { cookie: owner, body: { types: ["company"] } }));
  assert.equal(types.status, 200); assert.deepEqual(types.body.types, ["company"]);
  sd.clearSiteDirectoryCache();
  const onlyCompany = (await j(H.call("GET", "/api/visit/sites"))).body;
  assert.equal(onlyCompany.picker, "company");
  assert.ok(onlyCompany.sites.every((s) => s.type === "company"));
  assert.ok(!onlyCompany.sites.some((s) => s.id === id), "Unattended leaves the picker when only VEA Retail is ticked");
  const back = await j(H.call("POST", "/api/visitor-log/picker-types", { cookie: owner, body: { types: ["unattended"] } }));
  assert.equal(back.status, 200); assert.deepEqual(back.body.types, ["unattended"]);

  const { blobs } = await lib.visitorStore().list({ prefix: "visit/" });
  const after = await Promise.all(blobs.map((x) => lib.visitorStore().get(x.key, { type: "json" })));
  const snapAfter = after.filter((v) => v.site).map((v) => ({ id: v.id, site: v.site }));
  assert.deepEqual(snapAfter, snapBefore, "past sign-in snapshots were not rewritten");
});

test("geocode looks up only the address, is rate-limited, stores nothing, and is mocked with no network", async () => {
  const calls = [];
  sd.setSiteDetailHooks({
    geocode: async (url, opts) => {
      calls.push({ url, ua: opts?.headers?.["User-Agent"] || opts?.headers?.["user-agent"] });
      return { ok: true, json: async () => [{ lat: "-38.1721", lon: "146.2612", display_name: "1 Test St, Moe VIC 3825, Australia" }] };
    },
  });
  const before = await storeDump();
  const anon = await j(H.call("GET", "/api/visitor-log/sites/geocode?address=1%20Test%20St%20Moe"));
  assert.equal(anon.status, 401);
  const ok = await j(H.call("GET", "/api/visitor-log/sites/geocode?address=" + encodeURIComponent("1 Test St, Moe VIC 3825"), { cookie: owner }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.lat, -38.1721);
  assert.equal(ok.body.lng, 146.2612);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /nominatim\.openstreetmap\.org\/search/);
  assert.match(calls[0].url, /countrycodes=au/);
  assert.ok(!/visitor|photo|phone=0400/i.test(calls[0].url), "only the address is sent");
  assert.match(calls[0].ua, /ExpressHelp-site-manager/);
  assert.deepEqual(await storeDump(), before, "geocode does not write sites");
  const blank = await j(H.call("GET", "/api/visitor-log/sites/geocode?address=", { cookie: owner }));
  assert.equal(blank.status, 400);
  sd.setSiteDetailHooks({});
});

test("preview deploys refuse site manager writes and picker-type changes; geocode GET still works", async () => {
  const adm = await import("../netlify/functions/visitor-admin.mjs");
  const before = await storeDump();
  const post = (path, body) => adm.default(new Request("https://preview.example" + path, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify(body) }), { deploy: { context: "deploy-preview" } });
  for (const [path, body] of [
    ["/api/visitor-log/sites", { name: "Preview Should Not Add", siteType: "unattended" }],
    ["/api/visitor-log/picker-types", { types: ["company"] }],
    ["/api/visitor-log/sites/s00000a06/hide", {}],
    ["/api/visitor-log/sites/s00000a06/remove", { confirm: "REMOVE" }],
  ]) {
    const res = await post(path, body);
    assert.equal(res.status, 403, path);
  }
  sd.setSiteDetailHooks({ geocode: async () => ({ ok: true, json: async () => [{ lat: "-38.17", lon: "146.26", display_name: "Moe" }] }) });
  const geo = await adm.default(new Request("https://preview.example/api/visitor-log/sites/geocode?address=Moe", { headers: { cookie: owner } }), { deploy: { context: "deploy-preview" } });
  assert.equal(geo.status, 200, "address lookup is a GET, so previews can still try it");
  assert.deepEqual(await storeDump(), before);
  sd.setSiteDetailHooks({});
});
