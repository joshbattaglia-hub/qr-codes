import { CODE39_DEFAULTS, code39Svg, symbolElements } from "./code39.mjs";

/**
 * Warehouse Stickers: one button issues the next full A4 sheet (Avery L7160, 21 labels) of WH codes from the server counter.
 * Same Code 39 encoder and label style as Asset Barcodes. Printing happens in a hidden frame at 100% scale.
 */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (iso) => { try { return new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) + " AEDT"; } catch { return iso; } };

export const L7160 = { name: "Avery L7160", perSheet: 21, columns: 3, rows: 7, labelWidthMm: 63.5, labelHeightMm: 38.1, topMarginMm: 15.15, sideMarginMm: 7.21, columnGapMm: 2.54, columnPitchMm: 66.04, rowPitchMm: 38.1 };
const SAFE_WIDTH_MM = 60; // 1.75 mm inside each label edge (Avery's recommended inner margin)
const MODULE_MIN = 0.25;

export function newKey() {
  const bytes = new Uint8Array(16);
  (globalThis.crypto || {}).getRandomValues?.(bytes);
  return "wh" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") + Date.now().toString(36);
}

/** Asset Barcodes look (0.33 mm module, 3:1, 12 mm bars, 10-module quiet zones, same heading). Shrinks the module only if a long code would overflow. */
export function stickerLayout(code) {
  const narrows = symbolElements(code).reduce((sum, el) => sum + (el.wide ? CODE39_DEFAULTS.ratio : 1), 0) + CODE39_DEFAULTS.quietModules * 2;
  const fitted = Math.floor((SAFE_WIDTH_MM / narrows) * 1000) / 1000;
  const moduleMm = Math.max(MODULE_MIN, Math.min(CODE39_DEFAULTS.moduleMm, fitted));
  return { moduleMm, ratio: CODE39_DEFAULTS.ratio, barHeightMm: CODE39_DEFAULTS.barHeightMm, quietModules: CODE39_DEFAULTS.quietModules, labelWidthMm: SAFE_WIDTH_MM, labelHeightMm: 27 };
}

export function stickerSvg(code) {
  return code39Svg(code, stickerLayout(code), CODE39_DEFAULTS.heading).svg;
}

/** Full printable A4 page laid out to the L7160 template: 15.15 mm top, 7.21 mm sides, 66.04 mm column pitch, 38.1 mm row pitch. */
export function sheetHtml(codes, { title = "Warehouse stickers" } = {}) {
  const t = L7160;
  const cells = [];
  for (let i = 0; i < t.perSheet; i++) {
    const code = codes[i];
    cells.push('<div class="label">' + (code ? stickerSvg(code) : "") + "</div>");
  }
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>'
    + "@page{size:A4 portrait;margin:0}"
    + "html,body{margin:0;padding:0;background:#fff}"
    + "*{box-sizing:border-box}"
    + ".sheet{width:210mm;height:297mm;padding:" + t.topMarginMm + "mm " + t.sideMarginMm + "mm 0;display:grid;grid-template-columns:repeat(" + t.columns + "," + t.labelWidthMm + "mm);grid-auto-rows:" + t.labelHeightMm + "mm;column-gap:" + t.columnGapMm + "mm;row-gap:0;overflow:hidden;page-break-after:avoid}"
    + ".label{width:" + t.labelWidthMm + "mm;height:" + t.labelHeightMm + "mm;display:flex;align-items:center;justify-content:center;overflow:hidden}"
    + ".label svg{display:block}"
    + "@media screen{body{background:#e5e7eb}.sheet{background:#fff;margin:8mm auto}.label{outline:0.2mm dashed #cbd5e1;border-radius:1.5mm}}"
    + '</style></head><body><div class="sheet" data-testid="wh-sheet">' + cells.join("") + "</div></body></html>";
}

export function warehousePage() {
  return '<div class="asset-page warehouse-page" id="warehouse-page" data-testid="warehouse-page"><div class="page-head"><div><p class="asset-kicker">Warehouse</p><h1>Warehouse Stickers</h1><p class="muted">One press prints the next sheet of 21 numbered barcode stickers. Numbers are never reused.</p></div></div><div id="warehouse-body">Loading…</div></div>';
}

let current = null;
let pendingKey = "";

