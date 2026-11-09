export function jpegPixelSize(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < view.length) {
    if (view[offset] !== 0xff) return null;
    const marker = view[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const size = (view[offset + 2] << 8) | view[offset + 3];
    if (size < 2 || offset + 2 + size > view.length) return null;
    if (marker === 0xc0 || marker === 0xc1) {
      return { height: (view[offset + 5] << 8) | view[offset + 6], width: (view[offset + 7] << 8) | view[offset + 8] };
    }
    offset += 2 + size;
  }
  return null;
}

export function jpegOrientation(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 < view.length) {
    if (view[offset] !== 0xff) return 1;
    const marker = view[offset + 1];
    if (marker === 0xda || marker === 0xd9) return 1;
    const size = (view[offset + 2] << 8) | view[offset + 3];
    if (size < 2 || offset + 2 + size > view.length) return 1;
    if (marker === 0xe1 && size >= 8 && view[offset + 4] === 0x45 && view[offset + 5] === 0x78 && view[offset + 6] === 0x69 && view[offset + 7] === 0x66) {
      return tiffOrientation(view, offset + 10) || 1;
    }
    offset += 2 + size;
  }
  return 1;
}

function tiffOrientation(view, start) {
  if (start + 8 > view.length) return 1;
  const little = view[start] === 0x49 && view[start + 1] === 0x49;
  const big = view[start] === 0x4d && view[start + 1] === 0x4d;
  if (!little && !big) return 1;
  const read16 = (pos) => little ? view[pos] | (view[pos + 1] << 8) : (view[pos] << 8) | view[pos + 1];
  const read32 = (pos) => little ? (view[pos] | (view[pos + 1] << 8) | (view[pos + 2] << 16) | (view[pos + 3] << 24)) >>> 0 : ((view[pos] << 24) | (view[pos + 1] << 16) | (view[pos + 2] << 8) | view[pos + 3]) >>> 0;
  if (read16(start + 2) !== 42) return 1;
  const ifd = start + read32(start + 4);
  if (ifd + 2 > view.length) return 1;
  const count = read16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.length) return 1;
    if (read16(entry) === 0x0112 && read16(entry + 2) === 3) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
