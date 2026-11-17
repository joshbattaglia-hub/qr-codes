import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** The Express Help logo: hand-built SVG, favicon set, per-theme sidebar variant, sign-in logo, email header. */
const pub = "public";
const read = (f) => fs.readFileSync(path.join(pub, f), "utf8");
const SVGS = ["logo-mark.svg", "logo-mark-dark.svg", "logo-lockup.svg", "logo-lockup-dark.svg", "logo-mark-mono.svg", "logo-mark-mono-white.svg"].map((f) => "brand/" + f).concat(["favicon.svg"]);

function htmlFiles(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? htmlFiles(path.join(dir, e.name)) : e.name.endsWith(".html") ? [path.join(dir, e.name)] : []); }
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file + " is a PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25], bytes: b };
}

test("logo SVGs exist, are well-formed, have a viewBox, and embed no raster or base64 image", () => {
  for (const f of SVGS) {
    const s = read(f);
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ 256"/, f);
    assert.equal((s.match(/<svg\b/g) || []).length, 1, f + " has one root");
    assert.ok(s.trimEnd().endsWith("</svg>"), f);
    assert.equal(/<image\b|data:image|base64|\.jpe?g|\.png|<script|onload=|href=|<style/i.test(s), false, f + " is pure vector");
    // balanced tags
    const stack = [];
    for (const m of s.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
      if (m[4] === "/") continue;
      if (m[1] === "/") assert.equal(stack.pop(), m[2], f + " tag balance");
      else stack.push(m[2]);
    }
    assert.deepEqual(stack, [], f + " is well-formed");
    assert.match(s, /<title>Express Help<\/title>/);
  }
  assert.match(read("brand/logo-mark.svg"), /#0B2559/);
  assert.match(read("brand/logo-mark.svg"), /#E11D2E/);
  // the wordmark is outlined paths, not a font reference
  for (const f of ["brand/logo-lockup.svg", "brand/logo-lockup-dark.svg"]) assert.equal(/<text\b|font-family|<tspan/.test(read(f)), false, f + " wordmark is outlined");
  assert.match(read("brand/logo-lockup-dark.svg"), /<path d="M[^"]+" fill="#FFFFFF"\/><\/svg>/, "dark lockup wordmark is white");
  assert.match(read("brand/logo-lockup.svg"), /<path d="M[^"]+" fill="#0B2559"\/><\/svg>/, "light lockup wordmark is navy");
  assert.ok(fs.existsSync("public/brand/README.md"));
  assert.match(read("brand/README.md"), /Clear space/i);
});

test("favicon set: svg, 32/16 png, ico, and a 180 x 180 apple-touch-icon", () => {
  const a = pngSize("public/apple-touch-icon.png");
  assert.deepEqual([a.w, a.h], [180, 180]);
  assert.ok(a.colorType === 2 || a.colorType === 6);
  assert.deepEqual([pngSize("public/favicon-32.png").w, pngSize("public/favicon-32.png").h], [32, 32]);
  assert.deepEqual([pngSize("public/favicon-16.png").w, pngSize("public/favicon-16.png").h], [16, 16]);
  const ico = fs.readFileSync("public/favicon.ico");
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 2, "ico holds several sizes");
  const email = pngSize("public/brand/logo-lockup-email.png");
  assert.deepEqual([email.w, email.h], [394, 96], "email logo is 2x of the 197 x 48 it is shown at");
});

test("every HTML page head carries the favicon links, and none still use the old yellow square", () => {
  const pages = htmlFiles("public");
  assert.ok(pages.length >= 9, "all static pages found: " + pages.join(", "));
  for (const f of pages) {
    const s = fs.readFileSync(f, "utf8");
    assert.match(s, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, f);
    assert.match(s, /<link rel="icon" href="\/favicon-32\.png" sizes="32x32" type="image\/png">/, f);
    assert.match(s, /<link rel="icon" href="\/favicon-16\.png" sizes="16x16" type="image\/png">/, f);
    assert.match(s, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/, f);
    assert.equal(s.includes("M9.5 8h13v3.2"), false, f + " has no old mark");
    assert.match(s, /<script src="\/footer\.js" defer><\/script>/, f + " keeps the footer");
  }
  // the three server-rendered customer pages keep their own per-customer branding on purpose
});

test("sidebar logo: the right variant per theme, readable on each sidebar surface", () => {
  const html = read("admin/index.html"), css = read("admin/styles.css");
  assert.match(html, /<div class="brand">\s*<img class="brand-logo on-light" src="\/brand\/logo-lockup\.svg" alt=""[^>]*>\s*<img class="brand-logo on-dark" src="\/brand\/logo-lockup-dark\.svg" alt=""[^>]*>\s*<img class="brand-mark on-light" src="\/brand\/logo-mark\.svg"[^>]*>\s*<img class="brand-mark on-dark" src="\/brand\/logo-mark-dark\.svg"[^>]*>\s*<span id="brand-name" class="sr-only">Express Help<\/span>/);
  assert.match(css, /\.brand-logo\.on-dark\{display:none\}/);
  assert.match(css, /html\[data-theme="dark"\] \.brand-logo\.on-light\{display:none\}/);
  assert.match(css, /html\[data-theme="dark"\] \.brand-logo\.on-dark\{display:block\}/);
  assert.equal(/data-theme="crazy"\] \.brand-logo/.test(css), false, "Crazy keeps the navy lockup: its sidebar is a solid light surface");
  assert.match(css, /html\[data-theme="crazy"\] \.sidebar\{background:var\(--card\)/);
  assert.match(html, /<h1 id="signin-title" class="sr-only">Express Help<\/h1>/);
  assert.match(html, /class="signin-logo on-light" src="\/brand\/logo-lockup\.svg"/);
  assert.match(html, /class="signin-logo on-dark" src="\/brand\/logo-lockup-dark\.svg"/);
  assert.match(css, /html\[data-theme="dark"\] \.signin-logo\.on-dark\{display:block\}/);
  assert.match(read("set-password.html"), /class="signin-logo" src="\/brand\/logo-lockup\.svg"/);
  // Dark sidebar surface vs the ring/white wordmark; Light and Crazy surfaces vs the navy wordmark
});

test("emails: invite, reset, digest and request-access carry the hosted logo with alt text and an absolute URL; plain text is unchanged", async () => {
  const brand = await import("../netlify/lib/brand.mjs");
  const logo = brand.emailLogoHtml();
  assert.match(logo, /<img src="https:\/\/expresshelp\.site\/brand\/logo-lockup-email\.png" alt="Express Help" width="197" height="48"/);
  assert.equal(logo.includes("<svg"), false, "no inline SVG in email");
  for (const f of ["credentials", "access-request", "support-digest"]) {
    const src = fs.readFileSync("netlify/lib/" + f + ".mjs", "utf8");
    assert.match(src, /emailLogoHtml\(\)/, f);
    assert.match(src, /import \{ emailLogoHtml \} from "\.\/brand\.mjs"/, f);
  }
  const { footerText, footerHtml } = await import("../netlify/lib/footer.mjs");
  assert.match(footerHtml(), /Cowabunga - please hesitate to reach out/);
  assert.match(footerText(), /^Cowabunga - please hesitate to reach out email me here: mailto:/);
  // the live asset is the one the email points at
  assert.ok(fs.existsSync("public/brand/logo-lockup-email.png"));
});

test("print views carry no logo", () => {
  const wh = fs.readFileSync("public/admin/warehouse-ui.mjs", "utf8");
  assert.equal(/brand\/|logo-/.test(wh), false);
  const css = read("admin/styles.css");
  assert.match(css.slice(css.lastIndexOf("@media print{")), /\.theme-pop/);
});
