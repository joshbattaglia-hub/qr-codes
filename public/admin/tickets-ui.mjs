const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");

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
  return '<h2>Support tickets are restricted</h2><p data-testid="ticket-denied">Ticket staff access is not granted for this session.</p>';
}

function queueTabs(queue) {
  return '<div class="tabs"><button type="button" data-act="ticket-queue" data-queue="screens" class="' + (queue === "screens" ? "on" : "") + '">Screens</button><button type="button" data-act="ticket-queue" data-queue="signage" class="' + (queue !== "screens" ? "on" : "") + '">Signage</button></div>';
}

export async function paintTickets(id, state) {
  const box = document.getElementById("ticket-body");
  if (!box) return;
  const access = await fetch("/api/tickets/access", { credentials: "same-origin" }).then((res) => res.json()).catch(() => ({ role: "none" }));
  if (!access || access.role === "none") {
    box.innerHTML = denied();
    return;
  }
  state.ticketAccess = access;
  if (id === "settings") return paintSettings(box, access);
  if (id) return paintTicket(box, id, access);
  return paintList(box, access, state);
}

async function paintList(box, access, state) {
  const queue = state.ticketQueue || access.queues[0] || "screens";
  state.ticketQueue = queue;
  const params = new URLSearchParams({ queue });
  const status = state.ticketStatus || "";
  const priority = state.ticketPriority || "";
  const q = state.ticketQuery || "";
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  if (q) params.set("q", q);
  const [summary, listed] = await Promise.all([
    api("/api/tickets/summary?" + params.toString()),
    api("/api/tickets?" + params.toString()),
  ]);
  const rows = (listed.tickets || []).map((ticket) => '<tr data-testid="ticket-row"><td><button class="text-btn" type="button" data-go="tickets/' + esc(ticket.id) + '">' + esc(ticket.number) + "</button></td><td>" + esc(ticket.subject) + "</td><td>" + esc(ticket.priority) + "</td><td>" + esc(ticket.statusLabel) + (ticket.overdue ? ' <span data-testid="ticket-overdue">Overdue</span>' : "") + "</td><td>" + esc(ticket.updatedAt.slice(0, 10)) + "</td></tr>").join("");
  box.innerHTML = queueTabs(queue)
    + '<div class="metrics" data-testid="ticket-counts"><div><div class="metric-label">Open</div><div class="metric-value">' + summary.open + '</div></div><div><div class="metric-label">Awaiting response</div><div class="metric-value">' + summary.awaiting + '</div></div><div><div class="metric-label">Closed 30 days</div><div class="metric-value">' + summary.closed30 + '</div></div><div><div class="metric-label">Closed 60 / 90</div><div class="metric-value">' + summary.closed60 + " / " + summary.closed90 + "</div></div></div>"
    + '<div class="asset-dims"><label class="field"><span>Search</span><input id="ticket-q" value="' + esc(q) + '"></label>'
    + '<label class="field"><span>Status</span><select id="ticket-status"><option value="">Any</option><option>new</option><option>in-progress</option><option>awaiting</option><option>scheduled</option><option>done</option><option>closed</option></select></label>'
    + '<label class="field"><span>Priority</span><select id="ticket-priority"><option value="">Any</option><option>low</option><option>normal</option><option>high</option><option>urgent</option></select></label></div>'
    + '<div class="asset-actions"><button class="btn ghost" type="button" data-act="ticket-filter">Apply filters</button>' + (access.role === "admin" ? '<button class="btn ghost" type="button" data-go="tickets/settings">Settings</button>' : "") + "</div>"
    + '<div class="table-wrap"><table><thead><tr><th>Number</th><th>Subject</th><th>Priority</th><th>Status</th><th>Updated</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5">No tickets.</td></tr>') + "</tbody></table></div>";
  const statusSelect = document.getElementById("ticket-status");
  const prioritySelect = document.getElementById("ticket-priority");
  if (statusSelect) statusSelect.value = status;
  if (prioritySelect) prioritySelect.value = priority;
}

async function paintTicket(box, id, access) {
  const body = await api("/api/tickets/" + encodeURIComponent(id));
  const ticket = body.ticket;
  const notes = (ticket.messages || []).map((row) => "<p><strong>" + esc(row.kind) + "</strong> " + esc(row.text) + "</p>").join("");
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="tickets">Back</button></p>'
    + '<div data-testid="ticket-record"><h2>' + esc(ticket.number) + " · " + esc(ticket.subject) + "</h2>"
    + "<p>" + esc(ticket.siteLabel) + " · " + esc(ticket.requestType) + " · " + esc(ticket.priority) + " · " + esc(ticket.statusLabel) + (ticket.overdue ? " · Overdue" : "") + "</p>"
    + "<p>" + esc(ticket.description) + "</p>"
    + notes
    + (ticket.closeOut ? "<p>Completion: " + esc(ticket.closeOut.notes) + "</p>" : "")
    + '<label class="field"><span>Status</span><select id="ticket-next-status"><option>new</option><option>in-progress</option><option>awaiting</option><option>scheduled</option><option>done</option><option>closed</option></select></label>'
    + '<button class="btn" type="button" data-act="ticket-status" data-id="' + esc(ticket.id) + '">Update status</button>'
    + '<label class="field"><span>Assignee</span><input id="ticket-assignee" value="' + esc(ticket.assignee) + '"></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-assign" data-id="' + esc(ticket.id) + '">Assign</button>'
    + '<label class="field"><span>Internal note</span><textarea id="ticket-note"></textarea></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-note" data-id="' + esc(ticket.id) + '">Save internal note</button>'
    + '<label class="field"><span>Public reply</span><textarea id="ticket-reply"></textarea></label>'
    + '<button class="btn ghost" type="button" data-act="ticket-reply" data-id="' + esc(ticket.id) + '">Send public reply</button>'
    + '<label class="field"><span>Close-out notes</span><textarea id="ticket-close"></textarea></label>'
    + '<button class="btn" type="button" data-act="ticket-close" data-id="' + esc(ticket.id) + '">Close ticket</button>'
    + '<p id="ticket-note-msg" class="small"></p></div>';
  const select = document.getElementById("ticket-next-status");
  if (select) select.value = ticket.status;
}

