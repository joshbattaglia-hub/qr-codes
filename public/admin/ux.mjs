/* Shared UX helpers for the admin: motion (respecting prefers-reduced-motion), feedback cues, focus handling for modals,
 * and the forgiving-input normalisers. Pure functions are exported so tests can run them without a browser. */

/* ---- Motion ---- */
export function reducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { return false; }
}
/** Duration tokens in ms, mirroring --dur-* in motion.css. */
export const DUR = { press: 90, fast: 150, base: 200, slow: 250, wind: 100 };
export const EASE = { out: "cubic-bezier(.2,.8,.2,1)", settle: "cubic-bezier(.34,1.45,.64,1)" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Anticipation: a tiny wind-up (about 100ms) before a big, infrequent action. Instant under reduced motion. */
export async function anticipate(el, fn) {
  if (el && !reducedMotion()) {
    el.classList.add("winding");
    await wait(DUR.wind);
    el.classList.remove("winding");
  }
  return fn();
}

/** One-shot class animation that cleans up after itself. Does nothing under reduced motion (the static state still shows). */
export function playClass(el, cls, ms = 600) {
  if (!el) return;
  el.classList.remove(cls);
  if (reducedMotion()) { el.classList.add(cls + "-static"); setTimeout(() => el.classList.remove(cls + "-static"), ms); return; }
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}
export const pulse = (el) => playClass(el, "pulse", 700);
export const shake = (el) => playClass(el, "shake", 450);
export const tick = (el) => playClass(el, "tick-pop", 700);

/** Pose to pose: remember where keyed elements are, then after the DOM changes slide each one from its old pose to its new one (FLIP). */
export function snapshotRects(root, selector, keyOf = (el) => el.dataset.id) {
  const rects = new Map();
  if (!root) return rects;
  for (const el of root.querySelectorAll(selector)) rects.set(keyOf(el), el.getBoundingClientRect());
  return rects;
}
export function flip(root, selector, before, keyOf = (el) => el.dataset.id, opts = {}) {
  if (!root || !before || !before.size || reducedMotion() || typeof Element.prototype.animate !== "function") return 0;
  let moved = 0;
  for (const el of root.querySelectorAll(selector)) {
    const old = before.get(keyOf(el));
    if (!old) continue;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    moved += 1;
    // Separate easings on x and y bend the path into a gentle arc, which guides the eye to where the card went.
    el.animate([{ translate: dx + "px 0" }, { translate: "0 0" }], { duration: opts.duration || DUR.slow, easing: "cubic-bezier(.3,.1,.3,1)" });
    el.animate([{ transform: "translateY(" + dy + "px) scale(1.02)" }, { transform: "none" }], { duration: opts.duration || DUR.slow, easing: EASE.out });
  }
  return moved;
}
/** Arc an element in from a point (for example a new ticket landing in its column). Subtle and only where it clarifies. */
export function arcIn(el, from = { x: 60, y: -50 }) {
  if (!el || reducedMotion() || typeof el.animate !== "function") return;
  el.animate([{ translate: from.x + "px 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 320, easing: "cubic-bezier(.2,.7,.3,1)" });
  el.animate([{ transform: "translateY(" + from.y + "px) scale(.94)" }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.3,1.4,.5,1)" });
}

/* ---- Modal focus handling (Jakob: Esc and scrim close, focus stays inside, focus returns to where it was) ---- */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function focusables(root) { return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null); }
export function trapTab(event, root) {
  if (event.key !== "Tab" || !root) return false;
  const items = focusables(root);
  if (!items.length) { event.preventDefault(); return true; }
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); return true; }
  if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); return true; }
  return false;
}

/* ---- Doherty: optimistic updates. Apply at once, ask the server, and put things back with an error if it says no. ---- */
export async function optimistic({ apply, request, rollback, onError }) {
  apply();
  try { return await request(); }
  catch (err) {
    try { rollback(); } catch { /* the page is repainted by the caller anyway */ }
    if (onError) onError(err);
    return undefined;
  }
}