function status(msg, err = false) {
  const el = document.getElementById("wh-status");
  if (el) { el.textContent = msg; el.className = "small" + (err ? " err" : ""); }
}

function printFrame(html) {
  let frame = document.getElementById("wh-print-frame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "wh-print-frame";
    frame.title = "Warehouse sticker sheet";
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
  }
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  try { frame.contentWindow.focus(); frame.contentWindow.print(); return true; } catch { return false; }
}

function previewHtml(sheet, codes) {
  return '<div class="card" data-testid="wh-preview"><div class="card-head"><h2>Sheet ' + esc(sheet.first) + " – " + esc(sheet.last) + '</h2><button class="btn ghost" type="button" data-act="wh-print-last">Print this sheet again</button></div>'
    + '<div class="wh-mini" aria-label="Sheet preview">' + codes.map((c) => '<div class="wh-mini-label">' + stickerSvg(c) + "</div>").join("") + "</div>"
    + '<p class="small muted">Print at 100% / "Actual size" with no scaling or "fit to page", on ' + esc(L7160.name) + " (63.5 × 38.1 mm, 21 per sheet).</p></div>";
}

function render(data, last) {
  const box = document.getElementById("warehouse-body");
  if (!box) return;
  const can = data.can || { generate: true, reprint: true, admin: !!data.canAdmin };
  const rows = (data.sheets || []).map((s) => '<tr data-testid="wh-row"><td><strong>' + esc(s.first) + " – " + esc(s.last) + '</strong><div class="muted small">' + esc(s.count) + ' stickers</div></td><td>' + esc(s.by) + '</td><td>' + esc(when(s.at)) + '</td><td>' + (s.reprints ? esc(s.reprints) + "× (last " + esc(when(s.lastReprintAt)) + ")" : "—") + '</td><td>' + (can.reprint ? '<button class="btn ghost btn-xs" type="button" data-act="wh-reprint" data-id="' + esc(s.id) + '">Reprint</button>' : "") + '</td></tr>').join("");
  const admin = data.canAdmin ? '<div class="card" data-testid="wh-admin"><h2>Settings (admin)</h2><p class="muted small">Next number to issue. It can only move forward. Moving it back could reprint codes already on stickers, so that needs the override and a confirmation. Every change is logged.</p>'
    + '<div class="wh-admin-row"><label class="field"><span>Next number</span><input id="wh-next" inputmode="numeric" autocomplete="off" value="' + esc(data.next) + '" data-testid="wh-next"></label>'
    + '<label class="check"><input type="checkbox" id="wh-override"> Override: allow moving back</label>'
    + '<button class="btn ghost" type="button" data-act="wh-save-next">Save next number</button></div>'
    + '<p id="wh-admin-note" class="small"></p>'
    + ((data.changes || []).length ? '<h3>Change log</h3><ul class="user-history" data-testid="wh-changes">' + data.changes.map((c) => "<li>" + esc(when(c.at)) + " · " + esc(c.by) + " · " + (c.action === "set-next" ? "next number " + esc(c.fromCode) + " → " + esc(c.toCode) + (c.override ? " (override)" : "") : c.action === "reprint" ? "reprinted " + esc(c.first) + " – " + esc(c.last) : esc(c.action)) + "</li>").join("") + "</ul>" : "")
    + "</div>" : "";
  const main = can.generate
    ? '<p class="wh-next-label muted">Next sheet starts at</p><p class="wh-next-code" data-testid="wh-next-code">' + esc(data.nextCode) + '</p>'
      + '<button class="btn wh-go" type="button" data-act="wh-generate" data-testid="wh-generate">Generate next sheet of stickers</button>'
    : '<p class="muted" data-testid="wh-no-generate">You can reprint earlier sheets below. Making new sheets is not turned on for you.</p>';
  box.innerHTML = '<div class="card wh-main" data-testid="wh-main">' + main
    + '<p id="wh-status" class="small" role="status" aria-live="polite"></p>'
    + '<p class="small muted">' + esc(L7160.name) + " · 21 per A4 sheet · Code 39 · print at 100% (no scaling)</p></div>"
    + (last ? previewHtml(last.sheet, last.codes) : "")
    + '<div class="card"><h2>History</h2>' + (rows ? '<div class="table-wrap"><table class="visitor-sheet" data-testid="wh-history"><thead><tr><th>Codes</th><th>Made by</th><th>When</th><th>Reprints</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<p class="muted" data-testid="wh-empty">No sheets yet. The first press prints WH' + esc(data.start || 1000) + " – WH" + esc((data.start || 1000) + 20) + ".</p>") + "</div>"
    + admin;
}

