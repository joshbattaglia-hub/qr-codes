import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

/** Themes (Light / Dark / Crazy): storage, early apply, options, print, reduced motion and contrast. Synthetic data only. */
const require = createRequire(import.meta.url);
const THEME_SRC = fs.readFileSync("public/admin/theme.js", "utf8");
const CSS = fs.readFileSync("public/admin/styles.css", "utf8");
const HTML = fs.readFileSync("public/admin/index.html", "utf8");
const T = require("../public/admin/theme.js");

/** Run theme.js exactly as the browser does (a plain script) against a fake window with a fake localStorage. */
function boot(initial = {}) {
  const store = new Map(Object.entries(initial));
  const attrs = {};
  const sheets = new Map();
  const head = { appendChild(el) { sheets.set(el.id, el); } };
  const documentElement = { setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k] ?? null; } };
  const doc = {
    head, documentElement,
    getElementById: (id) => sheets.get(id) || null,
    createElement: () => ({ id: "", textContent: "" }),
    querySelector: () => null,
  };
  const win = { document: doc, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  win.window = win; win.globalThis = win;
  vm.runInNewContext(THEME_SRC, win);
  return { win, store, attrs, sheets };
}

test("theme options: Light, Dark and Crazy are offered, Light is the default, and the toggle sits next to the profile image", () => {
  assert.deepEqual(T.THEMES, ["light", "dark", "crazy"]);
  assert.deepEqual(T.LABELS, { light: "Light", dark: "Dark", crazy: "Crazy" });
  for (const t of T.THEMES) assert.match(HTML, new RegExp('data-theme-choice="' + t + '"'));
  assert.match(HTML, /id="theme-btn"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="pop-theme"[^>]*aria-label="Theme: Light"/);
  assert.match(HTML, /id="pop-theme"[^>]*role="menu"/);
  assert.equal((HTML.match(/role="menuitemradio"/g) || []).length, 3);
  assert.match(HTML, /<button class="icon-btn theme-btn"[^>]*>[\s\S]*?<\/button>\s*<button class="avatar"/, "the toggle is immediately before the profile image");
  assert.equal(boot().attrs["data-theme"], "light", "nothing saved: Light");
});

test("the system dark-mode setting is ignored on purpose (Light unless the user chose otherwise)", () => {
  assert.equal(/matchMedia|prefers-color-scheme/.test(THEME_SRC), false);
  assert.equal(/prefers-color-scheme/.test(CSS), false);
});

