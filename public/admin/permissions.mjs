/**
 * Admin tool tabs and who gets them. Shared by the server (netlify/lib/users.mjs) and the Users page / nav (public/admin/app.js),
 * so the checklist, the menu and the API checks all read the same rules.
 *
 * Stored on each user (all optional; missing means the previous rule, so older records keep exactly the access they had):
 *  - approverKey / preparerClass / siteIds  POS setup and Sites tabs (a POS role is what grants them)
 *  - assets: "none" | "view" | "custom"     Asset Barcodes. Missing = custom for POS-role users, none for everyone else (the old rule)
 *  - warehouse: true                        Warehouse Stickers tab
 *  - warehouseGenerate / warehouseReprint   finer Warehouse Stickers rights. Missing = allowed (the old rule: the tab gave both)
 *  - visitor: none | view | photos | settings   Visitor Log tab (none = tab off)
 *  - Support areas live in the ticket staff lists (queues)
 * The Users tab is the owner's alone. Head-office-only tabs are not offered to email-code users.
 */
export const ASSET_LEVELS = ["none", "view", "custom"];
export const ASSET_LABELS = { none: "Off", view: "Standard labels only", custom: "Custom IDs, batches and sizes" };

export const TOOL_TABS = [
  { key: "pos", routes: ["pos", "sites"], label: "POS setup and Sites" },
  { key: "assets", routes: ["assets"], label: "Asset Barcodes" },
  { key: "warehouse", routes: ["warehouse"], label: "Warehouse Stickers" },
  { key: "visitors", routes: ["visitors"], label: "Visitor Log" },
  { key: "tickets", routes: ["tickets"], label: "Support" },
  { key: "users", routes: ["users"], label: "Users", ownerOnly: true },
];
export const HEAD_ONLY_TABS = ["Home", "Links", "QR Codes", "Pages", "Analytics", "Competitions", "Custom domains", "Settings"];

export const hasPosRole = (u) => !!(u && (u.approverKey || u.preparerClass));
export function effectiveAssets(u) {
  if (u && ASSET_LEVELS.includes(u.assets)) return u.assets;
  return hasPosRole(u) ? "custom" : "none";
}
export const warehouseGenerateOk = (u) => u?.warehouseGenerate !== false;
export const warehouseReprintOk = (u) => u?.warehouseReprint !== false;

/** Route names (menu tabs) this user can open. queues = the Support areas they work on. */
export function tabsFor(u, queues = []) {
  if (!u) return [];
  const out = [];
  if (u.owner || hasPosRole(u)) out.push("pos", "sites");
  if (u.owner || effectiveAssets(u) !== "none") out.push("assets");
  if (u.owner || u.warehouse === true) out.push("warehouse");
  if (u.owner || (u.visitor && u.visitor !== "none")) out.push("visitors");
  if (u.owner || (queues && queues.length)) out.push("tickets");
  if (u.owner) out.push("users");
  return out;
}
