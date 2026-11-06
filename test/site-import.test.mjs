import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { classifyImport, planImport, rowsFromDocument } from "../netlify/lib/site-import.mjs";

process.env.ADMIN_PASSWORD = "test-pass";
delete process.env.NETLIFY_AUTH_TOKEN;
delete process.env.NETLIFY_SITE_ID;

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const auth = (await import("../netlify/functions/auth.mjs")).default;
const sitesFn = (await import("../netlify/functions/sites.mjs")).default;
const staffFn = (await import("../netlify/functions/staff.mjs")).default;
const codesFn = (await import("../netlify/functions/codes.mjs")).default;

function req(method, url, { cookie, body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function read(res) {
  return { status: res.status, body: await res.json() };
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
const login = await auth(req("POST", "/api/auth", { body: { password: "test-pass" } }));
const cookie = cookieNamed(login, "qr_admin");

test("import holds explicit conflicts and does not infer state or special-case names", async () => {
  const preview = await read(await sitesFn(req("POST", "/api/sites/import", { cookie, body: { rows: [
    { loc: "LOC18421", name: "Margate", address: "1 Margate Road", operationalRegion: "North", hold: true, holdReason: "LOC18421 also appears as Boggabilla" },
    { loc: "LOC18421B", name: "Boggabilla", address: "1 Boggabilla Road", operationalRegion: "North", geographicState: "", sourceRef: "src-bogg", sourceName: "Boggabilla" },
    { loc: "LOC18300", name: "Morwell", address: "825 Mickleham Road", operationalRegion: "West", hold: true, holdReason: "Address belongs to Greenvale in the source" },
    { loc: "LOC1354", name: "Tingalpa", address: "1354 Wynnum Road", operationalRegion: "East" },
  ] } })));
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.counts.held, 2);
  assert.equal(preview.body.counts.create, 2);
  assert.equal(preview.body.rows.find((row) => row.name === "Boggabilla").status, "create");
  const applied = await read(await sitesFn(req("POST", "/api/sites/import", { cookie, body: { dryRun: false, rows: [
    { loc: "LOC18421", name: "Margate", address: "1 Margate Road", operationalRegion: "North", hold: true, holdReason: "LOC18421 also appears as Boggabilla" },
    { loc: "LOC18421B", name: "Boggabilla", address: "1 Boggabilla Road", operationalRegion: "North", geographicState: "", sourceRef: "src-bogg", sourceName: "Boggabilla" },
    { loc: "LOC18300", name: "Morwell", address: "825 Mickleham Road", operationalRegion: "West", hold: true, holdReason: "Address belongs to Greenvale in the source" },
    { loc: "LOC1354", name: "Tingalpa", address: "1354 Wynnum Road", operationalRegion: "East" },
  ] } })));
  assert.equal(applied.body.counts.create, 2);
  const stored = await lib.sitesStore().get(applied.body.rows.find((row) => row.name === "Boggabilla").siteId, { type: "json" });
  assert.equal(stored.geographicState, "");
  assert.equal(stored.operationalRegion, "North");
  assert.equal(stored.address, "1 Boggabilla Road");
  assert.notEqual(stored.id, stored.loc);
  assert.match(stored.id, /^s[a-f0-9]{8}$/);
});

test("duplicates, ambiguous matches, and reruns do not overwrite ids or links", async () => {
  const existing = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "Greenvale" } })));
  const code = await read(await codesFn(req("POST", "/api/codes", { cookie, body: { url: "https://example.com/greenvale", name: "Greenvale code", siteId: existing.body.id } })));
  const staffBefore = (await read(await staffFn(req("GET", "/api/staff", { cookie })))).body.length;
  const rows = [
    { loc: "LOC9", name: "Greenvale", address: "825 Mickleham Road", operationalRegion: "Metro", geographicState: "VIC", sourceRef: "sheet-9", sourceName: "Greenvale" },
    { loc: "LOC10", name: "Same Name", address: "10 First Street", operationalRegion: "North" },
    { loc: "LOC11", name: "Same Name", address: "11 Second Street", operationalRegion: "South" },
    { loc: "LOC12", name: "Shared Address A", address: "1354 Wynnum Road", operationalRegion: "East" },
    { loc: "LOC13", name: "Shared Address B", address: "1354 Wynnum Road", operationalRegion: "East" },
  ];
  const first = await read(await sitesFn(req("POST", "/api/sites/import", { cookie, body: { dryRun: false, rows } })));
  assert.equal(first.body.counts.held >= 4, true);
  const matched = first.body.rows.find((row) => row.loc === "LOC9" && row.status === "update");
  assert.equal(matched.siteId, existing.body.id);
  const saved = await lib.sitesStore().get(existing.body.id, { type: "json" });
  assert.equal(saved.name, "Greenvale");
  assert.equal(saved.loc, "LOC9");
  assert.equal(saved.address, "825 Mickleham Road");
  assert.equal(saved.geographicState, "VIC");
  assert.equal(saved.operationalRegion, "Metro");
  const linked = await read(await codesFn(req("GET", "/api/codes/" + code.body.slug, { cookie })));
  assert.equal(linked.body.code.siteId, existing.body.id);
  const again = await read(await sitesFn(req("POST", "/api/sites/import", { cookie, body: { dryRun: false, rows: [rows[0]] } })));
  assert.equal(again.body.counts.unchanged, 1);
  assert.equal(again.body.counts.create, 0);
  assert.equal(again.body.counts.update, 0);
  assert.equal((await lib.sitesStore().get(existing.body.id, { type: "json" })).name, "Greenvale");
  assert.equal((await read(await staffFn(req("GET", "/api/staff", { cookie })))).body.length, staffBefore);
  const clash = await read(await sitesFn(req("POST", "/api/sites/import", { cookie, body: { dryRun: true, rows: [{ loc: "LOC99", name: "Different", address: "825 Mickleham Road", operationalRegion: "Metro" }] } })));
  assert.equal(clash.body.rows[0].status, "held");
  const audit = await read(await sitesFn(req("GET", "/api/sites/import", { cookie })));
  assert.equal(JSON.stringify(audit.body).includes("825 Mickleham"), false);
  assert.equal(JSON.stringify(audit.body).includes("NETLIFY"), false);
});

