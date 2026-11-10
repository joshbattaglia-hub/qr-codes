import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/showcase/index.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../public/showcase/showcase.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/showcase/showcase.css", import.meta.url), "utf8");
const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");

test("the showcase is a static noindex tour with example data only", () => {
  assert.match(toml, /from = "\/showcase"/);
  assert.match(toml, /from = "\/showcase\/\*"/);
  assert.match(toml, /to = "\/showcase\/index.html"/);
  assert.match(toml, /for = "\/showcase"/);
  assert.match(toml, /for = "\/showcase\/\*"/);
  assert.match(toml, /X-Robots-Tag = "noindex, nofollow"/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal(/<form[\s>]/i.test(html + js), false);
  assert.equal(js.includes("fetch("), false);
  assert.equal(js.includes("XMLHttpRequest"), false);
  assert.equal(js.includes("/api"), false);
  assert.equal(js.includes(".netlify/functions"), false);
  assert.equal(html.includes("/api"), false);
  assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(html + js + css), false);
  assert.equal((html + js).toLowerCase().includes("mailto:"), false);
  assert.equal(/\b(?:\+61|0[2-478]\d{8})\b/.test(html + js), false);
  for (const href of ["/showcase/qr", "/showcase/analytics", "/showcase/pages", "/showcase/competitions", "/showcase/pos", "/showcase/assets", "/showcase/visitors", "/showcase/sites", "/showcase/domains"]) {
    assert.equal(js.includes(href), true);
  }
  assert.equal(js.includes('class="kicker">Example data'), true);
  assert.equal(js.includes("disabled"), true);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /button\[disabled\]/);
});
