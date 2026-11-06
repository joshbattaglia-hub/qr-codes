import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODE39_DEFAULTS, code39Bits, code39Svg, parseBatch, printHtml, readLayout, safeAssetName, symbolWidthMm, validatePayload, zipStore,
} from "../public/admin/code39.mjs";

const PAYLOADS = ["LOC50924", "A", "0", "TEST-1", "ABC 123", "Z.$/+%", "LOC50924X"];
const layout = {
  moduleMm: 0.33,
  ratio: 3,
  barHeightMm: 12,
  quietModules: 10,
  labelWidthMm: 90,
  labelHeightMm: 40,
};

function python(args) {
  return execFileSync("python3", [path.join("scripts", "code39_reference.py"), ...args], { encoding: "utf8" });
}

test("Code 39 patterns match python-barcode with no checksum", () => {
  const rows = python(["bits", ...PAYLOADS]).trim().split("\n");
  assert.equal(rows.length, PAYLOADS.length);
  for (const row of rows) {
    const tab = row.indexOf("\t");
    const payload = row.slice(0, tab);
    const bits = row.slice(tab + 1);
    assert.equal(code39Bits(payload), bits, payload);
    assert.notEqual(code39Bits(payload), python(["checksum", payload]).trim(), payload);
  }
});

test("known payloads decode from the SVG artwork", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code39-"));
  for (const payload of PAYLOADS) {
    const drawn = code39Svg(payload, layout, "Liberty Oil Convenience");
    const file = path.join(dir, safeAssetName(payload) + ".svg");
    fs.writeFileSync(file, drawn.svg);
    const decoded = JSON.parse(python(["decode", file]));
    assert.equal(decoded.format, "Code 39");
    assert.equal(decoded.text, payload);
    assert.equal(drawn.svg.includes("]A0"), false);
    assert.match(drawn.svg, new RegExp("<text[^>]*>" + payload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "</text>"));
  }
});

test("bars stay black on a white field and quiet zones stay at least 10 modules", () => {
  const drawn = code39Svg("LOC50924", layout, "Liberty Oil Convenience");
  assert.match(drawn.svg, /<rect width="100%" height="100%" fill="#fff"/);
  assert.equal(drawn.svg.includes("fill=\"#1f4bdb\""), false);
  assert.equal(drawn.svg.includes("fill=\"#000\""), true);
  const bars = [...drawn.svg.matchAll(/<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)" fill="#000"/g)].map((match) => match.slice(1).map(Number));
  const quiet = layout.quietModules * layout.moduleMm;
  assert.ok(bars[0][0] >= quiet - 0.001);
  const end = Math.max(...bars.map((bar) => bar[0] + bar[2]));
  assert.ok(drawn.widthMm - end >= quiet - 0.001);
  const short = code39Svg("A", { ...layout, labelWidthMm: 80 }, "Heading");
  const shortBars = [...short.svg.matchAll(/<rect x="([0-9.]+)" /g)].map((match) => Number(match[1]));
  assert.ok(shortBars[0] > quiet + 5, "short symbol should sit in the label without stretching the bars");
  assert.equal(drawn.svg.includes('width="' + layout.labelWidthMm.toFixed(2) + 'mm"') || drawn.widthMm >= layout.labelWidthMm, true);
  assert.match(drawn.svg, /width="[0-9.]+mm" height="[0-9.]+mm"/);
});

test("wide bars use the selected ratio and are not shrunk to fit a small label", () => {
  const tight = { ...layout, labelWidthMm: 20, labelHeightMm: 15, moduleMm: 0.5, ratio: 2.5, barHeightMm: 10 };
  const drawn = code39Svg("LOC50924", tight, "Liberty Oil Convenience");
  assert.ok(drawn.notes.some((note) => /not shrunk/.test(note)));
  assert.ok(drawn.symbolWidthMm > tight.labelWidthMm);
  const widths = [...drawn.svg.matchAll(/width="([0-9.]+)"/g)].map((match) => Number(match[1]));
  assert.ok(widths.includes(Number((tight.moduleMm).toFixed(3))));
  assert.ok(widths.includes(Number((tight.moduleMm * tight.ratio).toFixed(3))));
  assert.ok(Math.abs(symbolWidthMm("A", layout) - code39Svg("A", layout, "").symbolWidthMm) < 0.01);
});

test("layout limits and quiet-zone minimum are enforced", () => {
  assert.deepEqual(readLayout({ ...CODE39_DEFAULTS }).errors, []);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, quietModules: 9 }).errors.length);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, quietModules: 10.5 }).errors.length);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, moduleMm: 0.1 }).errors.length);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, ratio: 1.5 }).errors.length);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, ratio: 3.2 }).errors.length);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, barHeightMm: 2 }).errors.length);
  assert.ok(readLayout({ ...CODE39_DEFAULTS, labelWidthMm: 10 }).errors.length);
});