test("early apply: theme.js is a blocking script in <head> before the stylesheet, and sets the saved theme before first paint", () => {
  const head = HTML.slice(HTML.indexOf("<head>"), HTML.indexOf("</head>"));
  const script = head.indexOf('<script src="/admin/theme.js"></script>');
  assert.ok(script > 0, "theme.js is in <head> with no defer/async/module");
  assert.ok(script < head.indexOf('rel="stylesheet"'), "applied before the stylesheet paints");
  assert.ok(HTML.indexOf("/admin/theme.js") < HTML.indexOf("/admin/app.js"));
  // last signed-in account's choice is applied at load, before any app code runs
  const a = boot({ "eh-theme:last": "pat@libertyretail.com.au", "eh-theme:u:pat@libertyretail.com.au": "dark", "eh-theme:device": "crazy" });
  assert.equal(a.attrs["data-theme"], "dark");
  const b = boot({ "eh-theme:device": "dark" });
  assert.equal(b.attrs["data-theme"], "dark", "no account known: the device-wide choice");
  const c = boot({ "eh-theme:device": "<script>", "eh-theme:last": "x" });
  assert.equal(c.attrs["data-theme"], "light", "junk in storage falls back to Light");
  const d = boot({ "eh-theme:last": "pat@libertyretail.com.au", "eh-theme:u:pat@libertyretail.com.au": "crazy" });
  assert.equal(d.attrs["data-theme"], "crazy");
  assert.match(d.sheets.get("eh-crazy-vars").textContent, /^@media screen\{html\[data-theme="crazy"\]\{--bg:#/, "Crazy palette is in place at load, screen only");
});

test("persistence is per account, with a device-wide fallback for head office and before sign-in", () => {
  const { win, store } = boot();
  const E = win.EHTheme;
  E.setAccount("Pat@LibertyRetail.com.au");
  assert.equal(E.current(), "light");
  E.choose("dark");
  assert.equal(store.get("eh-theme:u:pat@libertyretail.com.au"), "dark", "keyed by the lower-cased email");
  assert.equal(store.has("eh-theme:device"), false, "a signed-in choice does not become the device choice");
  assert.equal(store.get("eh-theme:last"), "pat@libertyretail.com.au");
  // a different account on the same device does not inherit it, and a lookalike address is a different account
  assert.equal(E.setAccount("pat2@libertyretail.com.au"), "light");
  assert.equal(E.setAccount("pat@libertyretail.com.au.evil.example"), "light");
  assert.equal(E.setAccount("pat@libertyretail.com.au"), "dark");
  E.setAccount("sam@libertyretail.com.au"); E.choose("crazy");
  assert.equal(E.setAccount("pat@libertyretail.com.au"), "dark");
  assert.equal(E.setAccount("sam@libertyretail.com.au"), "crazy");
  // head office (no email): the device-wide key
  E.setAccount(null);
  assert.equal(E.current(), "light");
  E.choose("dark");
  assert.equal(store.get("eh-theme:device"), "dark");
  assert.equal(store.has("eh-theme:last"), false);
  assert.equal(E.setAccount(""), "dark");
  assert.equal(E.setAccount("pat@libertyretail.com.au"), "dark");
  // unknown values are refused
  assert.equal(E.choose("neon"), null);
  assert.equal(E.choose("__proto__"), null);
  // sign-in page and signed-out state are Light and are not saved
  assert.equal(E.signedOut(), "light");
  assert.equal(store.get("eh-theme:device"), "dark");
});

test("Crazy: every selection rolls a new random palette, and the palette only exists on screen", () => {
  const { win, sheets } = boot();
  const E = win.EHTheme;
  E.setAccount("pat@libertyretail.com.au");
  const seen = new Set();
  for (let i = 0; i < 6; i++) { E.choose("crazy"); seen.add(sheets.get("eh-crazy-vars").textContent); }
  assert.ok(seen.size >= 5, "a new random hue set each time");
  for (const css of seen) assert.match(css, /^@media screen\{html\[data-theme="crazy"\]\{[^}]+\}\}$/);
  E.choose("dark");
  assert.equal(sheets.get("eh-crazy-vars").textContent, "", "palette removed when leaving Crazy");
});

/** Parse "--name:value" pairs out of a CSS block. */
function varsOf(block) { const out = {}; for (const m of block.matchAll(/--([a-z0-9-]+):([^;}]+)/g)) out[m[1]] = m[2].trim(); return out; }
function blockAfter(css, selector) { const at = css.indexOf(selector + "{"); assert.ok(at >= 0, selector); let depth = 0, i = css.indexOf("{", at); const start = i; for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) break; } return css.slice(start + 1, i); }
const ratio = (a, b) => T.contrast(a, b);

