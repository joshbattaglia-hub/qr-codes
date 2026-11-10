import { json } from "../lib/lib.mjs";
import { forbidden, jsonCookies, originBlocked } from "../lib/access.mjs";
import { startSupportCode, supportFromRequest, verifySupportCode } from "../lib/support-auth.mjs";
import {
  addRequesterFile, commentRequesterTicket, createRequesterTicket, listRequesterTickets, listSiteChoices, readRequesterFile, readRequesterTicket, readSettings,
} from "../lib/tickets.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export default async (req) => {
  if (originBlocked(req) && req.method !== "GET") return forbidden();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/support/start" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await startSupportCode(req, body?.email);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/support/verify" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await verifySupportCode(req, body?.email, body?.code);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return jsonCookies(200, result.body, [result.cookie]);
  }
  const scope = await supportFromRequest(req);
  if (!scope) return json(401, { error: "Sign in to open support." }, PRIVATE);
  if (path === "/api/support/session" && req.method === "GET") {
    const settings = await readSettings();
    return json(200, { email: scope.email, sites: scope.sites, area: scope.area, visibility: settings.visibility, types: settings.types, siteChoices: await listSiteChoices() }, PRIVATE);
  }
  if (path === "/api/support/tickets" && req.method === "GET") {
    const result = await listRequesterTickets(scope);
    return json(result.status, result.body, PRIVATE);
  }
  if (path === "/api/support/tickets" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await createRequesterTicket(scope, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const file = path.match(/^\/api\/support\/tickets\/(t[a-f0-9]{16})\/files\/(f[a-f0-9]{16})$/);
  if (file && req.method === "GET") {
    const result = await readRequesterFile(scope, file[1], file[2]);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return new Response(result.body, { status: 200, headers: { "content-type": result.contentType, "content-disposition": "attachment", ...PRIVATE } });
  }
  const one = path.match(/^\/api\/support\/tickets\/(t[a-f0-9]{16})$/);
  if (one && req.method === "GET") {
    const result = await readRequesterTicket(scope, one[1]);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const comment = path.match(/^\/api\/support\/tickets\/(t[a-f0-9]{16})\/(comment|file)$/);
  if (comment && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = comment[2] === "comment" ? await commentRequesterTicket(scope, comment[1], body) : await addRequesterFile(scope, comment[1], body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  return json(404, { error: "Not found" }, PRIVATE);
};

export const config = { path: ["/api/support/start", "/api/support/verify", "/api/support/session", "/api/support/tickets", "/api/support/tickets/*"] };
