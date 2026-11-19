import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Static checks for the motion / depth / touch system (public/admin/motion.css) and the helpers in ux.mjs. No browser needed. */
const css = fs.readFileSync("public/admin/motion.css", "utf8");
const base = fs.readFileSync("public/admin/styles.css", "utf8");
const html = fs.readFileSync("public/admin/index.html", "utf8");
const ms = (text) => [...text.matchAll(/(?<![\w-])(\d*\.?\d+)(ms|s)\b/g)].map((m) => m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]));

test("motion tokens: durations 150-250ms, ease-out curves, press and wind-up are short", () => {
  const tok = (name) => css.match(new RegExp("--" + name + ":([^;]+);"))?.[1];
  for (const name of ["dur-instant", "dur-press", "dur-fast", "dur-base", "dur-slow", "dur-wind", "ease-out", "ease-settle"]) assert.ok(tok(name), "--" + name + " is defined");
  assert.equal(tok("dur-fast"), "150ms");
  assert.equal(tok("dur-base"), "200ms");
  assert.equal(tok("dur-slow"), "250ms");
  assert.ok(Number.parseInt(tok("dur-wind")) >= 80 && Number.parseInt(tok("dur-wind")) <= 120, "wind-up is about 80-120ms");
  assert.ok(Number.parseInt(tok("dur-press")) <= 120);
  assert.match(tok("ease-out"), /^cubic-bezier\(/);
  assert.match(tok("ease-settle"), /^cubic-bezier\(/);
});

test("no linear easing for UI motion (only the skeleton shimmer is linear), and every transition is at most 250ms", () => {
  const withoutShimmer = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.skeleton\{[^}]*\}/g, "").replace(/linear-gradient/g, "gradient");
  assert.ok(!/(?<![\w-])linear(?![\w-])/.test(withoutShimmer), "linear only in the skeleton shimmer");
  assert.ok(!/ease-in\b|\bease\b(?!-)/.test(css.replace(/ease-out|ease-settle/g, "")), "no plain ease / ease-in");
  const base2 = base.replace(/transition:[^;}]*;?/g, (m) => { assert.ok(!/linear/.test(m)); return m; });
  assert.ok(base2.length > 1000);
  for (const m of css.matchAll(/transition:([^;}]+)/g)) for (const d of ms(m[1].replace(/var\(--dur-[a-z]+\)/g, ""))) assert.ok(d <= 250, "transition too slow: " + m[1]);
});

test("shared tokens: elevation scale in all three themes and a z-index scale used instead of raw numbers", () => {
  for (const n of [1, 2, 3]) assert.match(css, new RegExp("--elev-" + n + ":"));
  assert.match(css, /html\[data-theme="dark"\]\{[^}]*--elev-3:/);
  assert.match(css, /html\[data-theme="crazy"\]\{[^}]*--elev-3:/);
  for (const z of ["base", "dropdown", "sticky", "pop", "scrim", "drawer", "modal", "toast"]) assert.match(css, new RegExp("--z-" + z + ":\\d+"));
  assert.deepEqual(base.match(/z-index:\s*\d+/g) || [], [], "styles.css uses the z-index tokens, not raw numbers");
  const order = ["sticky", "pop", "scrim", "drawer", "modal", "toast"].map((z) => Number(css.match(new RegExp("--z-" + z + ":(\\d+)"))[1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "layers are ordered");
  assert.match(css, /\.card[^{]*\{[^}]*box-shadow:var\(--elev-1\)/);
  assert.match(css, /#modal\{z-index:var\(--z-modal\)\}/);
});

test("prefers-reduced-motion: no animations or transitions, no transforms, tokens go to zero, ticks and focus rings stay", () => {
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion:reduce)"));
  assert.match(block, /animation:none !important/);
  assert.match(block, /transition:none !important/);
  assert.match(block, /--dur-fast:0ms/);
  assert.match(block, /transform:none !important/);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--focus-ring\)/);
  assert.match(css, /\.toast\[data-kind="copied"\]::before\{[^}]*\}/);
  assert.match(css, /\.saved-tick::before\{content:"\\2713"/);
  // styles.css own motion is already behind no-preference / disabled under reduce
  assert.match(base, /prefers-reduced-motion:no-preference\)\{\s*html\[data-theme="crazy"\] body\{animation/);
});

test("frequent actions are instant: tabs, segmented switches, menu items, theme menu and inputs have no transition or entrance", () => {
  assert.match(css, /\.tabs button,\.seg button[^{]*\{transition:none\}/);
  assert.match(css, /\.theme-pop,\.search-results\{animation:none\}/);
  const press = css.match(/\.btn,\.create-btn,\.icon-btn[^{]*\{transition:([^}]*)\}/)[1];
  assert.ok(!/background|color/.test(press), "press feedback never animates colour (theme switches stay instant)");
});

test("the admin page loads the motion system, announces toasts, and the modal is a real dialog", () => {
  assert.match(html, /<link rel="stylesheet" href="\/admin\/styles\.css">\s*<link rel="stylesheet" href="\/admin\/motion\.css">/);
  assert.match(html, /<div id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
  const app = fs.readFileSync("public/admin/app.js", "utf8");
  assert.match(app, /role="dialog" aria-modal="true"/);
  assert.match(app, /modalReturnFocus/);
  assert.match(app, /el\.inert = true/);
});

test("anticipation helper: waits about 100ms then runs, and runs at once under reduced motion", async () => {
  const el = { classes: new Set(), classList: { add(c) { el.classes.add(c); }, remove(c) { el.classes.delete(c); } } };
  let reduce = false;
  globalThis.window = { matchMedia: () => ({ matches: reduce }) };
  const ux = await import("../public/admin/ux.mjs");
  let t0 = Date.now();
  const seen = [];
  const out = await ux.anticipate(el, () => { seen.push([...el.classes]); return "ran"; });
  const waited = Date.now() - t0;
  assert.equal(out, "ran");
  assert.ok(waited >= 90 && waited < 250, "wound up for about 100ms (" + waited + ")");
  assert.deepEqual(seen, [[]], "the wind-up class is removed before the action runs");
  reduce = true;
  t0 = Date.now();
  await ux.anticipate(el, () => null);
  assert.ok(Date.now() - t0 < 40, "instant under reduced motion");
  assert.equal(ux.reducedMotion(), true);
  delete globalThis.window;
});

test("optimistic helper: applies first, rolls back and reports when the request fails", async () => {
  const ux = await import("../public/admin/ux.mjs");
  const log = [];
  const ok = await ux.optimistic({ apply: () => log.push("apply"), request: async () => { log.push("request"); return 7; }, rollback: () => log.push("rollback"), onError: () => log.push("error") });
  assert.equal(ok, 7);
  assert.deepEqual(log, ["apply", "request"]);
  log.length = 0;
  const bad = await ux.optimistic({ apply: () => log.push("apply"), request: async () => { throw new Error("no"); }, rollback: () => log.push("rollback"), onError: (e) => log.push("error:" + e.message) });
  assert.equal(bad, undefined);
  assert.deepEqual(log, ["apply", "rollback", "error:no"]);
});
