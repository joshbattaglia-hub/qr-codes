(function () {
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

  async function toJpeg(file) {
    const bitmap = await createImageBitmap(file);
    const edge = Math.max(bitmap.width, bitmap.height);
    const scale = edge > 1600 ? 1600 / edge : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("unread");
    return new File([blob], "id-photo.jpg", { type: "image/jpeg" });
  }

  async function prepare(file) {
    if (!file || !file.size) throw new Error("A photo of the ID is required. Use Take photo or Choose photo.");
    const kind = await sniff(file);
    if (kind === "jpeg" || kind === "png") return file;
    const heic = kind === "heic" || looksHeic(file);
    try {
      return await toJpeg(file);
    } catch {
      if (heic) throw new Error("This photo is HEIC and this browser could not convert it. Take a new photo, or set the phone camera to Most Compatible and choose a JPEG.");
      throw new Error("That photo could not be read. Use Take photo or Choose photo again.");
    }
  }

  async function useFile(file) {
    if (error) error.textContent = "";
    try {
      const ready = await prepare(file);
      clearPreview();
      selected = ready;
      previewUrl = URL.createObjectURL(ready);
      preview.src = previewUrl;
      preview.alt = "Preview of the selected ID photo";
      preview.hidden = false;
      note.textContent = ready === file ? "Photo ready." : "Converted to JPEG for upload.";
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
})();
