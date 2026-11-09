import { jpegOrientation, jpegPixelSize } from "./orientation.mjs";

const MAX_EDGE = 1600;
const MAX_BYTES = 1_000_000;
const STILL_TOO_LARGE = "That photo is still too large after it was reduced. Take it again from a little farther away, or choose a smaller photo.";

function bind() {
  const camera = document.getElementById("photo-camera");
  const library = document.getElementById("photo-library");
  const preview = document.getElementById("photo-preview");
  const note = document.getElementById("photo-note");
  const error = document.getElementById("in-error");
  if (!camera || !library || !preview || !note) return;

  let selected = null;
  let previewUrl = "";

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    selected = null;
    preview.hidden = true;
    preview.removeAttribute("src");
    preview.alt = "";
    note.textContent = "";
  }

  function looksHeic(file) {
    const type = String(file.type || "").toLowerCase();
    const name = String(file.name || "").toLowerCase();
    return type.includes("heic") || type.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
  }

  async function sniff(file) {
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
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
          if (blob.size <= MAX_BYTES) return new File([blob], "id-photo.jpg", { type: "image/jpeg" });
        }
      }
    } finally {
      bitmap.close?.();
    }
    throw new Error(STILL_TOO_LARGE);
  }

  async function prepare(file) {
    if (!file || !file.size) throw new Error("A photo of the ID is required. Use Take photo or Choose photo.");
    const kind = await sniff(file);
    const heic = kind === "heic" || looksHeic(file);
    try {
      return await compress(file);
    } catch (err) {
      if (err && err.message === STILL_TOO_LARGE) throw err;
      if (heic) throw new Error("This photo is HEIC and this browser could not convert it. Take a new photo, or set the phone camera to Most Compatible and choose a JPEG.");
      throw new Error("That photo could not be read. Use Take photo or Choose photo again.");
    }
  }

  async function useFile(file) {
    if (error) error.textContent = "";
    try {
      const ready = await prepare(file);
      if (!ready || ready.size > MAX_BYTES) throw new Error(STILL_TOO_LARGE);
      clearPreview();
      selected = ready;
      previewUrl = URL.createObjectURL(ready);
      preview.src = previewUrl;
      preview.alt = "Preview of the selected ID photo";
      preview.hidden = false;
      note.textContent = "Photo ready.";
    } catch (err) {
      clearPreview();
      camera.value = "";
      library.value = "";
      if (error) error.textContent = err.message || "That photo could not be read. Use Take photo or Choose photo again.";
    }
  }

  camera.addEventListener("change", () => { if (camera.files && camera.files[0]) useFile(camera.files[0]); });
  library.addEventListener("change", () => { if (library.files && library.files[0]) useFile(library.files[0]); });
  window.visitorIdPhoto = () => selected;
}

bind();
