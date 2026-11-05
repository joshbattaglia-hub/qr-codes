import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { apiStoreName, newStoreName, runMock, STORE_PREFIX, STORE_SUFFIX_HEX, CONTENDERS } from "../scripts/voucher-verification/verify-voucher-blobs.mjs";
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

test("generated store name stays under the live API limit, including the site: prefix", () => {
  const names = new Set();
  for (let i = 0; i < 20; i++) names.add(newStoreName());
  assert.equal(names.size, 20);
  for (const name of names) {
    const wire = apiStoreName(name);
    assert.equal(wire, "site:" + name);
    assert.ok(wire.length < 64, wire + " is " + wire.length);
    assert.equal(name.startsWith(STORE_PREFIX), true);
    assert.match(name.slice(STORE_PREFIX.length), new RegExp("^[0-9a-f]{" + STORE_SUFFIX_HEX + "}$"));
    const token = "ab".repeat(32);
    const key = "token/" + token;
    assert.equal(key.startsWith("/"), false);
    assert.ok(key.length <= 600);
  }
});

test("evidence function is an event subscription rather than an HTTP route", () => {
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /functions\s*=\s*"netlify\/functions"/);
  assert.equal(toml.includes("scripts/voucher-verification"), false);
  const eventSource = fs.readFileSync(new URL("../netlify/functions/voucher-blobs-evidence.mjs", import.meta.url), "utf8");
  assert.equal(eventSource.includes("export const config"), false);
  assert.equal(eventSource.includes("export default async"), false);
});

test("unpublished CLI drafts with the packed title marker run, and production does not", () => {
  const branch = "cursor/voucher-blobs-evidence-79b7";
  const observed = {
    context: "deploy-preview",
    branch: null,
    publishedAt: null,
    title: "Draft cursor/voucher-blobs-evidence-79b7",
    manual: true,
  };
  assert.equal(shouldRun(null), false);
  assert.equal(shouldRun(observed), true);
  assert.equal(shouldRun({ context: "production", branch, publishedAt: null, manual: true, title: branch }), false);
  assert.equal(shouldRun({ context: "deploy-preview", branch: null, publishedAt: "2026-11-05T00:00:00.000Z", title: branch }), false);
  assert.equal(shouldRun({ context: "deploy-preview", branch: null, publishedAt: null, title: "ordinary draft" }), false);
  assert.equal(shouldRun({ context: "branch-deploy", branch: "master", publishedAt: null }), false);
  assert.equal(shouldRun({ context: "deploy-preview", branch, publishedAt: null }), true);
});
