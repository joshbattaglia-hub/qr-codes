/** Code 128, code set B. Internal artwork only. Not a GTIN and not a vendor format. */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128_QUIET_MODULES = 10;
const MODULE = 2;
const BAR_HEIGHT = 80;
const START_B = 104;

export function code128Values(text) {
  const value = String(text ?? "");
  if (!value || value.length > 48) return { error: "Barcode value must be 1–48 characters" };
  const symbols = [];
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return { error: "Code 128 values use printable characters only" };
    symbols.push(code - 32);
  }
  let sum = START_B;
  symbols.forEach((symbol, index) => { sum += symbol * (index + 1); });
  return { symbols, checksum: sum % 103 };
}

export function code128Svg(text) {
  const parsed = code128Values(text);
  if (parsed.error) return parsed;
  const symbols = [START_B, ...parsed.symbols, parsed.checksum];
  const module = MODULE;
  let x = CODE128_QUIET_MODULES * module;
  const rects = [];
  for (const symbol of symbols) {
    const drawn = drawPattern(PATTERNS[symbol], x, module);
    rects.push(...drawn.rects);
    x = drawn.x;
  }
  const stop = drawPattern(PATTERNS[106], x, module);
  rects.push(...stop.rects);
  x = stop.x + CODE128_QUIET_MODULES * module;
  const width = x;
  const height = BAR_HEIGHT + 28;
  const bars = rects.map((rect) => `<rect x="${rect.x}" y="0" width="${rect.w}" height="${BAR_HEIGHT}"/>`).join("");
  const label = xml(text);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Code 128 barcode"><rect width="100%" height="100%" fill="#fff"/>${bars}<text x="${width / 2}" y="${BAR_HEIGHT + 20}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" fill="#111">${label}</text></svg>`;
}

function drawPattern(pattern, x0, module) {
  let x = x0;
  let dark = true;
  const rects = [];
  for (const digit of pattern) {
    const width = Number(digit) * module;
    if (dark) rects.push({ x, w: width });
    x += width;
    dark = !dark;
  }
  return { rects, x };
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

export { PATTERNS };
