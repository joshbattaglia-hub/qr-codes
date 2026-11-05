import qrcode from "qrcode-generator";

export function posterUrl(base, comp) {
  return String(base || "").replace(/\/$/, "") + "/c/" + comp.slug;
}

export function qrSvgForUrl(url) {
  const q = qrcode(0, "M");
  q.addData(url);
  q.make();
  const n = q.getModuleCount();
  const cell = 4;
  const margin = 4;
  const size = (n + margin * 2) * cell;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c)) continue;
      d += `M${(c + margin) * cell} ${(r + margin) * cell}h${cell}v${cell}h-${cell}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" data-qr-url="${escapeAttr(url)}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeText(s) {
  return escapeAttr(s);
}

export function posterHtml(comp, { base, size = "a4", url } = {}) {
  const format = size === "a3" ? "a3" : "a4";
  const target = url || posterUrl(base, comp);
  const colors = {
    background: "#f4f6fb",
    text: "#1c2434",
    accent: "#0e1b4d",
    button: "#1f4bdb",
    ...(comp.colors || {}),
  };
  const qr = qrSvgForUrl(target);
  const logo = comp.logoData ? `<img class="logo" alt="" src="${escapeAttr(comp.logoData)}">` : `<div class="mark">L</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeText(comp.name || "Poster")}</title>
<style>
  @page { size: ${format === "a3" ? "A3" : "A4"}; margin: 16mm; }
  html, body { margin: 0; background: #fff; color: ${colors.text}; font-family: "Segoe UI", system-ui, sans-serif; }
  .sheet { width: ${format === "a3" ? "297mm" : "210mm"}; min-height: ${format === "a3" ? "420mm" : "297mm"}; box-sizing: border-box; padding: 16mm; background: ${colors.background}; display: flex; flex-direction: column; }
  .mark, .logo { width: 22mm; height: 22mm; object-fit: contain; }
  .mark { display: grid; place-items: center; background: ${colors.accent}; color: #e7c98a; font-weight: 700; font-size: 14mm; border-radius: 4mm; }
  h1 { font-size: ${format === "a3" ? "28mm" : "18mm"}; line-height: 1.05; margin: 8mm 0 4mm; color: ${colors.accent}; }
  .prize { font-size: ${format === "a3" ? "14mm" : "9mm"}; font-weight: 700; color: ${colors.button}; margin: 0 0 6mm; }
  .copy { font-size: ${format === "a3" ? "8mm" : "5.5mm"}; white-space: pre-wrap; }
  .qr { width: ${format === "a3" ? "90mm" : "58mm"}; height: ${format === "a3" ? "90mm" : "58mm"}; margin-top: auto; background: #fff; padding: 4mm; }
  .url { font-size: 4mm; word-break: break-all; margin-top: 3mm; }
  @media print { .sheet { box-shadow: none; } }
</style></head><body><article class="sheet">${logo}<h1>${escapeText(comp.heading || comp.name || "")}</h1>${comp.prize ? `<p class="prize">${escapeText(comp.prize)}</p>` : ""}${comp.body ? `<p class="copy">${escapeText(comp.body)}</p>` : ""}<div class="qr">${qr}</div><p class="url">${escapeText(target)}</p></article></body></html>`;
}
