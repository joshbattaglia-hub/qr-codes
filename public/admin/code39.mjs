/** Standard Code 39. No checksum, no full-ASCII extension. Patterns match python-barcode Code39(add_checksum=False). */

const ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
const CODES = [
  "101000111011101", "111010001010111", "101110001010111", "111011100010101", "101000111010111",
  "111010001110101", "101110001110101", "101000101110111", "111010001011101", "101110001011101",
  "111010100010111", "101110100010111", "111011101000101", "101011100010111", "111010111000101",
  "101110111000101", "101010001110111", "111010100011101", "101110100011101", "101011100011101",
  "111010101000111", "101110101000111", "111011101010001", "101011101000111", "111010111010001",
  "101110111010001", "101010111000111", "111010101110001", "101110101110001", "101011101110001",
  "111000101010111", "100011101010111", "111000111010101", "100010111010111", "111000101110101",
  "100011101110101", "100010101110111", "111000101011101", "100011101011101", "100010001000101",
  "100010001010001", "100010100010001", "101000100010001",
];
const EDGE = "100010111011101";

export const CODE39_DEFAULTS = {
  payload: "LOC50924",
  heading: "Liberty Oil Convenience",
  labelWidthMm: 70,
  labelHeightMm: 36,
  moduleMm: 0.33,
  barHeightMm: 12,
  ratio: 3,
  quietModules: 10,
};

export const CODE39_LIMITS = {
  payload: 40,
  batch: 40,
  moduleMin: 0.19,
  moduleMax: 1,
  ratioMin: 2,
  ratioMax: 3,
  barMin: 5,
  barMax: 40,
  quietMin: 10,
  quietMax: 30,
  labelWidthMin: 20,
  labelWidthMax: 150,
  labelHeightMin: 15,
  labelHeightMax: 80,
};

function elementsOf(bits) {
  const list = [];
  let index = 0;
  while (index < bits.length) {
    let next = index;
    while (next < bits.length && bits[next] === bits[index]) next += 1;
    const span = next - index;
    if (span !== 1 && span !== 3) throw new Error("Bad Code 39 element");
    list.push({ black: bits[index] === "1", wide: span === 3 });
    index = next;
  }
  return list;
}

export function symbolElements(payload) {
  const chars = [EDGE];
  for (const ch of payload) {
    const index = ORDER.indexOf(ch);
    if (index < 0) throw new Error("Unsupported Code 39 character");
    chars.push(CODES[index]);
  }
  chars.push(EDGE);
  const elements = [];
  chars.forEach((bits, index) => {
    elements.push(...elementsOf(bits));
    if (index < chars.length - 1) elements.push({ black: false, wide: false });
  });
  return elements;
}

export function code39Bits(payload) {
  return symbolElements(payload).map((element) => (element.black ? "1" : "0").repeat(element.wide ? 3 : 1)).join("");
}

export function validatePayload(raw, { uppercase = false } = {}) {
  const payload = String(raw ?? "");
  if (!payload) return { error: "Enter an asset ID" };
  if (payload.length > CODE39_LIMITS.payload) return { error: "Use at most " + CODE39_LIMITS.payload + " characters" };
  if (payload.includes("*")) return { error: "The * character is reserved for the start and stop bars" };
  const lower = /[a-z]/.test(payload);
  const other = [...payload].some((ch) => ORDER.indexOf(ch) < 0 && !/[a-z]/.test(ch));
  if (other) return { error: "Code 39 allows A–Z, 0–9, space, and - . $ / + % only" };
  if (lower && !uppercase) return { error: "Lower-case is not Code 39. Confirm uppercase conversion or edit the ID." };
  const encoded = lower ? payload.toUpperCase() : payload;
  if ([...encoded].some((ch) => ORDER.indexOf(ch) < 0)) return { error: "Code 39 allows A–Z, 0–9, space, and - . $ / + % only" };
  return { payload: encoded, converted: encoded !== payload };
}

export function parseBatch(text, options) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const items = [];
  const errors = [];
  let count = 0;
  lines.forEach((line, index) => {
    if (line === "") return;
    count += 1;
    if (count > CODE39_LIMITS.batch) {
      errors.push({ line: index + 1, error: "Batch is limited to " + CODE39_LIMITS.batch + " IDs" });
      return;
    }
    const result = validatePayload(line, options);
    if (result.error) errors.push({ line: index + 1, error: result.error, entered: line });
    else items.push({ line: index + 1, entered: line, payload: result.payload, converted: result.converted });
  });
  return { items: errors.length ? [] : items, errors };
}

function numberIn(value, min, max, fallback, whole) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { value: fallback, error: "Enter a number" };
  if (whole && Math.abs(number - Math.round(number)) > 1e-9) return { value: number, error: "Use a whole number from " + min + " to " + max };
  if (number < min || number > max) return { value: number, error: "Use " + min + " to " + max };
  return { value: whole ? Math.round(number) : number };
}

