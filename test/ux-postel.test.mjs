import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseEmail, normaliseEmailList, normalisePhone, formatPhone, normaliseDate, normaliseBarcode, normaliseBarcodeLines, optimistic } from "../public/admin/ux.mjs";

/** Postel's law: forgiving about what people type or paste. The server still validates strictly; these only tidy the input. */
test("email: angle brackets, mailto:, case, spaces and stray punctuation are forgiven", () => {
  assert.equal(normaliseEmail("  <Sam.Smith@Example.com> "), "sam.smith@example.com");
  assert.equal(normaliseEmail("Sam Smith <Sam.Smith@Example.com>"), "sam.smith@example.com");
  assert.equal(normaliseEmail("mailto:Bob@X.com"), "bob@x.com");
  assert.equal(normaliseEmail("bob@x.com,"), "bob@x.com");
  assert.equal(normaliseEmail("bob @ x.com"), "bob@x.com");
  assert.equal(normaliseEmail("\u200bbob@x.com\u200b"), "bob@x.com");
  assert.equal(normaliseEmail(null), "");
  assert.equal(normaliseEmail("not an email"), "notanemail", "tidying never invents or validates: the server rejects what is not an email");
  assert.deepEqual(normaliseEmailList("A@x.com; b@x.com,\n<C@x.com>, a@x.com"), ["a@x.com", "b@x.com", "c@x.com"]);
});

test("phone: Australian mobiles, landlines and +61 forms land in one tidy shape", () => {
  for (const raw of ["0412345678", "04-1234 5678", "(04) 1234 5678", "+61 412 345 678", "61412345678", "0061412345678", "tel:0412 345 678"]) assert.equal(formatPhone(raw), "0412 345 678", raw);
  assert.equal(formatPhone("(03) 9123-4567"), "03 9123 4567");
  assert.equal(formatPhone("+61 3 9123 4567"), "03 9123 4567");
  assert.equal(formatPhone("1800 123 456"), "1800 123 456");
  assert.equal(formatPhone("+44 20 7946 0958"), "+442079460958", "overseas numbers lose punctuation only");
  assert.equal(formatPhone("abc"), "");
  assert.equal(normalisePhone("+61 (0)412.345.678"), "+610412345678");
});

test("date: day-first Australian formats become ISO, and impossible dates are refused rather than guessed", () => {
  for (const raw of ["2026-11-19", "19/11/2026", "19-11-26", "19.11.2026", "19 Nov 2026", "19th November 2026", "Nov 19, 2026", " 19/11/26 "]) assert.equal(normaliseDate(raw), "2026-11-19", raw);
  assert.equal(normaliseDate("31/02/2026"), "");
  assert.equal(normaliseDate("hello"), "");
  assert.equal(normaliseDate(""), "");
});

test("barcodes: asterisks, line breaks, tabs and stray spaces are dropped; case only changes when asked", () => {
  assert.equal(normaliseBarcode("*abc 123*"), "ABC123");
  assert.equal(normaliseBarcode("  ab\tc\n123 \r\n"), "ABC123");
  assert.equal(normaliseBarcode("*Ab 12*", { upper: false, inner: true }), "Ab 12", "asset IDs keep their case and one interior space");
  assert.equal(normaliseBarcode("A   B", { upper: false, inner: true }), "A B");
  assert.equal(normaliseBarcode("\u200bX1\u00a0"), "X1");
  assert.deepEqual(normaliseBarcodeLines("*a1*\r\n\n b2 \n\n*c3*"), ["A1", "B2", "C3"]);
  assert.deepEqual(normaliseBarcodeLines("a 1\n\nb 2", { upper: false, inner: true }), ["a 1", "b 2"]);
});

test("optimistic: applies at once, and on failure rolls back and reports; on success nothing is undone", async () => {
  const log = [];
  const ok = await optimistic({ apply: () => log.push("apply"), request: async () => "fine", rollback: () => log.push("rollback"), onError: () => log.push("error") });
  assert.equal(ok, "fine"); assert.deepEqual(log, ["apply"]);
  log.length = 0;
  const bad = await optimistic({ apply: () => log.push("apply"), request: async () => { throw new Error("nope"); }, rollback: () => log.push("rollback"), onError: (e) => log.push("error:" + e.message) });
  assert.equal(bad, undefined); assert.deepEqual(log, ["apply", "rollback", "error:nope"]);
});
