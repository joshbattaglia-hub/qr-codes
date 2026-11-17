/* Express Help admin theme: Crazy (default), Light, Dark.
 * Loaded as a plain blocking <script> in <head> so the saved theme is on <html> before the first paint (no flash).
 * The same file is loaded by the tests (CommonJS export at the bottom).
 *
 * Storage (localStorage, never sent anywhere):
 *   eh-theme:u:<email>  the choice of one signed-in account (email lower-cased)
 *   eh-theme:device     the device-wide choice, used before sign-in and for head office (no email)
 *   eh-theme:last       the account that last signed in on this device, so the early script knows whose choice to apply
 * Crazy is the default when nothing is saved for the account/device. A saved Light or Dark is never overwritten: the default is only ever
 * *read* when there is no saved value, it is not written back. The system dark-mode setting is deliberately ignored. */
(function (root) {
  "use strict";
  var THEMES = ["light", "dark", "crazy"];
  var DEFAULT = "crazy";
  var LABELS = { light: "Light", dark: "Dark", crazy: "Crazy" };
  var DEVICE = "eh-theme:device";
  var LAST = "eh-theme:last";
  var USER = "eh-theme:u:";
  var account = null;

  function valid(value) { return THEMES.indexOf(value) >= 0 ? value : null; }
  function accountKey(email) {
    var e = String(email == null ? "" : email).trim().toLowerCase();
    return e && e.length <= 254 && e.indexOf("@") > 0 ? e : null;
  }
  function read(key) { try { return root.localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { root.localStorage.setItem(key, value); } catch (e) { /* private mode: the choice just lasts for this page */ } }
  function drop(key) { try { root.localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  /** The theme to use for an account (or the device when there is no account). Crazy unless a choice was saved. */
  function choice(email) {
    var key = accountKey(email);
    if (key) return valid(read(USER + key)) || DEFAULT;
    return valid(read(DEVICE)) || DEFAULT;
  }

  /* ---- colour maths (WCAG 2.x) ---- */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s /= 100; l /= 100;
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (s === 0) { var g = Math.round(l * 255); return [g, g, g]; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [Math.round(f(p, q, h + 1 / 3) * 255), Math.round(f(p, q, h) * 255), Math.round(f(p, q, h - 1 / 3) * 255)];
  }
  function toHex(rgb) { return "#" + rgb.map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join(""); }
  function parseHex(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return null;
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  }
  function luminance(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var A = typeof a === "string" ? parseHex(a) : a;
    var B = typeof b === "string" ? parseHex(b) : b;
    var la = luminance(A), lb = luminance(B);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /** Step lightness down (dark text on light) or up until `against` reaches `min` contrast. */
  function fit(h, s, l, against, min, dir) {
    var rgb = hslToRgb(h, s, l);
    while (contrast(rgb, against) < min && l > 0 && l < 100) { l += dir; rgb = hslToRgb(h, s, l); }
    return rgb;
  }

  /** A fresh vivid palette. `rand` returns [0,1). Surfaces are solid and light, text is near black, and every text/background pair
   *  the admin uses is pushed to at least 4.5:1 (body text 7:1+), so only borders, glows and the page background are wild. */
  function makePalette(rand) {
    rand = rand || Math.random;
    var h = Math.floor(rand() * 360);
    var step = 50 + Math.floor(rand() * 50);
    var hues = [0, 1, 2, 3, 4].map(function (i) { return (h + i * step) % 360; });
    var vivid = hues.map(function (x) { return toHex(hslToRgb(x, 100, 52)); });
    var bg = hslToRgb(hues[1], 100, 94);
    var card = hslToRgb(hues[1], 100, 98);
    var soft = hslToRgb(hues[2], 100, 89);
    var ink = hslToRgb(hues[0], 70, 7);
    var white = [255, 255, 255];
    var muted = (function () { var l = 40, rgb = hslToRgb(hues[0], 45, l); while ((contrast(rgb, soft) < 5 || contrast(rgb, bg) < 5 || contrast(rgb, card) < 5) && l > 0) { l -= 1; rgb = hslToRgb(hues[0], 45, l); } return rgb; })();
    var blue = fit(hues[3], 100, 46, white, 6, -1);
    var blueDark = fit(hues[3], 100, 36, white, 9, -1);
    var navy = fit(hues[4], 100, 28, white, 9, -1);
    var link = (function () { var l = 42, rgb = hslToRgb(hues[3], 100, l); while ((contrast(rgb, soft) < 5 || contrast(rgb, bg) < 5 || contrast(rgb, card) < 5 || contrast(rgb, [255, 255, 255]) < 5) && l > 0) { l -= 1; rgb = hslToRgb(hues[3], 100, l); } return rgb; })();
    var danger = fit(8, 90, 42, white, 5, -1);
    var errInk = fit(8, 90, 40, card, 5.5, -1);
    var okInk = fit(145, 100, 25, card, 5.5, -1);
    var vars = {
      "--bg": toHex(bg), "--card": toHex(card), "--ink": toHex(ink), "--muted": toHex(muted), "--line": vivid[2],
      "--blue": toHex(blue), "--blue-dark": toHex(blueDark), "--navy": toHex(navy), "--soft": toHex(soft),
      "--link": toHex(link), "--link-strong": toHex(blueDark), "--soft-ink": toHex(navy), "--nav-active-ink": toHex(blueDark),
      "--red": toHex(errInk), "--danger-bg": toHex(danger), "--green": toHex(okInk),
      "--c1": vivid[0], "--c2": vivid[1], "--c3": vivid[2], "--c4": vivid[3], "--c5": vivid[4]
    };
    return { hues: hues, vars: vars };
  }

  function css(vars) {
    var out = [];
    for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) out.push(k + ":" + vars[k]);
    // Only on screen. Print never sees these, so every print view is light whatever the theme.
    return "@media screen{html[data-theme=\"crazy\"]{" + out.join(";") + "}}";
  }

  var palette = null;
  function applyCrazy(fresh) {
    var doc = root.document;
    if (!doc || !doc.head) return null;
    if (fresh || !palette) palette = makePalette();
    var el = doc.getElementById("eh-crazy-vars");
    if (!el) { el = doc.createElement("style"); el.id = "eh-crazy-vars"; doc.head.appendChild(el); }
    el.textContent = css(palette.vars);
    return palette;
  }
  function clearCrazy() {
    var el = root.document && root.document.getElementById("eh-crazy-vars");
    if (el) el.textContent = "";
  }

  /** Put a theme on <html>. Does not save. Picking Crazy again rolls a new palette. */
  function apply(theme, reroll) {
    var t = valid(theme) || DEFAULT;
    var doc = root.document;
    if (!doc || !doc.documentElement) return t;
    doc.documentElement.setAttribute("data-theme", t);
    if (t === "crazy") applyCrazy(reroll !== false); else clearCrazy();
    var meta = doc.querySelector && doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "dark" ? "#0e121b" : "#f3f4f8");
    return t;
  }

  /** Early apply: whoever signed in last on this device, else the device choice, else Crazy. */
  function early() {
    var last = accountKey(read(LAST));
    return apply(choice(last), true);
  }
  /** After sign-in: switch to this account's own choice (email null = head office / unknown, which uses the device-wide choice). */
  function setAccount(email) {
    account = accountKey(email);
    if (account) write(LAST, account); else drop(LAST);
    return apply(choice(account), true);
  }
  /** The user picked a theme: remember it for the signed-in account (or the device if there is none). */
  function choose(theme) {
    var t = valid(theme);
    if (!t) return null;
    write(account ? USER + account : DEVICE, t);
    apply(t, true);
    return t;
  }
  function current() {
    var el = root.document && root.document.documentElement;
    return (el && valid(el.getAttribute("data-theme"))) || DEFAULT;
  }
  /** Sign-in page and signed-out state: the theme of whoever last signed in on this device (else the device choice, else Crazy). Never saved,
   *  and the palette already rolled by early() is kept so the page does not change colour a second time. */
  function signedOut() { account = null; return apply(choice(accountKey(read(LAST))), false); }

  var api = {
    THEMES: THEMES, DEFAULT: DEFAULT, LABELS: LABELS, keys: { DEVICE: DEVICE, LAST: LAST, USER: USER },
    accountKey: accountKey, choice: choice, early: early, setAccount: setAccount, choose: choose, apply: apply, current: current,
    signedOut: signedOut, makePalette: makePalette, contrast: contrast, parseHex: parseHex, css: css
  };
  root.EHTheme = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  try { early(); } catch (e) { /* never block the page */ }
})(typeof window !== "undefined" ? window : globalThis);
