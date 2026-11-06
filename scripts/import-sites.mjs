import fs from "node:fs";
import { getStore } from "@netlify/blobs";
import { applyImport, auditView, classifyImport, readSites } from "../netlify/lib/site-import.mjs";

const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const file = fileFlag >= 0 ? args[fileFlag + 1] : "";
const apply = args.includes("--apply");
if (!file) {
  console.error("Usage: node scripts/import-sites.mjs --file rows.json [--apply]");
  console.error("Dry-run is the default. --apply writes only when NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are already in the environment.");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(file, "utf8"));
const input = Array.isArray(rows) ? rows : rows.rows;
const siteID = process.env.NETLIFY_SITE_ID || "";
const token = process.env.NETLIFY_AUTH_TOKEN || "";
if (!siteID || !token) {
  if (apply) {
    console.error("Refusing to write. Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN in the environment. This script does not read auth files.");
    process.exit(2);
  }
  const report = classifyImport([], input || []);
  console.log(JSON.stringify({ dryRun: true, storeRead: false, ...auditView(report), rows: report.rows }, null, 2));
  process.exit(0);
}
const store = getStore({ name: "sites", siteID, token, consistency: "strong" });
const report = apply ? await applyImport(store, input || []) : classifyImport(await readSites(store), input || []);
if (report.error) {
  console.error(report.error);
  process.exit(1);
}
const after = await readSites(store);
console.log(JSON.stringify({
  dryRun: !apply,
  storeRead: true,
  ...auditView(report),
  rows: report.rows,
  readback: { sites: after.length, locsPresent: report.readback.locsPresent },
}, null, 2));