test("a sites document keeps spellings, holds, and unknown state without inferring a region", () => {
  const doc = { sites: [
    { loc_id: "100", name: "Alpha (NSW)", address: "1 Shared Street", operational_region: "NORTH GROUP", geographic_state: "unknown", import_disposition: "CLEAR" },
    { loc_id: "200", name: "Beta", address: "1 Shared Street", operational_region: "NORTH GROUP", geographic_state: "VIC", import_disposition: "HOLD" },
    { loc_id: "300", name: "Gamma", address: "9 Other Road", operational_region: "SOUTH GROUP", geographic_state: "QLD", import_disposition: "CLEAR" },
    { loc_id: "300", name: "Delta", address: "8 Delta Road", operational_region: "SOUTH GROUP", geographic_state: "QLD", import_disposition: "HOLD" },
  ] };
  const report = classifyImport([], rowsFromDocument(doc));
  assert.equal(report.counts.create, 1);
  assert.equal(report.counts.held, 3);
  const alpha = report.plan.find((row) => row.loc === "100");
  assert.equal(alpha.name, "Alpha (NSW)");
  assert.equal(alpha.geographicState, "");
  assert.equal(alpha.operationalRegion, "NORTH GROUP");
  assert.equal(alpha.sourceFlags.includes("geographic_state_unknown"), true);
  assert.equal(alpha.sourceFlags.includes("shared_address"), true);
  assert.equal(report.plan.find((row) => row.name === "Beta").status, "held");
  assert.equal(report.plan.find((row) => row.name === "Gamma").status, "held");
  const file = "/home/ubuntu/.cursor/projects/workspace/uploads/parsed-sites_bab9.json";
  if (!fs.existsSync(file)) return;
  const supplied = classifyImport([], rowsFromDocument(JSON.parse(fs.readFileSync(file, "utf8"))));
  assert.equal(supplied.counts.rows, 93);
  assert.equal(supplied.counts.held, 3);
  assert.equal(supplied.counts.create, 90);
  assert.equal(new Set(supplied.plan.map((row) => row.loc)).size, 92);
  const held = supplied.plan.filter((row) => row.status === "held").map((row) => row.loc + " " + row.name).sort();
  assert.deepEqual(held, ["18300 Morwell", "18421 Boggabilla", "18421 Margate"]);
  for (const loc of ["18328", "18416"]) {
    const row = supplied.plan.find((item) => item.loc === loc);
    assert.equal(row.status, "create");
    assert.equal(row.sourceFlags.includes("shared_address"), true);
  }
  const unknown = supplied.plan.filter((row) => row.sourceFlags.includes("geographic_state_unknown"));
  assert.equal(unknown.length, 17);
  assert.equal(unknown.every((row) => row.geographicState === "" && row.geographicState !== row.operationalRegion), true);
});