export function readLayout(input) {
  const module = numberIn(input.moduleMm, CODE39_LIMITS.moduleMin, CODE39_LIMITS.moduleMax, CODE39_DEFAULTS.moduleMm);
  const ratio = numberIn(input.ratio, CODE39_LIMITS.ratioMin, CODE39_LIMITS.ratioMax, CODE39_DEFAULTS.ratio);
  const bar = numberIn(input.barHeightMm, CODE39_LIMITS.barMin, CODE39_LIMITS.barMax, CODE39_DEFAULTS.barHeightMm);
  const quiet = numberIn(input.quietModules, CODE39_LIMITS.quietMin, CODE39_LIMITS.quietMax, CODE39_DEFAULTS.quietModules, true);
  const labelWidth = numberIn(input.labelWidthMm, CODE39_LIMITS.labelWidthMin, CODE39_LIMITS.labelWidthMax, CODE39_DEFAULTS.labelWidthMm);
  const labelHeight = numberIn(input.labelHeightMm, CODE39_LIMITS.labelHeightMin, CODE39_LIMITS.labelHeightMax, CODE39_DEFAULTS.labelHeightMm);
  const errors = [module, ratio, bar, quiet, labelWidth, labelHeight].filter((item) => item.error).map((item) => item.error);
  return {
    errors,
    moduleMm: module.value,
    ratio: ratio.value,
    barHeightMm: bar.value,
    quietModules: quiet.value,
    labelWidthMm: labelWidth.value,
    labelHeightMm: labelHeight.value,
  };
}

export function symbolWidthMm(payload, layout) {
  const narrows = symbolElements(payload).reduce((sum, element) => sum + (element.wide ? layout.ratio : 1), 0);
  return (narrows + layout.quietModules * 2) * layout.moduleMm;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

export function code39Svg(payload, layout, heading) {
  const quiet = layout.quietModules * layout.moduleMm;
  let x = quiet;
  const rects = [];
  for (const element of symbolElements(payload)) {
    const width = (element.wide ? layout.ratio : 1) * layout.moduleMm;
    if (element.black) rects.push({ x, width });
    x += width;
  }
  const symbolWidth = x + quiet;
  const textMm = 3.2;
  const headingMm = heading ? 4 : 0;
  const neededHeight = 3 + headingMm + layout.barHeightMm + textMm + 4;
  const width = Math.max(layout.labelWidthMm, symbolWidth);
  const height = Math.max(layout.labelHeightMm, neededHeight);
  const offset = Math.max(0, (width - symbolWidth) / 2);
  const notes = [];
  if (symbolWidth - layout.labelWidthMm > 0.05) notes.push("The symbol is " + symbolWidth.toFixed(1) + " mm wide and does not fit in the " + layout.labelWidthMm + " mm label. Increase the label width or reduce the module width. The bars were not shrunk.");
  if (neededHeight - layout.labelHeightMm > 0.05) notes.push("The label content is " + neededHeight.toFixed(1) + " mm tall and does not fit in the " + layout.labelHeightMm + " mm label. Increase the label height. The bars were not shrunk.");
  const yBar = 2 + headingMm;
  const center = offset + symbolWidth / 2;
  const bars = rects.map((rect) => `<rect x="${(rect.x + offset).toFixed(3)}" y="${yBar.toFixed(3)}" width="${rect.width.toFixed(3)}" height="${layout.barHeightMm.toFixed(3)}" fill="#000"/>`).join("");
  const headingText = heading ? `<text x="${center.toFixed(3)}" y="${(headingMm).toFixed(3)}" text-anchor="middle" font-family="sans-serif" font-size="3.2" fill="#000">${xml(heading)}</text>` : "";
  const payloadText = `<text x="${center.toFixed(3)}" y="${(yBar + layout.barHeightMm + textMm).toFixed(3)}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="3" fill="#000">${xml(payload)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}mm" height="${height.toFixed(2)}mm" viewBox="0 0 ${width.toFixed(3)} ${height.toFixed(3)}" role="img" aria-label="Code 39 asset barcode"><rect width="100%" height="100%" fill="#fff"/>${headingText}${bars}${payloadText}</svg>`;
  return { svg, widthMm: width, heightMm: height, symbolWidthMm: symbolWidth, notes };
}

export function safeAssetName(payload) {
  const body = [...payload].map((ch) => /[A-Za-z0-9-]/.test(ch) ? ch : "_" + ch.charCodeAt(0).toString(16)).join("").replace(/^\.+/, "");
  return ("asset-" + (body || "label")).slice(0, 80);
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc;
}

export function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]+$/.test(file.name)) throw new Error("Unsafe asset filename");
    const name = new TextEncoder().encode(file.name);
    const data = new TextEncoder().encode(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(26, name.length, true);
    view.setUint32(14, crc >>> 0, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(16, crc >>> 0, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint32(42, offset, true);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const count = files.length;
  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, count, true);
  endView.setUint16(10, count, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

export function printHtml(labels) {
  const blocks = labels.map((label) => `<section>${label.svg}</section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Asset labels</title><style>
    @page { margin: 12mm; }
    body { margin: 0; background: #fff; color: #000; }
    section { break-inside: avoid; page-break-inside: avoid; margin: 0 0 8mm; }
    h1, p { font-family: sans-serif; text-align: center; margin: 0; }
    h1 { font-size: 11pt; }
    p { font-family: ui-monospace, monospace; font-size: 10pt; }
    svg { display: block; margin: 1mm auto; }
  </style></head><body>${blocks}</body></html>`;
}
