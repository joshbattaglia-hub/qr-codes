import fs from "node:fs";
import { getStore } from "@netlify/blobs";
import { auditView, classifyImport, planImport, readSites, rowsFromDocument } from "../netlify/lib/site-import.mjs";

const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const file = fileFlag >= 0 ? args[fileFlag + 1] : "";
const apply = args.includes("--apply");
if (!file) {
  console.error("Usage: node scripts/import-sites.mjs --file rows.json [--apply]");
  console.error("Dry-run is the default. --apply writes only when NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are already in the environment.");
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const input = rowsFromDocument(doc);
if (!input) {
  console.error("Import JSON must be a rows array or a sites document. Fields are read as supplied.");
  process.exit(1);
}
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
if (args.includes("--readback")) {
  const sites = await readSites(store);
  console.log(JSON.stringify({ readback: true, wrote: false, sites: sites.length, locs: sites.filter((site) => site.loc).length }, null, 2));
  process.exit(0);
}
const planned = await planImport(store, input || [], { apply });
const report = planned.report;
if (report.error) {
  console.error(report.error);
  process.exit(1);
}
console.log(JSON.stringify({
  dryRun: planned.dryRun,
  storeRead: true,
  wrote: planned.wrote,
  sitesBefore: planned.sitesBefore,
  ...auditView(report),
  rows: report.rows,
  readback: planned.dryRun ? report.readback : { sites: planned.sitesAfter, locsPresent: report.readback.locsPresent },
}, null, 2));
