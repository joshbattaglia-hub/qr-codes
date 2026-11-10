import { jpegOrientation, jpegPixelSize } from "../visit/orientation.mjs";

const MAX_EDGE = 1600;
const MAX_BYTES = 1_000_000;
const PDF_MAX = 1_500_000;
const STILL_TOO_LARGE = "That file is still too large after it was reduced. Choose a smaller image or PDF.";

function looksHeic(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  return type.includes("heic") || type.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
}

async function sniff(file) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "pdf";
  const brand = String.fromCharCode.apply(null, bytes.slice(4, 12)).toLowerCase();
  if (brand.includes("ftyp") && (brand.includes("hei") || brand.includes("mif") || brand.includes("msf"))) return "heic";
  return "";
}

function drawOriented(bitmap, orientation, edge) {
  const swapped = orientation >= 5;
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const orientedW = swapped ? srcH : srcW;
  const orientedH = swapped ? srcW : srcH;
  const scale = Math.min(1, edge / Math.max(orientedW, orientedH));
  const dw = Math.max(1, Math.round(orientedW * scale));
  const dh = Math.max(1, Math.round(orientedH * scale));
  const tw = Math.max(1, Math.round(srcW * scale));
  const th = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, dw, dh);
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, tw, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, tw, th); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, th); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, th, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, th, tw); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, tw); break;
    default: break;
  }
  ctx.drawImage(bitmap, 0, 0, tw, th);
  return canvas;
}

async function blobFrom(bitmap, orientation, edge, quality) {
  const canvas = drawOriented(bitmap, orientation, edge);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("unread");
  return blob;
}

async function compress(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const raw = jpegPixelSize(bytes);
  let orientation = jpegOrientation(bytes);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "none" });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  if (raw && orientation >= 5 && bitmap.width === raw.height && bitmap.height === raw.width) orientation = 1;
  try {
    for (const edge of [MAX_EDGE, 1280, 1024]) {
      for (const quality of [0.8, 0.6, 0.5]) {
        const blob = await blobFrom(bitmap, orientation, edge, quality);
        if (blob.size <= MAX_BYTES) return new File([blob], "ticket-photo.jpg", { type: "image/jpeg" });
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw new Error(STILL_TOO_LARGE);
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

export async function prepareTicketFile(file, { photoOnly = false } = {}) {
  if (!file || !file.size) throw new Error("Choose a file.");
  const kind = await sniff(file);
  if (kind === "pdf" || (!kind && (file.type === "application/pdf" || /\.pdf$/i.test(file.name)))) {
    if (photoOnly) throw new Error("Close-out uses a JPEG or PNG photo.");
    if (file.size > PDF_MAX) throw new Error("The file is too large.");
    return { name: file.name || "file.pdf", data: await toBase64(file) };
  }
  const heic = kind === "heic" || looksHeic(file);
  try {
    const compressed = await compress(file);
    return { name: compressed.name, data: await toBase64(compressed) };
  } catch (err) {
    if (err && err.message === STILL_TOO_LARGE) throw err;
    if (heic) throw new Error("This photo is HEIC and this browser could not convert it. Take a new photo, or set the phone camera to Most Compatible and choose a JPEG.");
    throw new Error("Images and PDFs only.");
  }
}