test("charset, spaces, case, and batch lines", () => {
  assert.equal(validatePayload("LOC50924").payload, "LOC50924");
  assert.equal(validatePayload("ABC 123").payload, "ABC 123");
  assert.equal(validatePayload(" A").payload, " A");
  assert.notEqual(code39Bits(" A"), code39Bits("A"));
  assert.equal(validatePayload("loc50924").error.includes("Lower-case"), true);
  assert.equal(validatePayload("loc50924", { uppercase: true }).payload, "LOC50924");
  assert.equal(validatePayload("loc50924", { uppercase: true }).converted, true);
  assert.equal(validatePayload("LOC*1").error.includes("reserved"), true);
  assert.equal(validatePayload("café").error.includes("A–Z"), true);
  assert.equal(validatePayload("LOC50924é").error.includes("A–Z"), true);
  const batch = parseBatch("\nLOC50924\n\nABC 123\n", {});
  assert.deepEqual(batch.items.map((item) => item.payload), ["LOC50924", "ABC 123"]);
  assert.equal(parseBatch("ok\n", {}).errors[0].error.includes("Lower-case"), true);
  assert.equal(parseBatch("ok\n", { uppercase: true }).items[0].payload, "OK");
  const tooMany = parseBatch(Array.from({ length: 41 }, () => "A").join("\n"), {});
  assert.equal(tooMany.items.length, 0);
  assert.ok(tooMany.errors.some((item) => /40/.test(item.error)));
});

test("names, markup, and zip entries stay safe", () => {
  assert.equal(safeAssetName("Z.$/+%"), "asset-Z_2e_24_2f_2b_25");
  assert.equal(safeAssetName("../SECRET").includes("/"), false);
  assert.equal(safeAssetName("../SECRET").startsWith("."), false);
  assert.match(safeAssetName("a/b"), /^asset-[A-Za-z0-9_-]+$/);
  const drawn = code39Svg("A", layout, 'Say "hi" <tag> & more');
  assert.equal(drawn.svg.includes("<tag>"), false);
  assert.match(drawn.svg, /Say &quot;hi&quot; &lt;tag&gt; &amp; more/);
  const printed = printHtml([code39Svg("A", layout, "</h1><script>")]);
  assert.equal(printed.includes("<script>"), false);
  assert.match(printed, /&lt;\/h1&gt;&lt;script&gt;/);
  const zip = zipStore([
    { name: safeAssetName("Z.$/+%") + ".svg", data: "<svg>1</svg>" },
    { name: safeAssetName("../SECRET") + ".svg", data: "<svg>2</svg>" },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code39-zip-"));
  const file = path.join(dir, "labels.zip");
  fs.writeFileSync(file, zip);
  const listing = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]);\nprint('\\n'.join(i.filename + ' ' + z.read(i).decode() for i in z.infolist()))", file], { encoding: "utf8" });
  const names = listing.trim().split("\n").map((line) => line.split(" ")[0]);
  assert.deepEqual(names, ["asset-Z_2e_24_2f_2b_25.svg", safeAssetName("../SECRET") + ".svg"]);
  assert.equal(names.some((name) => name.includes("/") || name.includes("..")), false);
  assert.throws(() => zipStore([{ name: "../x.svg", data: "no" }]), /Unsafe/);
});
