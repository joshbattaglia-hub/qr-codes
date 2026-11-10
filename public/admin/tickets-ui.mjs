import { prepareTicketFile } from "./ticket-file.mjs";

const STATUS_LABEL = {
  new: "New",
  "in-progress": "In progress",
  awaiting: "Awaiting info",
  scheduled: "Scheduled",
  done: "Done",
  closed: "Closed",
};
const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const QUEUE_LABEL = { screens: "Screens", signage: "Signage" };

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");

function options(map, selected, includeAny) {
  const rows = includeAny ? '<option value="">Any</option>' : "";
  return rows + Object.entries(map).map(([value, label]) =>
    '<option value="' + esc(value) + '"' + (value === selected ? " selected" : "") + ">" + esc(label) + "</option>"
  ).join("");
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json().catch(() => ({})) : null;
  if (!response.ok) throw new Error(body?.error || "Request failed");
  return body;
}

export function ticketShell() {
  return '<div id="ticket-page" data-testid="ticket-page"><div class="page-head"><div><p class="asset-kicker">Helpdesk</p><h1>Support tickets</h1><p class="muted">Screens and signage. This is separate from the visitor log and POS.</p></div></div><div id="ticket-body" class="card">Loading…</div></div>';
}

function denied() {
  return '<h2>Support tickets are restricted</h2><p data-testid="ticket-denied">Ticket staff access is not granted for this session. Sign in with a verified email code listed as ticket staff. The shared Head office password and POS roles are not ticket staff access.</p>';
}

function queueTabs(queue, queues) {
  const available = queues && queues.length ? queues : ["screens", "signage"];
  return '<div class="tabs">' + available.map((id) =>
    '<button type="button" data-act="ticket-queue" data-queue="' + esc(id) + '" class="' + (queue === id ? "on" : "") + '">' + esc(QUEUE_LABEL[id] || id) + "</button>"
  ).join("") + "</div>";
}

function note(id) {
  return '<p id="' + id + '" class="small" data-testid="ticket-note-msg"></p>';
}

function setNote(text) {
  const el = document.getElementById("ticket-note-msg");
  if (el) el.textContent = text || "";
}

export async function paintTickets(id, state) {
  const box = document.getElementById("ticket-body");
  if (!box) return;
  const response = await fetch("/api/tickets/access", { credentials: "same-origin" });
  const access = await response.json().catch(() => ({ role: "none" }));
  if (!response.ok || !access || access.role === "none") {
    box.innerHTML = denied();
    return;
  }
  state.ticketAccess = access;
  if (id === "settings") return paintSettings(box, access);
  if (id === "audit") return paintAudit(box, access);
  if (id === "new") return paintSubmit(box, access, state);
  if (id) return paintTicket(box, id, access, state);
  return paintList(box, access, state);
}