async function paintSettings(box, access) {
  if (access.role !== "admin") {
    box.innerHTML = denied();
    return;
  }
  const settings = await api("/api/tickets/settings");
  const held = await api("/api/tickets/quarantine").catch(() => ({ quarantine: [] }));
  const quarantine = (held.quarantine || []).map((row) => '<p>' + esc(row.from) + ' · ' + esc(row.subject) + ' <button class="btn ghost" type="button" data-act="ticket-quarantine" data-decision="approve" data-id="' + esc(row.id) + '">Approve</button> <button class="btn ghost" type="button" data-act="ticket-quarantine" data-decision="discard" data-id="' + esc(row.id) + '">Discard</button></p>').join("");
  box.innerHTML = '<p><button class="btn ghost" type="button" data-go="tickets">Back</button></p>'
    + '<h2>Ticket settings</h2><p class="muted">Notifications are off until you turn a queue on. Shared-password and POS roles are not staff.</p>'
    + '<label class="field"><span>Screens staff emails</span><textarea id="ticket-staff-screens">' + esc(settings.staff.screens.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Signage staff emails</span><textarea id="ticket-staff-signage">' + esc(settings.staff.signage.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Screens request types</span><textarea id="ticket-types-screens">' + esc(settings.types.screens.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Signage request types</span><textarea id="ticket-types-signage">' + esc(settings.types.signage.join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Requester emails</span><textarea id="ticket-requesters" placeholder="name@example.com">' + esc(settings.requesters.map((row) => row.email).join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Allowed email domains</span><textarea id="ticket-domains">' + esc(settings.domains.map((row) => row.domain).join("\n")) + "</textarea></label>"
    + '<label class="field"><span>Visibility</span><select id="ticket-visibility"><option value="own-and-sites">Own tickets plus mapped sites</option><option value="own-only">Own tickets only</option></select></label>'
    + '<label class="check"><input id="ticket-notify-screens" type="checkbox"' + (settings.notify.screens ? " checked" : "") + "> Screens notifications</label>"
    + '<label class="check"><input id="ticket-notify-signage" type="checkbox"' + (settings.notify.signage ? " checked" : "") + "> Signage notifications</label>"
    + '<button class="btn" type="button" data-act="ticket-save-settings">Save ticket settings</button><h2>Quarantine</h2>' + (quarantine || '<p class="muted">No held mail.</p>') + '<p id="ticket-note-msg" class="small"></p>';
  const visibility = document.getElementById("ticket-visibility");
  if (visibility) visibility.value = settings.visibility;
}

function lines(id) {
  return (document.getElementById(id)?.value || "").split(/\n/).map((row) => row.trim()).filter(Boolean);
}

export async function ticketAction(button, state, go) {
  const act = button.dataset.act;
  if (act === "ticket-queue") {
    state.ticketQueue = button.dataset.queue === "signage" ? "signage" : "screens";
    go("tickets");
    return;
  }
  if (act === "ticket-filter") {
    state.ticketQuery = document.getElementById("ticket-q")?.value || "";
    state.ticketStatus = document.getElementById("ticket-status")?.value || "";
    state.ticketPriority = document.getElementById("ticket-priority")?.value || "";
    go("tickets");
    return;
  }
  const id = button.dataset.id;
  if (act === "ticket-status") await api("/api/tickets/" + id + "/status", { method: "POST", body: JSON.stringify({ status: document.getElementById("ticket-next-status").value }) });
  if (act === "ticket-assign") await api("/api/tickets/" + id + "/assign", { method: "POST", body: JSON.stringify({ assignee: document.getElementById("ticket-assignee").value }) });
  if (act === "ticket-note") await api("/api/tickets/" + id + "/note", { method: "POST", body: JSON.stringify({ text: document.getElementById("ticket-note").value }) });
  if (act === "ticket-reply") await api("/api/tickets/" + id + "/reply", { method: "POST", body: JSON.stringify({ text: document.getElementById("ticket-reply").value }) });
  if (act === "ticket-close") await api("/api/tickets/" + id + "/close", { method: "POST", body: JSON.stringify({ notes: document.getElementById("ticket-close").value }) });
  if (act === "ticket-quarantine") {
    await api("/api/tickets/quarantine/" + button.dataset.id + "/" + (button.dataset.decision === "approve" ? "approve" : "discard"), { method: "POST", body: JSON.stringify({}) });
    go("tickets/settings");
    return;
  }
  if (act === "ticket-save-settings") {
    const current = state.ticketAccess?.settings || await api("/api/tickets/settings");
    await api("/api/tickets/settings", { method: "PUT", body: JSON.stringify({
      ...current,
      staff: { screens: lines("ticket-staff-screens"), signage: lines("ticket-staff-signage") },
      types: { screens: lines("ticket-types-screens"), signage: lines("ticket-types-signage") },
      requesters: lines("ticket-requesters").map((email) => ({ email })),
      domains: lines("ticket-domains").map((domain) => ({ domain })),
      visibility: document.getElementById("ticket-visibility").value,
      notify: { screens: document.getElementById("ticket-notify-screens").checked, signage: document.getElementById("ticket-notify-signage").checked },
    }) });
  }
  if (id) go("tickets/" + id);
  else if (act === "ticket-save-settings") go("tickets/settings");
}