/* ---- Postel: be forgiving about what people type or paste, strict about what is stored (the server still validates). ---- */
const EMAIL_LEAD = /^\s*(mailto:)?/i;
/** "  <Sam.Smith@Example.com> " -> "sam.smith@example.com". Also handles "Sam Smith <a@b.com>" and mailto: links. Returns "" when nothing email-like is there. */
export function normaliseEmail(value) {
  let text = String(value ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").trim();
  const angle = text.match(/<([^<>]+)>/);
  if (angle) text = angle[1];
  text = text.replace(EMAIL_LEAD, "").replace(/[\s<>"'(),;:]+$/g, "").replace(/^[\s<>"'(),;:]+/g, "");
  text = text.replace(/\s+/g, "");
  return text.toLowerCase();
}
/** Several addresses pasted with commas, semicolons, spaces or new lines. */
export function normaliseEmailList(value) {
  return [...new Set(String(value ?? "").split(/[\n,;]+|\s{2,}/).map(normaliseEmail).filter(Boolean))];
}
/** "(03) 9123-4567", "+61 3 9123 4567", "0412 345 678" -> digits with an optional leading +. Spaces, brackets, dots and dashes are dropped. */
export function normalisePhone(value) {
  const text = String(value ?? "").trim().replace(/^(tel:)/i, "");
  const plus = /^\s*(\+|00)/.test(text) ? "+" : "";
  const digits = text.replace(/^\s*(\+|00)/, "").replace(/\D/g, "");
  if (!digits) return "";
  return plus + digits;
}
/** Dates: 2026-11-19, 19/11/2026, 19-11-26, 19.11.2026, 19 Nov 2026, "Nov 19 2026" -> "2026-11-19". Day first (Australian). Returns "" when it is not a real date. */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
export function normaliseDate(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
  if (!text) return "";
  let y, m, d, hit;
  if ((hit = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +hit[1]; m = +hit[2]; d = +hit[3]; }
  else if ((hit = text.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/))) { d = +hit[1]; m = +hit[2]; y = +hit[3]; if (hit[3].length === 2) y += 2000; }
  else if ((hit = text.match(/^(\d{1,2}) ([a-z]{3,9}) (\d{2}|\d{4})$/))) { d = +hit[1]; m = MONTHS[hit[2].slice(0, 4)] || MONTHS[hit[2].slice(0, 3)]; y = +hit[3]; if (hit[3].length === 2) y += 2000; }
  else if ((hit = text.match(/^([a-z]{3,9}) (\d{1,2}) (\d{2}|\d{4})$/))) { m = MONTHS[hit[1].slice(0, 4)] || MONTHS[hit[1].slice(0, 3)]; d = +hit[2]; y = +hit[3]; if (hit[3].length === 2) y += 2000; }
  if (!y || !m || !d) return "";
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return "";
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
/** A pasted Code 39 barcode: "*abc 123*", with line breaks, tabs or stray spaces -> "ABC123". */
export function normaliseBarcode(value) {
  return String(value ?? "").replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "").replace(/^\*+|\*+$/g, "").replace(/\*{2,}/g, "*").toUpperCase();
}
/** Multi-line pasted barcodes: one per line, trimmed, with blank lines and asterisks removed. */
export function normaliseBarcodeLines(value) {
  return String(value ?? "").split(/\r?\n|,|;/).map(normaliseBarcode).filter(Boolean);
}
/** Attach a normaliser to inputs that should tidy themselves when the person leaves the field (never while typing). */
export function wireTidyInputs(root) {
  const tidy = (el) => {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
    const kind = el.dataset.tidy || (el.type === "email" ? "email" : el.type === "tel" ? "phone" : "");
    const fn = kind === "email" ? normaliseEmail : kind === "phone" ? normalisePhone : kind === "barcode" ? normaliseBarcode : kind === "barcodes" ? (v) => normaliseBarcodeLines(v).join("\n") : kind === "date" ? (v) => normaliseDate(v) || v : null;
    if (!fn || !el.value) return;
    const next = fn(el.value);
    if (next !== el.value && (next || kind === "email")) el.value = next;
  };
  root.addEventListener("focusout", (event) => tidy(event.target));
  root.addEventListener("paste", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || (el.dataset.tidy !== "barcode" && el.dataset.tidy !== "email")) return;
    const text = (event.clipboardData || window.clipboardData)?.getData("text");
    if (!text) return;
    event.preventDefault();
    el.value = el.dataset.tidy === "barcode" ? normaliseBarcode(text) : normaliseEmail(text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Inline status line: a tick for success, a shake and an alert role for errors. */
export function showNote(el, text, kind = "error") {
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("saved-tick", "err-note");
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  if (!text) return;
  if (kind === "ok") { el.classList.add("saved-tick"); tick(el); }
  else { el.classList.add("err-note"); shake(el); }
}
