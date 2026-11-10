import { json } from "../lib/lib.mjs";
import { forbidden, originBlocked } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import {
  addFile, addInternalNote, addPublicReply, assignTicket, closeTicket, createTicket, listAudit, listSiteChoices, listTickets, readFile, readSettings, readTicket, saveSettings, setStatus, summary, ticketAccess,
} from "../lib/tickets.mjs";

const PRIVATE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export default async (req) => {
  if (originBlocked(req)) return forbidden();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const actor = await actorFromRequest(req);
  if (path === "/api/tickets/access" && req.method === "GET") {
    const access = await ticketAccess(actor);
    const settings = access.role === "admin" ? await readSettings() : null;
    return json(200, { role: access.role, queues: access.queues, settings }, PRIVATE);
  }
  if (!actor) return json(401, { error: "Unauthorized" }, PRIVATE);
  if (path === "/api/tickets/settings" && req.method === "GET") {
    const access = await ticketAccess(actor);
    if (access.role !== "admin") return json(403, { error: "Ticket settings are limited to the ticket admin." }, PRIVATE);
    return json(200, await readSettings(), PRIVATE);
  }
  if (path === "/api/tickets/settings" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const result = await saveSettings(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/tickets/sites" && req.method === "GET") {
    const access = await ticketAccess(actor);
    if (access.role === "none") return json(403, { error: "Ticket staff access is not granted." }, PRIVATE);
    return json(200, { sites: await listSiteChoices() }, PRIVATE);
  }
  if (path === "/api/tickets/summary" && req.method === "GET") {
    const result = await summary(actor, url.searchParams);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/tickets/audit" && req.method === "GET") {
    const result = await listAudit(actor);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/tickets" && req.method === "GET") {
    const result = await listTickets(actor, url.searchParams);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (path === "/api/tickets" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await createTicket(actor, body);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  const file = path.match(/^\/api\/tickets\/(t[a-f0-9]{16})\/files\/(f[a-f0-9]{16})$/);
  if (file && req.method === "GET") {
    const result = await readFile(actor, file[1], file[2]);
    if (result.status !== 200) return json(result.status, { error: result.error }, PRIVATE);
    return new Response(result.body, { status: 200, headers: { "content-type": result.contentType, "content-disposition": "attachment", ...PRIVATE } });
  }
  const one = path.match(/^\/api\/tickets\/(t[a-f0-9]{16})(?:\/([a-z]+))?$/);
  if (!one) return json(404, { error: "Not found" }, PRIVATE);
  if (!one[2] && req.method === "GET") {
    const result = await readTicket(actor, one[1]);
    return json(result.status, result.body || { error: result.error }, PRIVATE);
  }
  if (req.method !== "POST") return json(405, { error: "Not found" }, PRIVATE);
  const body = await req.json().catch(() => ({}));
  const action = one[2];
  const result = action === "status" ? await setStatus(actor, one[1], body)
    : action === "assign" ? await assignTicket(actor, one[1], body)
    : action === "note" ? await addInternalNote(actor, one[1], body)
    : action === "reply" ? await addPublicReply(actor, one[1], body)
    : action === "file" ? await addFile(actor, one[1], body)
    : action === "close" ? await closeTicket(actor, one[1], body)
    : { status: 404, error: "Not found" };
  return json(result.status, result.body || { error: result.error }, PRIVATE);
};

export const config = { path: ["/api/tickets", "/api/tickets/*"] };
