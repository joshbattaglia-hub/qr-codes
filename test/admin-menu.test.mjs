import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** Site-wide admin side menu. In-memory store, mail mocked, no live writes. */
const H = await import("./support/browser-harness.mjs");
const menu = await import("../netlify/lib/admin-menu.mjs");
const icons = await import("../public/admin/tool-icons.mjs");
const owner = await H.otpCookie(H.JOSHUA);
const j = async (p) => { const r = await p; const t = r.headers.get("content-type") || ""; return { status: r.status, headers: r.headers, body: t.includes("json") ? await r.json() : await r.text() }; };

test("default tool list matches the sidebar, icons and labels", () => {
  const html = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nav = html.split("<nav ")[1].split("</nav>")[0];
  const buttons = [...nav.matchAll(/data-go="([a-z]+)"[^>]*>[\s\S]*?<span class="nav-label">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(buttons.map((b) => b[0]), menu.DEFAULT_MENU_TOOLS);
  assert.deepEqual(Object.keys(icons.TOOL_ICONS), menu.DEFAULT_MENU_TOOLS);
  assert.deepEqual(buttons.map((b) => b[1]), menu.DEFAULT_MENU_TOOLS.map((id) => menu.MENU_LABELS[id]));
  assert.deepEqual(icons.TOOL_LABELS, menu.MENU_LABELS);
  const app = fs.readFileSync(new URL("../public/admin/app.js", import.meta.url), "utf8");
  for (const needle of ["applyAdminChrome", "applyLimitedChrome", "restoreNav", "side-menu-settings", "Settings cannot be hidden", "/api/admin-menu", "menu-reset"]) {
    assert.ok(app.includes(needle), needle);
  }
});

test("new tools appear in their default place and are visible; settings cannot be hidden", () => {
  const stored = { order: ["settings", "home", "visitors"], hidden: ["settings", "home", "unknown-tool"] };
  const resolved = menu.resolveMenu(stored);
  assert.equal(resolved.order[0], "settings");
  assert.equal(resolved.order[1], "home");
  assert.equal(resolved.order[2], "visitors");
  assert.ok(resolved.order.includes("links"));
  assert.ok(resolved.order.indexOf("links") > resolved.order.indexOf("visitors"), "tools not in the stored order are added at the end, visible");
  assert.ok(!resolved.hidden.includes("settings"), "settings stays visible");
  assert.deepEqual(resolved.hidden, ["home"]);
  assert.ok(!resolved.hidden.includes("links"), "a tool not in the stored hidden list is shown");
  assert.equal(menu.resolveMenu(null).order.length, menu.DEFAULT_MENU_TOOLS.length);
  assert.deepEqual(menu.resolveMenu({ order: [], hidden: [] }).order, menu.DEFAULT_MENU_TOOLS);
});

describe("admin menu API", { concurrency: 1 }, () => {
test("GET /api/admin-menu needs a sign-in and returns the default when nothing is saved", async () => {
  await j(H.call("POST", "/api/admin-menu", { cookie: owner, body: { reset: true } }));
  const anon = await j(H.call("GET", "/api/admin-menu"));
  assert.equal(anon.status, 401);
  const got = await j(H.call("GET", "/api/admin-menu", { cookie: owner }));
  assert.equal(got.status, 200);
  assert.match(got.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(got.body.order, menu.DEFAULT_MENU_TOOLS);
  assert.deepEqual(got.body.hidden, []);
  assert.equal(got.body.canEdit, true);
  assert.equal(got.body.tools.at(-1).id, "settings");
  assert.equal(got.body.tools.at(-1).pinned, true);
  assert.equal(got.body.tools.every((t) => t.hidden === false), true);
});

test("owner can hide and reorder tools; settings hide is ignored; unknown ids are dropped", async () => {
  const saved = await j(H.call("POST", "/api/admin-menu", { cookie: owner, body: {
    order: ["visitors", "settings", "home", "not-a-tool", "links"],
    hidden: ["analytics", "settings", "domains", "nope"],
  } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.order[0], "visitors");
  assert.equal(saved.body.order[1], "settings");
  assert.equal(saved.body.order[2], "home");
  assert.ok(saved.body.order.includes("qrcodes"));
  assert.ok(!saved.body.order.includes("not-a-tool"));
  assert.deepEqual(saved.body.hidden, ["analytics", "domains"]);
  assert.equal(saved.body.tools.find((t) => t.id === "settings").hidden, false);
  assert.equal(saved.body.tools.find((t) => t.id === "analytics").hidden, true);

  const got = await j(H.call("GET", "/api/admin-menu", { cookie: owner }));
  assert.deepEqual(got.body.hidden, ["analytics", "domains"]);
  assert.equal(got.body.order[0], "visitors");
});

test("reset restores the default order and shows every tool", async () => {
  const reset = await j(H.call("POST", "/api/admin-menu", { cookie: owner, body: { reset: true } }));
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.order, menu.DEFAULT_MENU_TOOLS);
  assert.deepEqual(reset.body.hidden, []);
});

test("staff cannot change the menu; previews refuse writes", async () => {
  await j(H.call("POST", "/api/admin-menu", { cookie: owner, body: { reset: true } }));
  const users = await import("../netlify/lib/users.mjs");
  const added = await users.saveUser(H.OWNER, { mode: "add", email: "staff.menu@libertyretail.com.au", visitor: "view", tickets: [], assets: "none", warehouse: true });
  assert.equal(added.status, 200, added.error);
  const staff = await H.otpCookie("staff.menu@libertyretail.com.au");
  const denied = await j(H.call("POST", "/api/admin-menu", { cookie: staff, body: { hidden: ["analytics"] } }));
  assert.equal(denied.status, 403);
  const read = await j(H.call("GET", "/api/admin-menu", { cookie: staff }));
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, false);
  assert.deepEqual(read.body.hidden, []);

  const fn = (await import("../netlify/functions/admin-menu.mjs")).default;
  const previewReq = new Request("https://admin-menu-pr99--liberty-qr-353.netlify.app/api/admin-menu", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ hidden: ["analytics"] }) });
  const blocked = await fn(previewReq, { deploy: { context: "production" } });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /preview/);
  const still = await j(H.call("GET", "/api/admin-menu", { cookie: owner }));
  assert.deepEqual(still.body.hidden, [], "preview POST does not write");
});
});