test("Dark: key text/background pairs from the stylesheet all reach WCAG AA (4.5:1), and the focus ring is visible", () => {
  const dark = varsOf(blockAfter(CSS, 'html[data-theme="dark"]'));
  const surfaces = ["bg", "card", "pop-bg", "input-bg", "code-bg", "th-bg", "row-alt", "form-bg", "wh-mini-bg", "soft", "info-bg", "warn-bg"];
  const pairs = [];
  for (const s of surfaces) pairs.push(["ink", s]);
  for (const s of ["bg", "card", "pop-bg", "input-bg", "code-bg", "th-bg", "row-alt", "form-bg"]) pairs.push(["muted", s], ["link", s], ["nav-ink", s], ["label", s], ["ph", s], ["tab-ink", s], ["state-in", s], ["state-out", s], ["green", s], ["red", s], ["footer-ink", s], ["chart-text", s], ["seg-muted", s]);
  pairs.push(["nav-active-ink", "soft"], ["soft-ink", "soft"], ["link-strong", "asset-active-bg"], ["chip-ink", "chip-bg"], ["badge-ink", "badge-bg"], ["ok-ink", "ok-bg"], ["mute-ink", "mute-bg"],
    ["sp-ok-ink", "sp-ok-bg"], ["sp-wait-ink", "sp-wait-bg"], ["sp-bad-ink", "sp-bad-bg"], ["sp-none-ink", "sp-none-bg"], ["info-ink", "info-bg"], ["toast-ink", "toast-bg"], ["seg-ink", "seg-bg"], ["ink", "seg-on-bg"], ["spark", "card"], ["tab-on", "bg"], ["link", "soft"]);
  const bad = [];
  for (const [fg, bg] of pairs) { const r = ratio(dark[fg], dark[bg]); if (!(r >= 4.5)) bad.push(fg + " on " + bg + " = " + r.toFixed(2)); }
  for (const bg of ["blue", "blue-dark", "navy", "danger-bg", "dot-on"]) { const r = ratio("#ffffff", dark[bg]); if (!(r >= 4.5)) bad.push("white on " + bg + " = " + r.toFixed(2)); }
  assert.deepEqual(bad, []);
  for (const s of ["bg", "card", "input-bg"]) assert.ok(ratio(dark["focus-ring"], dark[s]) >= 3, "focus ring vs " + s + " (non-text 3:1)");
  assert.ok(ratio(dark["input-line"], dark["input-bg"]) >= 3, "input border visible");
  assert.match(CSS, /html\[data-theme="dark"\] input:disabled/, "disabled inputs are styled for dark");
  assert.match(CSS, /html\[data-theme="crazy"\] :focus-visible,html\[data-theme="dark"\] :focus-visible\{outline:3px solid var\(--focus-ring\)/);
});

test("Crazy: body text, buttons, links and inputs stay readable (>= 4.5:1) across 2000 random palettes", () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let worst = Infinity, worstName = "";
  const note = (name, r) => { if (r < worst) { worst = r; worstName = name; } };
  for (let i = 0; i < 2000; i++) {
    const { vars: v } = T.makePalette(rand);
    for (const s of ["--bg", "--card", "--soft"]) { note("ink on " + s, ratio(v["--ink"], v[s])); note("muted on " + s, ratio(v["--muted"], v[s])); note("link on " + s, ratio(v["--link"], v[s])); }
    for (const s of ["--bg", "--card"]) { note("red on " + s, ratio(v["--red"], v[s])); note("green on " + s, ratio(v["--green"], v[s])); }
    note("nav-active on soft", ratio(v["--nav-active-ink"], v["--soft"]));
    note("soft-ink on soft", ratio(v["--soft-ink"], v["--soft"]));
    for (const b of ["--blue", "--blue-dark", "--navy", "--danger-bg"]) note("white on " + b, ratio("#ffffff", v[b]));
    note("ink on white inputs", ratio(v["--ink"], "#ffffff"));
    note("input border (blue) on white", ratio(v["--blue"], "#ffffff") >= 3 ? 99 : 0);
  }
  assert.ok(worst >= 4.5, "worst pair " + worstName + " = " + worst.toFixed(2));
  // Crazy overrides only what it must; the footer sits on a solid chip so it never lands on the moving gradient
  assert.match(CSS, /html\[data-theme="crazy"\] \.eh-footer\{background:var\(--card\)/);
  assert.match(CSS, /html\[data-theme="crazy"\] \.view\{background:var\(--bg\)/, "page content sits on a solid surface");
});

test("print is always light: theme rules are screen-only, the Crazy palette is screen-only, and print forces plain colours", () => {
  const themes = CSS.indexOf("/* ===== Themes");
  assert.ok(themes > 0);
  const screenAt = CSS.indexOf("@media screen{", themes);
  const darkAt = CSS.indexOf('html[data-theme="dark"]{', themes);
  const crazyAt = CSS.indexOf('html[data-theme="crazy"]{', themes);
  assert.ok(screenAt > 0 && darkAt > screenAt && crazyAt > darkAt, "dark and crazy variables live inside @media screen");
  const screenBlock = blockAfter(CSS.slice(themes), "@media screen");
  assert.match(screenBlock, /html\[data-theme="dark"\]\{/);
  assert.match(screenBlock, /html\[data-theme="crazy"\] body\{background:linear-gradient/, "the psychedelic background is screen-only");
  const print = CSS.slice(CSS.lastIndexOf("@media print{"));
  assert.match(print, /html\[data-theme\],html\[data-theme\] body\{background:#fff !important;color:#000 !important;color-scheme:light;animation:none !important\}/);
  assert.match(print, /\.theme-pop,#pop-theme\{display:none !important\}/);
  // :root (the light values) is the only unconditional set of variables
  assert.equal(/html\[data-theme="(dark|crazy)"\]\{/.test(CSS.slice(0, themes)), false);
  assert.match(T.css({ "--bg": "#ffffff" }), /^@media screen\{/);
  // the sticker sheet document is its own light page and does not know about themes
  const wh = fs.readFileSync("public/admin/warehouse-ui.mjs", "utf8");
  assert.match(wh, /html,body\{margin:0;padding:0;background:#fff\}/);
  assert.equal(/data-theme|EHTheme|var\(--/.test(wh.slice(wh.indexOf("export function sheetHtml"), wh.indexOf("function printFrame"))), false);
});

test("reduced motion: the animated gradient only runs when motion is allowed, and the static palette stays when it is not", () => {
  const anim = [...CSS.matchAll(/animation:eh-crazy-bg/g)];
  assert.equal(anim.length, 1, "one place starts the animation");
  const at = CSS.indexOf("animation:eh-crazy-bg");
  const opening = CSS.lastIndexOf("@media", at);
  assert.match(CSS.slice(opening, opening + 60), /^@media screen and \(prefers-reduced-motion:no-preference\)/);
  assert.match(CSS, /@media screen and \(prefers-reduced-motion:reduce\)\{[^@]*html\[data-theme="crazy"\] body\{animation:none\}/);
  assert.match(CSS, /--reduced|prefers-reduced-motion:reduce/);
});

test("no hard-coded colours are left in the themed stylesheet except deliberate ones (previews, white barcode surfaces, brand marks)", () => {
  const themes = CSS.indexOf("/* ===== Themes");
  const rootEnd = CSS.indexOf("*{box-sizing");
  const body = CSS.slice(rootEnd, themes);
  const allowed = [".create-btn{", ".avatar{", ".app-ico", ".dot{", ".empty-mark{", ".phone-preview", ".asset-preview", ".wh-mini-label{", ".wh-spin{", ".qr-stage,.asset-preview,.wh-mini-label,.preview-box{"];
  const leftovers = [];
  for (const line of body.split("\n")) {
    if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) continue;
    if (allowed.some((a) => line.includes(a))) continue;
    leftovers.push(line.slice(0, 90));
  }
  assert.deepEqual(leftovers, []);
  // JS-built SVG charts use theme variables too
  const app = fs.readFileSync("public/admin/app.js", "utf8");
  assert.match(app, /stroke="var\(--chart-a\)"/);
  assert.equal(/stroke="#(2563eb|98a2b3|eef0f4|e6e8ee|12b76a)"/.test(app), false);
});

test("footer: shared wording is present on the admin page and readable in every theme", () => {
  const footer = fs.readFileSync("public/footer.js", "utf8");
  assert.match(HTML, /<script src="\/footer\.js" defer><\/script>/);
  assert.match(footer, /Cowabunga - please hesitate to reach out /);
  assert.match(footer, /link\.textContent = "email me here"/);
  assert.match(footer, /mailto:jbattaglia@libertyretail\.com\.au/);
  assert.match(footer, /color:var\(--footer-ink,#667085\)/, "public pages (no theme) keep the light colour");
  const dark = varsOf(blockAfter(CSS, 'html[data-theme="dark"]'));
  assert.ok(ratio(dark["footer-ink"], dark["bg"]) >= 4.5);
  assert.ok(ratio(dark["footer-hover"], dark["bg"]) >= 4.5);
  assert.ok(ratio("#667085", "#f3f4f8") >= 4.5, "light footer on the light page");
  let seed = 7; const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 500; i++) { const v = T.makePalette(rand).vars; assert.ok(ratio(v["--ink"], v["--card"]) >= 4.5); assert.ok(ratio(v["--link"], v["--card"]) >= 4.5); }
});