export async function paintWarehouse() {
  const box = document.getElementById("warehouse-body");
  if (!box) return;
  const res = await fetch("/api/warehouse", { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { box.innerHTML = '<p class="card" data-testid="wh-denied">' + esc(data.error || "Warehouse Stickers is not available for this sign-in.") + "</p>"; return; }
  current = { data, last: current?.last || null };
  if (!pendingKey) pendingKey = newKey();
  render(data, current.last);
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

export async function warehouseAction(button) {
  const act = button.dataset.act;
  if (act === "wh-generate") {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.textContent;
    button.innerHTML = '<span class="wh-spin" aria-hidden="true"></span> Generating…';
    button.setAttribute("aria-busy", "true");
    if (!pendingKey) pendingKey = newKey();
    let issued = false;
    try {
      const r = await post("/api/warehouse/sheets", { idempotencyKey: pendingKey });
      if (!r.ok) {
        if (r.status !== 409 && r.status < 500) pendingKey = newKey();
        status(r.body.error || "Not generated. No numbers were used.", true);
        return;
      }
      pendingKey = newKey();
      issued = true;
      current = { ...(current || {}), last: { sheet: r.body.sheet, codes: r.body.codes } };
      await paintWarehouse();
      const opened = printFrame(sheetHtml(r.body.codes, { title: "Warehouse stickers " + r.body.sheet.first + "-" + r.body.sheet.last }));
      status((r.body.replay ? "Already issued (same press): " : "Issued ") + r.body.sheet.first + " – " + r.body.sheet.last + ". " + (opened ? "Print dialog opened." : "Use Print this sheet again."));
    } catch {
      status("No answer from the server. Press again: the same request key is reused, so it cannot use two sheets.", true);
    } finally {
      // Stay disabled briefly after a success so a fast double click cannot start a second sheet.
      const release = () => {
        const fresh = document.querySelector('[data-act="wh-generate"]');
        if (fresh) { fresh.disabled = false; fresh.removeAttribute("aria-busy"); fresh.textContent = label; }
      };
      const fresh = document.querySelector('[data-act="wh-generate"]');
      if (fresh && issued) { fresh.disabled = true; fresh.textContent = "Sheet issued ✓"; setTimeout(release, 2500); } else release();
    }
    return;
  }
  if (act === "wh-print-last" && current?.last) {
    printFrame(sheetHtml(current.last.codes, { title: "Warehouse stickers " + current.last.sheet.first + "-" + current.last.sheet.last }));
    return;
  }
  if (act === "wh-reprint") {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const r = await post("/api/warehouse/sheets/" + encodeURIComponent(button.dataset.id) + "/reprint", {});
      if (!r.ok) { status(r.body.error || "Reprint failed.", true); return; }
      current = { ...(current || {}), last: { sheet: r.body.sheet, codes: r.body.codes } };
      await paintWarehouse();
      printFrame(sheetHtml(r.body.codes, { title: "Warehouse stickers " + r.body.sheet.first + "-" + r.body.sheet.last + " (reprint)" }));
      status("Reprinting " + r.body.sheet.first + " – " + r.body.sheet.last + ". The counter did not change.");
    } finally { button.disabled = false; }
    return;
  }
  if (act === "wh-save-next") {
    const note = document.getElementById("wh-admin-note");
    const next = document.getElementById("wh-next")?.value || "";
    const override = !!document.getElementById("wh-override")?.checked;
    if (override && !confirm("Move the next number back to " + next + "? Codes from there up may already be on stickers and would be printed again.")) return;
    button.disabled = true;
    try {
      const r = await post("/api/warehouse/settings", { next, confirmBackward: override });
      if (note) { note.textContent = r.ok ? (r.body.changed ? "Saved. Next sheet starts at " + r.body.nextCode + "." : "No change.") : (r.body.error || "Not saved."); note.className = "small" + (r.ok ? "" : " err"); }
      if (r.ok && r.body.changed) await paintWarehouse();
    } finally { button.disabled = false; }
  }
}