test("a live dry-run reads existing sites and a second apply keeps ids and links", async () => {
  const existing = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "Keep Link" } })));
  const code = await read(await codesFn(req("POST", "/api/codes", { cookie, body: { url: "https://example.com/keep", name: "Keep code", siteId: existing.body.id } })));
  await staffFn(req("POST", "/api/staff", { cookie, body: { name: "Una", email: "una-import@example.com", password: "manager-pass-1", siteIds: [existing.body.id] } }));
  const staffBefore = JSON.stringify(await read(await staffFn(req("GET", "/api/staff", { cookie }))));
  const inner = lib.sitesStore();
  let writes = 0;
  const watching = {
    get: (...args) => inner.get(...args),
    getWithMetadata: (...args) => inner.getWithMetadata(...args),
    list: (...args) => inner.list(...args),
    delete: (...args) => inner.delete(...args),
    setJSON: async (...args) => { writes += 1; return inner.setJSON(...args); },
  };
  const conflict = rowsFromDocument({ sites: [{ loc_id: "777", name: "Not Keep", address: "1 Keep Street", operational_region: "NORTH", operational_region_parent: "NORTH", operational_region_sub: "A", geographic_state: "VIC", import_disposition: "CLEAR", source_section_fidelity: "exact" }] });
  const preview = await planImport(watching, conflict, { apply: false });
  assert.equal(preview.storeRead, true);
  assert.equal(preview.wrote, false);
  assert.equal(writes, 0);
  assert.equal(preview.report.counts.create, 1);
  const first = await planImport(inner, conflict, { apply: true });
  const createdId = first.report.rows[0].siteId;
  const stored = await inner.get(createdId, { type: "json" });
  assert.equal(stored.operationalRegionParent, "NORTH");
  assert.equal(stored.sourceSectionFidelity, "exact");
  assert.equal(stored.name, "Not Keep");
  const second = await planImport(inner, conflict, { apply: true });
  assert.equal(second.report.counts.unchanged, 1);
  assert.equal(second.report.counts.create, 0);
  assert.equal((await inner.get(createdId, { type: "json" })).id, createdId);
  assert.equal((await read(await codesFn(req("GET", "/api/codes/" + code.body.slug, { cookie })))).body.code.siteId, existing.body.id);
  assert.equal(JSON.stringify(await read(await staffFn(req("GET", "/api/staff", { cookie })))), staffBefore);
  const clash = rowsFromDocument({ sites: [{ loc_id: "777", name: "Different", address: "9 Other", operational_region: "SOUTH", geographic_state: "QLD", import_disposition: "CLEAR" }] });
  const held = await planImport(inner, clash, { apply: true });
  assert.equal(held.report.rows[0].status, "held");
  assert.equal((await inner.get(createdId, { type: "json" })).name, "Not Keep");
});

test("managers cannot import and the runner refuses a write without env credentials", async () => {
  const site = await read(await sitesFn(req("POST", "/api/sites", { cookie, body: { name: "Import Manager Site" } })));
  await staffFn(req("POST", "/api/staff", { cookie, body: { name: "Ida", email: "ida-import@example.com", password: "manager-pass-1", siteIds: [site.body.id] } }));
  const managerLogin = await auth(req("POST", "/api/auth", { body: { email: "ida-import@example.com", password: "manager-pass-1" } }));
  const manager = cookieNamed(managerLogin, "qr_staff");
  const denied = await read(await sitesFn(req("POST", "/api/sites/import", { cookie: manager, body: { dryRun: false, rows: [{ loc: "LOCX", name: "Nope", operationalRegion: "North" }] } })));
  assert.equal(denied.status, 403);
  const file = "/tmp/pos-import-rows.json";
  fs.writeFileSync(file, JSON.stringify([{ loc: "LOCZ", name: "Dry", address: "1 Dry Street", operationalRegion: "North", geographicState: "", hold: true, holdReason: "review" }]));
  const dry = spawnSync(process.execPath, ["scripts/import-sites.mjs", "--file", file], { cwd: "/workspace", encoding: "utf8" });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /"storeRead": false/);
  assert.match(dry.stdout, /"held": 1/);
  const write = spawnSync(process.execPath, ["scripts/import-sites.mjs", "--file", file, "--apply"], { cwd: "/workspace", encoding: "utf8", env: { ...process.env, NETLIFY_AUTH_TOKEN: "", NETLIFY_SITE_ID: "" } });
  assert.equal(write.status, 2);
  assert.match(write.stderr, /does not read auth files/);
});
