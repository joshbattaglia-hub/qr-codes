/* One emoji per admin tool. Used by the sidebar (static markup in index.html, kept in step by a test), the "Other tools" list
 * (the same buttons moved there), and the request-access page. The icon is decorative (aria-hidden); the text label is the accessible name. */
export const TOOL_ICONS = {
  home: "🏠",
  links: "🔗",
  qrcodes: "📱",
  pages: "📄",
  analytics: "📊",
  competitions: "🏆",
  pos: "🧾",
  assets: "🏷️",
  warehouse: "📦",
  visitors: "🚪",
  tickets: "🎫",
  users: "👥",
  sites: "📍",
  domains: "🌐",
  settings: "⚙️",
};
export const OTHER_TOOLS_ICON = "🧰";

/** Sidebar labels, matching public/admin/index.html. */
export const TOOL_LABELS = {
  home: "Home",
  links: "Links",
  qrcodes: "QR Codes",
  pages: "Pages",
  analytics: "Analytics",
  competitions: "Competitions",
  pos: "POS setup",
  assets: "Asset Barcodes",
  warehouse: "Warehouse Stickers",
  visitors: "Visitor log",
  tickets: "Support",
  users: "Users",
  sites: "Sites",
  domains: "Custom domains",
  settings: "Settings",
};