async function paintList(box, access, state) {
  const queue = access.queues.includes(state.ticketQueue) ? state.ticketQueue : (access.queues[0] || "screens");
  state.ticketQueue = queue;
  const params = new URLSearchParams({ queue });
  const status = state.ticketStatus || "";
  const priority = state.ticketPriority || "";
  const q = state.ticketQuery || "";
  const from = state.ticketUpdatedFrom || "";
  const to = state.ticketUpdatedTo || "";
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  if (q) params.set("q", q);
  if (from) params.set("updatedFrom", from);
  if (to) params.set("updatedTo", to);
  const [summary, listed] = await Promise.all([
    api("/api/tickets/summary?" + params.toString()),
    api("/api/tickets?" + params.toString()),
  ]);
  const rows = (listed.tickets || []).map((ticket) =>
    '<tr data-testid="ticket-row"><td><button class="text-btn" type="button" data-go="tickets/' + esc(ticket.id) + '">' + esc(ticket.number) + "</button></td>"
    + "<td>" + esc(ticket.subject) + "</td><td>" + esc(ticket.siteLabel) + "</td>"
    + "<td>" + esc(PRIORITY_LABEL[ticket.priority] || ticket.priority) + "</td>"
    + "<td>" + esc(ticket.statusLabel) + (ticket.overdue ? ' <span class="badge" data-testid="ticket-overdue">Overdue</span>' : "") + "</td>"
    + "<td>" + esc((ticket.updatedAt || "").slice(0, 10)) + "</td></tr>"
  ).join("");
  box.innerHTML = queueTabs(queue, access.queues)
    + '<div class="metrics ticket-metrics" data-testid="ticket-counts">'
    + '<div><div class="metric-label">Open</div><div class="metric-value">' + summary.open + "</div></div>"
    + '<div><div class="metric-label">Awaiting response</div><div class="metric-value">' + summary.awaiting + "</div></div>"
    + '<div><div class="metric-label">Closed 30 days</div><div class="metric-value">' + summary.closed30 + "</div></div>"
    + '<div><div class="metric-label">Closed 60 / 90</div><div class="metric-value">' + summary.closed60 + " / " + summary.closed90 + "</div></div>"
    + (summary.overdue ? '<div><div class="metric-label">Overdue</div><div class="metric-value">' + summary.overdue + "</div></div>" : "")
    + "</div>"
    + '<div class="asset-dims">'
    + '<label class="field"><span>Search</span><input id="ticket-q" value="' + esc(q) + '" placeholder="Number, subject, site, requester"></label>'
    + '<label class="field"><span>Status</span><select id="ticket-status">' + options(STATUS_LABEL, status, true) + "</select></label>"
    + '<label class="field"><span>Priority</span><select id="ticket-priority">' + options(PRIORITY_LABEL, priority, true) + "</select></label>"
    + '<label class="field"><span>Updated from</span><input id="ticket-updated-from" type="date" value="' + esc(from) + '"></label>'
    + '<label class="field"><span>Updated to</span><input id="ticket-updated-to" type="date" value="' + esc(to) + '"></label>'
    + "</div>"
    + '<div class="asset-actions">'
    + '<button class="btn ghost" type="button" data-act="ticket-filter">Apply filters</button>'
    + '<button class="btn" type="button" data-go="tickets/new">Submit ticket</button>'
    + (access.role === "admin" ? '<button class="btn ghost" type="button" data-go="tickets/settings">Settings</button><button class="btn ghost" type="button" data-go="tickets/audit">Audit log</button>' : "")
    + "</div>"
    + '<div class="table-wrap"><table><thead><tr><th>Number</th><th>Subject</th><th>Site</th><th>Priority</th><th>Status</th><th>Updated</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="6">No tickets.</td></tr>') + "</tbody></table></div>";
}

async function loadSites(state) {
  if (state.ticketSites) return state.ticketSites;
  const body = await api("/api/tickets/sites");
  state.ticketSites = body.sites || [];
  return state.ticketSites;
}

function siteOptions(sites, selected) {
  return '<option value="">Choose a site</option>'
    + sites.map((site) => '<option value="' + esc(site.id) + '"' + (site.id === selected ? " selected" : "") + ">" + esc(site.name) + (site.area ? " · " + esc(site.area) : "") + "</option>").join("")
    + '<option value="other"' + (selected === "other" ? " selected" : "") + ">Other</option>";
}

