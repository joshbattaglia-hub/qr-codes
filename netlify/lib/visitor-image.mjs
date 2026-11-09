import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const MAX_INPUT = 8_000_000;
const MAX_EDGE = 4096;
const MAX_PIXELS = 12_000_000;
const MAX_OUTPUT = 1_500_000;

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function kindOf(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand.startsWith("hei") || brand === "mif1" || brand === "msf1") return "heic";
  }
  const head = buf.subarray(0, Math.min(buf.length, 200)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("%pdf")) return "pdf";
  if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg")) return "svg";
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return "exe";
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return "exe";
  return "unknown";
}

function withinBounds(width, height) {
  return width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
}

function jpegSize(buf) {
  let offset = 2;
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length) return null;
    if (marker === 0xc0 || marker === 0xc1) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    if (marker >= 0xc2 && marker <= 0xcf) return { unsupported: true };
    offset += 2 + length;
  }
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function reencodeVisitorPhoto(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) return { error: "A photo of the ID is required." };
  if (buf.length > MAX_INPUT) return { error: "The photo is too large." };
  const kind = kindOf(buf);
  if (kind === "heic") return { error: "HEIC photos are not supported. Choose a JPEG or PNG." };
  if (kind === "pdf" || kind === "svg" || kind === "exe") return { error: "Use a JPEG or PNG photo." };
  if (kind === "jpeg") {
    const size = jpegSize(buf);
    if (!size || size.unsupported) return { error: "Use a standard JPEG or PNG photo." };
    if (!withinBounds(size.width, size.height)) return { error: "The photo is too large." };
    let decoded;
    try { decoded = jpeg.decode(buf, { maxResolutionInMP: 12, maxMemoryUsageInMB: 64, useTArray: true }); }
    catch { return { error: "The photo could not be read." }; }
    if (!decoded?.data || !withinBounds(decoded.width, decoded.height)) return { error: "The photo could not be read." };
    const encoded = jpeg.encode({ data: decoded.data, width: decoded.width, height: decoded.height }, 80);
    if (!encoded?.data || encoded.data.length > MAX_OUTPUT) return { error: "The photo is too large." };
    return { contentType: "image/jpeg", bytes: Buffer.from(encoded.data) };
  }
  if (kind === "png") {
    const size = pngSize(buf);
    if (!size || !withinBounds(size.width, size.height)) return { error: "The photo is too large." };
    let decoded;
    try { decoded = PNG.sync.read(buf); }
    catch { return { error: "The photo could not be read." }; }
    if (!withinBounds(decoded.width, decoded.height)) return { error: "The photo is too large." };
    const clean = new PNG({ width: decoded.width, height: decoded.height });
    Buffer.from(decoded.data).copy(clean.data);
    const encoded = PNG.sync.write(clean);
    if (encoded.length > MAX_OUTPUT) return { error: "The photo is too large." };
    return { contentType: "image/png", bytes: encoded };
  }
  return { error: "Use a JPEG or PNG photo." };
}
