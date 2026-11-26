/** Site-wide admin side menu: hide or reorder tools without deleting them or their data. */
import { settingsStore } from "./lib.mjs";

export const MENU_KEY = "admin-side-menu";
export const PINNED_TOOL = "settings";

/** Default order matches the sidebar in public/admin/index.html and TOOL_ICONS. */
export const DEFAULT_MENU_TOOLS = [
  "home",
  "links",
  "qrcodes",
  "pages",
  "analytics",
  "competitions",
  "pos",
  "assets",
  "warehouse",
  "visitors",
  "tickets",
  "users",
  "sites",
  "domains",
  "settings",
];

/** Labels as they appear on the sidebar (not the request-access titles). */
export const MENU_LABELS = {
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

const KNOWN = new Set(DEFAULT_MENU_TOOLS);

function uniqueKnown(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || "").trim();
    if (!KNOWN.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Merge a stored order with the current tool list.
 * Unknown ids are dropped. Tools added later are appended, visible, at the end.
 */
export function mergeMenuOrder(storedOrder) {
  const order = uniqueKnown(storedOrder);
  if (!order.length) return DEFAULT_MENU_TOOLS.slice();
  const present = new Set(order);
  const result = order.slice();
  for (const id of DEFAULT_MENU_TOOLS) {
    if (!present.has(id)) result.push(id);
  }
  return result;
}

/** Resolve stored fields. Settings can never be hidden. New tools appear and are shown. */
export function resolveMenu(raw) {
  const order = mergeMenuOrder(raw?.order);
  const hidden = uniqueKnown(raw?.hidden).filter((id) => id !== PINNED_TOOL);
  return { order, hidden };
}

export function publicMenu(resolved, canEdit) {
  return {
    order: resolved.order,
    hidden: resolved.hidden,
    tools: resolved.order.map((id) => ({
      id,
      label: MENU_LABELS[id] || id,
      hidden: resolved.hidden.includes(id),
      pinned: id === PINNED_TOOL,
    })),
    canEdit: !!canEdit,
  };
}

export async function loadMenu() {
  const raw = await settingsStore().get(MENU_KEY, { type: "json" }).catch(() => null);
  return resolveMenu(raw);
}

export async function saveMenu(body) {
  const next = body?.reset === true ? resolveMenu(null) : resolveMenu({ order: body?.order, hidden: body?.hidden });
  await settingsStore().setJSON(MENU_KEY, { ...next, updatedAt: new Date().toISOString() });
  return { status: 200, body: next };
}

export function canEditMenu(actor) {
  return !!(actor && (actor.role === "head" || actor.owner));
}