async function paintSubmit(box, access, state) {
  const sites = await loadSites(state);
  const queue = access.queues.includes(state.ticketQueue) ? state.ticketQueue : access.queues[0];
  const typeOptions = access.types?.[queue] || state.ticketTypes?.[queue] || [];
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="tickets">Back</button></p>'
    + '<h2>Submit ticket</h2>'
    + queueTabs(queue, access.queues)
    + '<label class="field"><span>Queue</span><select id="ticket-new-queue">' + access.queues.map((id) => '<option value="' + esc(id) + '"' + (id === queue ? " selected" : "") + ">" + esc(QUEUE_LABEL[id] || id) + "</option>").join("") + "</select></label>"
    + '<label class="field"><span>Site</span><select id="ticket-new-site">' + siteOptions(sites, "") + "</select></label>"
    + '<label class="field"><span>Other site</span><input id="ticket-new-site-other" placeholder="Describe the site if you chose Other"></label>'
    + '<label class="field"><span>Request type</span><select id="ticket-new-type">' + typeOptions.map((row) => "<option>" + esc(row) + "</option>").join("") + "</select></label>"
    + '<label class="field"><span>Priority</span><select id="ticket-new-priority">' + options(PRIORITY_LABEL, "normal") + "</select></label>"
    + '<label class="field"><span>Needed by</span><input id="ticket-new-needed" type="date"></label>'
    + '<label class="field"><span>Subject</span><input id="ticket-new-subject" maxlength="140"></label>'
    + '<label class="field"><span>Description</span><textarea id="ticket-new-description" rows="5"></textarea></label>'
    + '<label class="field"><span>Requester email</span><input id="ticket-new-requester" type="email"></label>'
    + '<label class="field"><span>Attachments (images or PDFs)</span><input id="ticket-new-files" type="file" accept="image/*,application/pdf" multiple></label>'
    + '<button class="btn" type="button" data-act="ticket-create">Create ticket</button>'
    + note("ticket-note-msg");
}

async function paintTicket(box, id, access, state) {
  const body = await api("/api/tickets/" + encodeURIComponent(id));
  const ticket = body.ticket;
  const history = (ticket.statusHistory || []).map((row) =>
    "<li>" + esc((row.at || "").slice(0, 16).replace("T", " ")) + " · " + esc(STATUS_LABEL[row.to || row.status] || row.to || row.status) + (row.actor ? " · " + esc(row.actor) : "") + "</li>"
  ).join("");
  const notes = (ticket.messages || []).map((row) =>
    '<div class="field-card"><p><strong>' + esc(row.kind === "internal" ? "Internal note" : "Public reply") + "</strong> · " + esc(row.actor) + " · " + esc((row.at || "").slice(0, 16).replace("T", " ")) + "</p><p>" + esc(row.text) + "</p></div>"
  ).join("");
  const files = (ticket.files || []).map((file) =>
    '<li><button class="text-btn" type="button" data-act="ticket-download" data-id="' + esc(ticket.id) + '" data-file="' + esc(file.id) + '">' + esc(file.name) + "</button></li>"
  ).join("");
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="tickets">Back</button></p>'
    + '<div data-testid="ticket-record"><h2>' + esc(ticket.number) + " · " + esc(ticket.subject) + "</h2>"
    + "<p>" + esc(QUEUE_LABEL[ticket.queue] || ticket.queue) + " · " + esc(ticket.siteLabel) + " · " + esc(ticket.requestType)
    + " · " + esc(PRIORITY_LABEL[ticket.priority] || ticket.priority) + " · " + esc(ticket.statusLabel)
    + (ticket.overdue ? ' <span class="badge" data-testid="ticket-overdue">Overdue</span>' : "") + "</p>"
    + "<p>Requester " + esc(ticket.requesterEmail) + (ticket.assignee ? " · Assignee " + esc(ticket.assignee) : "")
    + (ticket.neededBy ? " · Needed by " + esc(ticket.neededBy) : "") + "</p>"
    + "<p>" + esc(ticket.description) + "</p>"
    + (history ? "<h3>Status history</h3><ul>" + history + "</ul>" : "")
    + (notes || "")
    + (ticket.closeOut ? "<p>Close-out: " + esc(ticket.closeOut.notes) + (ticket.closeOut.photoId ? " · photo attached" : "") + "</p>" : "")
    + (files ? "<h3>Attachments</h3><ul>" + files + "</ul>" : "")
    + '<label class="field"><span>Status</span><select id="ticket-next-status">' + options(STATUS_LABEL, ticket.status) + "</select></label>"
    + '<button class="btn" type="button" data-act="ticket-status" data-id="' + esc(ticket.id) + '">Update status</button>'
    + '<label class="field"><span>Assignee</span><input id="ticket-assignee" value="' + esc(ticket.assignee) + '" placeholder="Staff email"></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-assign" data-id="' + esc(ticket.id) + '">Assign</button>'
    + '<label class="field"><span>Internal note</span><textarea id="ticket-note"></textarea></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-note" data-id="' + esc(ticket.id) + '">Save internal note</button>'
    + '<label class="field"><span>Public reply</span><textarea id="ticket-reply"></textarea></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-reply" data-id="' + esc(ticket.id) + '">Send public reply</button>'
    + '<label class="field"><span>Add attachment</span><input id="ticket-file" type="file" accept="image/*,application/pdf"></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-file" data-id="' + esc(ticket.id) + '">Upload</button>'
    + '<label class="field"><span>Close-out notes</span><textarea id="ticket-close"></textarea></label>'
    + '<label class="field"><span>Close-out photo</span><input id="ticket-close-photo" type="file" accept="image/*"></label>'
    + '<button class="btn" type="button" data-act="ticket-close" data-id="' + esc(ticket.id) + '">Close ticket</button>'
    + note("ticket-note-msg") + "</div>";
}

