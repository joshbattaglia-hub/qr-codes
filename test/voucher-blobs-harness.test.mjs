import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runMock, STORE_PREFIX, CONTENDERS } from "../scripts/voucher-verification/verify-voucher-blobs.mjs";
import { shouldRun } from "../netlify/functions/voucher-blobs-evidence.mjs";

test("mock harness runs production redeemVoucher with conditional storage", async () => {
  const report = await runMock();
  assert.equal(report.mode, "mock");
  assert.equal(report.productionFunction, "redeemVoucher");
  assert.equal(report.ok, true);
  assert.equal(report.contenders, CONTENDERS);
  assert.ok(report.contenders >= 20);
  assert.equal(report.successes, 1);
  assert.equal(report.conflicts, CONTENDERS - 1);
  assert.equal(report.other, 0);
  assert.equal(report.rereadStatus, "redeemed");
  assert.equal(report.etagChanged, true);
  assert.equal(report.replayConflict, true);
  assert.equal(report.replayChangedRecord, false);
  assert.equal(report.staleEtagModified, false);
  assert.equal(report.recordAfterStale, "redeemed");
  assert.equal(report.offersEnabled, false);
  assert.equal(report.cleaned, true);
  assert.equal(report.failClosed.missingEtag, true);
  assert.equal(report.failClosed.missingEtagWrites, 0);
  assert.equal(report.failClosed.missingStorage, true);
  assert.ok(report.store.startsWith(STORE_PREFIX));
  assert.equal(JSON.stringify(report).includes("token"), false);
});

test("evidence function is an event subscription rather than an HTTP route", () => {
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /functions\s*=\s*"netlify\/functions"/);
  assert.equal(toml.includes("scripts/voucher-verification"), false);
  const eventSource = fs.readFileSync(new URL("../netlify/functions/voucher-blobs-evidence.mjs", import.meta.url), "utf8");
  assert.equal(eventSource.includes("export const config"), false);
  assert.equal(eventSource.includes("export default async"), false);
});

test("live evidence does not run for production or other branches", () => {
  assert.equal(shouldRun(null), false);
  assert.equal(shouldRun({ context: "production", branch: "cursor/voucher-blobs-evidence-79b7" }), false);
  assert.equal(shouldRun({ context: "branch-deploy", branch: "master" }), false);
  assert.equal(shouldRun({ context: "deploy-preview", branch: "cursor/voucher-blobs-evidence-79b7" }), true);
  assert.equal(shouldRun({ context: "branch-deploy", branch: "cursor/voucher-blobs-evidence-79b7" }), true);
});