function mappingLines(rows) {
  return (rows || []).map((row) => [row.email || row.domain, (row.sites || []).join(","), row.area || ""].join(" | ")).join("\n");
}

function parseMapping(lines, key) {
  return lines.map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    const value = parts[0] || "";
    const sites = (parts[1] || "").split(/[,\s]+/).map((id) => id.trim()).filter(Boolean);
    const area = parts[2] || "";
    return key === "email" ? { email: value, sites, area } : { domain: value, sites, area };
  }).filter((row) => row.email || row.domain);
}

async function paintSettings(box, access) {
  if (access.role !== "admin") {
    box.innerHTML = denied();
    return;
  }
  const settings = await api("/api/tickets/settings");
  const sites = await api("/api/tickets/sites").then((body) => body.sites || []).catch(() => []);
  const held = await api("/api/tickets/quarantine").catch(() => ({ quarantine: [] }));
  const siteRef = sites.map((site) => esc(site.id) + " — " + esc(site.name) + (site.area ? " · " + esc(site.area) : "")).join("<br>");
  const origin = (location.origin || "https://expresshelp.site").replace(/\/+$/, "");
  const postmarkUrl = origin + "/api/support/inbound/postmark?token=";
  const resendUrl = origin + "/api/support/inbound/resend?token=";
  const quarantine = (held.quarantine || []).map((row) =>
    "<tr><td>" + esc((row.at || "").slice(0, 16).replace("T", " ")) + "</td><td>" + esc(row.from) + "</td><td>" + esc(row.subject) + "</td><td>" + esc(row.reason || "") + '</td><td><button class="btn ghost" type="button" data-act="ticket-quarantine" data-decision="approve" data-id="' + esc(row.id) + '">Approve</button> <button class="btn ghost" type="button" data-act="ticket-quarantine" data-decision="discard" data-id="' + esc(row.id) + '">Discard</button></td></tr>'
  ).join("");
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="tickets">Back</button></p>'
    + "<h2>Ticket settings</h2>"
    + '<p class="muted">Staff access is a verified email-code identity listed for that queue. Shared-password and POS roles are not ticket staff. Notifications stay off until you turn a queue on and the global switch on. Inbound mail stays off until the TICKET_INBOUND_SECRET environment variable, the inbound addresses, and the inbound switch are all set.</p>'
    + '<label class="field"><span>Screens staff emails (one per line)</span><textarea id="ticket-staff-screens" rows="4">' + esc(settings.staff.screens.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Signage staff emails (one per line)</span><textarea id="ticket-staff-signage" rows="4">' + esc(settings.staff.signage.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Screens request types</span><textarea id="ticket-types-screens" rows="5">' + esc(settings.types.screens.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Signage request types</span><textarea id="ticket-types-signage" rows="5">' + esc(settings.types.signage.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Requester emails (email | site ids | area)</span><textarea id="ticket-requesters" rows="5" placeholder="name@libertyretail.com.au | s00000001 | North">' + esc(mappingLines(settings.requesters)) + "</textarea></label>"
    + '<label class="field"><span>Allowed requester domains (exact host only, no subdomains)</span><textarea id="ticket-domains" rows="4" placeholder="libertyretail.com.au | |">' + esc(mappingLines(settings.domains)) + "</textarea></label>"
    + '<p class="muted small">Domain match is exact and case-insensitive. shop.libertyretail.com.au and lookalikes are rejected. Use the site ids below for mappings.</p>'
    + (siteRef ? '<div class="field-card small" data-testid="ticket-site-ref">' + siteRef + "</div>" : "")
    + '<label class="field"><span>Visibility</span><select id="ticket-visibility"><option value="own-and-sites">Own tickets plus mapped sites or areas</option><option value="own-only">Own tickets only</option></select></label>'
    + '<label class="check"><input id="ticket-notify-global" type="checkbox"' + (settings.notifyGlobal ? " checked" : "") + "> Global notification switch (off by default)</label>"
    + '<label class="check"><input id="ticket-notify-screens" type="checkbox"' + (settings.notify.screens ? " checked" : "") + "> Screens notifications</label>"
    + '<label class="check"><input id="ticket-notify-signage" type="checkbox"' + (settings.notify.signage ? " checked" : "") + "> Signage notifications</label>"
    + '<label class="field"><span>Screens inbound email</span><input id="ticket-inbound-screens" value="' + esc(settings.inbound?.addresses?.screens || "") + '" placeholder="screens@support.example"></label>'
    + '<label class="field"><span>Signage inbound email</span><input id="ticket-inbound-signage" value="' + esc(settings.inbound?.addresses?.signage || "") + '" placeholder="signage@support.example"></label>'
    + '<label class="check"><input id="ticket-inbound-enabled" type="checkbox"' + (settings.inbound?.enabled ? " checked" : "") + "> Enable inbound email (off until the secret, addresses and this switch are set)</label>"
    + '<button class="btn" type="button" data-act="ticket-save-settings">Save ticket settings</button>'
    + '<div class="field-card" data-testid="ticket-inbound-setup"><h2>Inbound email setup</h2>'
    + '<p>Postmark is recommended. Its inbound webhook includes the message body and a stripped reply, so Express Help does not need a second provider call. Resend can receive mail, but the <code>email.received</code> webhook is metadata only and needs a follow-up API call for the body.</p>'
    + "<h3>Postmark (recommended)</h3>"
    + "<p>Add an MX record for your inbound domain or subdomain pointing to <code>inbound.postmarkapp.com</code> with priority 10. Use a subdomain if the root domain already receives mail.</p>"
    + "<p>Set the inbound webhook to <code>" + esc(postmarkUrl) + "</code> and append the <code>TICKET_INBOUND_SECRET</code> environment variable as the token, or use HTTP basic authentication with that secret as the password. This page never shows the secret.</p>"
    + '<p>Docs: <a href="https://postmarkapp.com/developer/webhooks/inbound-webhook" target="_blank" rel="noopener">Inbound webhook</a>, <a href="https://postmarkapp.com/developer/user-guide/inbound/configure-an-inbound-server" target="_blank" rel="noopener">Configure an inbound server</a>, <a href="https://postmarkapp.com/developer/user-guide/inbound/inbound-domain-forwarding" target="_blank" rel="noopener">Inbound domain forwarding</a>.</p>'
    + "<h3>Resend (optional)</h3>"
    + "<p>If you use Resend receiving, copy the MX record shown for your domain in the Resend dashboard (values vary by region). Webhook URL: <code>" + esc(resendUrl) + "</code> plus <code>TICKET_INBOUND_SECRET</code>. Optionally set <code>RESEND_WEBHOOK_SECRET</code> so the Svix signature is also checked. The receiving API uses the existing <code>RESEND_API_KEY</code>.</p>"
    + '<p>Docs: <a href="https://resend.com/docs/dashboard/receiving/" target="_blank" rel="noopener">Receiving emails</a>, <a href="https://resend.com/docs/webhooks/emails/received" target="_blank" rel="noopener">email.received</a>, <a href="https://resend.com/docs/webhooks/verify-webhooks-requests" target="_blank" rel="noopener">Verify webhooks</a>, <a href="https://resend.com/docs/dashboard/receiving/custom-domains" target="_blank" rel="noopener">Custom receiving domains</a>.</p>'
    + "<p class=\"muted small\">Inbound mail is not accepted until the secret, at least one queue address, and the inbound switch are set. There are no auto-replies. Failed authentication or an unknown sender is held for review.</p></div>"
    + "<h2>Quarantine</h2>"
    + '<div class="table-wrap"><table><thead><tr><th>When</th><th>From</th><th>Subject</th><th>Reason</th><th></th></tr></thead><tbody>'
    + (quarantine || '<tr><td colspan="5">No held mail.</td></tr>') + "</tbody></table></div>"
    + note("ticket-note-msg");
  const visibility = document.getElementById("ticket-visibility");
  if (visibility) visibility.value = settings.visibility;
}

async function paintAudit(box, access) {
  if (access.role !== "admin") {
    box.innerHTML = denied();
    return;
  }
  const body = await api("/api/tickets/audit");
  const rows = (body.audit || []).map((row) =>
    "<tr><td>" + esc((row.at || "").slice(0, 19).replace("T", " ")) + "</td><td>" + esc(row.actor) + "</td><td>" + esc(row.action) + "</td><td>" + esc(row.ticketId) + "</td><td>" + esc(row.detail) + "</td></tr>"
  ).join("");
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="tickets">Back</button></p>'
    + '<h2>Ticket audit log</h2>'
    + '<div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Ticket</th><th>Detail</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="5">No audit rows yet.</td></tr>') + "</tbody></table></div>";
}

function lines(id) {
  return (document.getElementById(id)?.value || "").split(/\n/).map((row) => row.trim()).filter(Boolean);
}

async function filesFromInput(id, opts) {
  const input = document.getElementById(id);
  const chosen = input?.files ? Array.from(input.files) : [];
  const out = [];
  for (const file of chosen) out.push(await prepareTicketFile(file, opts));
  return out;
}

async function downloadFile(ticketId, fileId) {
  const response = await fetch("/api/tickets/" + encodeURIComponent(ticketId) + "/files/" + encodeURIComponent(fileId), { credentials: "same-origin" });
  if (!response.ok) throw new Error("That file is not available.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const name = (response.headers.get("content-disposition") || "").match(/filename="?([^"]+)"?/)?.[1] || "attachment";
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function ticketAction(button, state, go) {
  const act = button.dataset.act;
  if (act === "ticket-queue") {
    state.ticketQueue = button.dataset.queue === "signage" ? "signage" : "screens";
    if (location.hash.includes("/new")) go("tickets/new");
    else go("tickets");
    return;
  }
  if (act === "ticket-filter") {
    state.ticketQuery = document.getElementById("ticket-q")?.value || "";
    state.ticketStatus = document.getElementById("ticket-status")?.value || "";
    state.ticketPriority = document.getElementById("ticket-priority")?.value || "";
    state.ticketUpdatedFrom = document.getElementById("ticket-updated-from")?.value || "";
    state.ticketUpdatedTo = document.getElementById("ticket-updated-to")?.value || "";
    go("tickets");
    return;
  }
  if (act === "ticket-download") {
    await downloadFile(button.dataset.id, button.dataset.file);
    return;
  }
  const id = button.dataset.id;
  if (act === "ticket-create") {
    const queue = document.getElementById("ticket-new-queue")?.value;
    const created = await api("/api/tickets", { method: "POST", body: JSON.stringify({
      queue,
      siteId: document.getElementById("ticket-new-site")?.value,
      siteOther: document.getElementById("ticket-new-site-other")?.value,
      requestType: document.getElementById("ticket-new-type")?.value,
      priority: document.getElementById("ticket-new-priority")?.value,
      neededBy: document.getElementById("ticket-new-needed")?.value,
      subject: document.getElementById("ticket-new-subject")?.value,
      description: document.getElementById("ticket-new-description")?.value,
      requesterEmail: document.getElementById("ticket-new-requester")?.value,
    }) });
    const ticketId = created.ticket?.id;
    try {
      const uploads = await filesFromInput("ticket-new-files");
      for (const file of uploads) {
        await api("/api/tickets/" + ticketId + "/file", { method: "POST", body: JSON.stringify(file) });
      }
    } catch (err) {
      setNote(err.message || "The ticket was created, but a file was not accepted.");
    }
    go("tickets/" + ticketId);
    return;
  }
  if (act === "ticket-status") await api("/api/tickets/" + id + "/status", { method: "POST", body: JSON.stringify({ status: document.getElementById("ticket-next-status").value }) });
  if (act === "ticket-assign") await api("/api/tickets/" + id + "/assign", { method: "POST", body: JSON.stringify({ assignee: document.getElementById("ticket-assignee").value }) });
  if (act === "ticket-note") await api("/api/tickets/" + id + "/note", { method: "POST", body: JSON.stringify({ text: document.getElementById("ticket-note").value }) });
  if (act === "ticket-reply") await api("/api/tickets/" + id + "/reply", { method: "POST", body: JSON.stringify({ text: document.getElementById("ticket-reply").value }) });
  if (act === "ticket-file") {
    const uploads = await filesFromInput("ticket-file");
    if (!uploads.length) throw new Error("Choose a file.");
    await api("/api/tickets/" + id + "/file", { method: "POST", body: JSON.stringify(uploads[0]) });
  }
  if (act === "ticket-quarantine") {
    await api("/api/tickets/quarantine/" + button.dataset.id + "/" + (button.dataset.decision === "approve" ? "approve" : "discard"), { method: "POST", body: JSON.stringify({}) });
    go("tickets/settings");
    return;
  }
  if (act === "ticket-close") {
    const photo = (await filesFromInput("ticket-close-photo", { photoOnly: true }))[0];
    await api("/api/tickets/" + id + "/close", { method: "POST", body: JSON.stringify({ notes: document.getElementById("ticket-close").value, photo: photo?.data || "" }) });
  }
  if (act === "ticket-save-settings") {
    const current = state.ticketAccess?.settings || await api("/api/tickets/settings");
    await api("/api/tickets/settings", { method: "PUT", body: JSON.stringify({
      ...current,
      staff: { screens: lines("ticket-staff-screens"), signage: lines("ticket-staff-signage") },
      types: { screens: lines("ticket-types-screens"), signage: lines("ticket-types-signage") },
      requesters: parseMapping(lines("ticket-requesters"), "email"),
      domains: parseMapping(lines("ticket-domains"), "domain"),
      visibility: document.getElementById("ticket-visibility").value,
      notify: { screens: document.getElementById("ticket-notify-screens").checked, signage: document.getElementById("ticket-notify-signage").checked },
      notifyGlobal: document.getElementById("ticket-notify-global").checked,
      inbound: {
        enabled: document.getElementById("ticket-inbound-enabled").checked,
        addresses: {
          screens: document.getElementById("ticket-inbound-screens").value,
          signage: document.getElementById("ticket-inbound-signage").value,
        },
      },
    }) });
    setNote("Settings saved.");
  }
  if (id) go("tickets/" + id);
  else if (act === "ticket-save-settings") go("tickets/settings");
}
