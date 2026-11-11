import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

process.env.ADMIN_PASSWORD = "test-pass";
process.env.PUBLIC_URL = "https://expresshelp.site";
process.env.OTP_SESSION_SECRET = "otp-session-secret-must-be-32-characters";
process.env.TICKET_TRACK_KEY = "synthetic-track-key-for-tests-only-0123456789";
process.env.TICKET_MAIL = "on";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;

const JOSHUA = "jbattaglia@libertyretail.com.au";
const SIGNAGE = "signage.staff@libertyretail.com.au";
const SCREENS = "screens.staff@libertyretail.com.au";
process.env.OTP_ALLOWLIST = JSON.stringify({
  [JOSHUA]: { approverKey: "joshua", preparerClass: "joshua", siteIds: ["s00000001"] },
  [SIGNAGE]: { preparerClass: "regional-business-manager", siteIds: ["s00000001"] },
  [SCREENS]: { preparerClass: "regional-business-manager", siteIds: ["s00000001"] },
});

const lib = await import("../netlify/lib/lib.mjs");
lib.setStoreFactory(lib.memoryBackend());
const otpLib = await import("../netlify/lib/otp.mjs");
const mailLib = await import("../netlify/lib/mail.mjs");
const tickets = await import("../netlify/lib/tickets.mjs");
const publicLib = await import("../netlify/lib/support-public.mjs");
const ticketFn = (await import("../netlify/functions/tickets.mjs")).default;
const otpFn = (await import("../netlify/functions/otp.mjs")).default;
const otpMail = [];
otpLib.setOtpTestHooks({ deliver: async (message) => { otpMail.push(message); return { status: "sent", id: "local-mock" }; } });
const sent = [];
mailLib.setMailTransport(async (message) => { sent.push(message); return { status: "sent", id: "fake-mail" }; });
let fakeNow = Date.parse("2026-11-11T00:00:00.000Z");
tickets.setTicketTestHooks({ now: () => fakeNow });
publicLib.setPublicTestHooks({ now: () => fakeNow });

const ADMIN = { kind: "verified-identity", provider: "otp", email: JOSHUA };
const SIGNAGE_ACTOR = { kind: "verified-identity", provider: "otp", email: SIGNAGE };
const SCREENS_ACTOR = { kind: "verified-identity", provider: "otp", email: SCREENS };
const NOTE = "Updated on Joshua's request by Bob the Builder (bot)";

let ipSeq = 0;
function req(method, url, { cookie = "", body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  headers.set("x-nf-client-connection-ip", "2001:db8:eeee::" + (++ipSeq).toString(16));
  return new Request("https://expresshelp.site" + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
function cookieNamed(res, name) {
  const rows = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const hit = rows.find((row) => row && row.startsWith(name + "=") && !row.startsWith(name + "=;"));
  return hit ? hit.split(";")[0] : "";
}
async function read(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) return { status: res.status, body: await res.json() };
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), type };
}
async function otpCookie(email) {
  const before = otpMail.length;
  const started = await otpFn(req("POST", "/api/identity/otp/start", { body: { email } }));
  assert.equal(started.status, 200);
  const code = otpMail.slice(before).at(-1).text.match(/code is (\d{8})/)[1];
  const verified = await otpFn(req("POST", "/api/identity/otp/verify", { body: { email, code } }));
  assert.equal(verified.status, 200);
  return cookieNamed(verified, "qr_otp");
}
function pngBytes() {
  const image = new PNG({ width: 4, height: 4 });
  image.data.fill(200);
  return PNG.sync.write(image);
}
function jpegBytes() {
  return Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 255), width: 8, height: 8 }, 80).data);
}
async function auditFor(id) {
  return (await tickets.listAudit(ADMIN)).body.audit.filter((row) => row.ticketId === id);
}

await lib.sitesStore().setJSON("s00000001", { id: "s00000001", name: "Example North", operationalRegion: "North" });
await lib.sitesStore().setJSON("s00000002", { id: "s00000002", name: "Example South", operationalRegion: "South" });
// Settings saved before "Print or reprint" existed (no typesVersion), with notifications on to prove edits never send.
await lib.ticketStore().setJSON("settings", {
  staff: { screens: [JOSHUA, SCREENS], signage: [JOSHUA, SIGNAGE] },
  types: {
    screens: ["New screen install", "Content/playlist change", "Fault or repair", "Relocation or removal", "Other"],
    signage: ["New sign or install", "Replacement", "Damage or repair", "Promotional install", "Other"],
  },
  domains: [{ domain: "libertyretail.com.au", sites: ["s00000001", "national"], area: "" }],
  notify: { screens: true, signage: true }, notifyGlobal: true,
});

test("Print or reprint is added once to Signage before Other; Screens and existing ticket types are unchanged", async () => {
  const before = await tickets.createTicket(ADMIN, {
    queue: "signage", siteId: "s00000001", requestType: "Promotional install", priority: "normal",
    subject: "TEST existing", description: "TEST existing type", requesterEmail: "requester@example.com",
  });
  assert.equal(before.status, 200);
  const settings = await tickets.readSettings();
  assert.deepEqual(settings.types.signage, ["New sign or install", "Replacement", "Damage or repair", "Promotional install", "Print or reprint", "Other"]);
  assert.deepEqual(settings.types.screens, ["New screen install", "Content/playlist change", "Fault or repair", "Relocation or removal", "Other"]);
  assert.equal(settings.typesVersion, tickets.TYPES_VERSION);
  assert.ok(tickets.DEFAULT_TYPES.signage.includes("Print or reprint"));
  assert.equal(tickets.DEFAULT_TYPES.screens.includes("Print or reprint"), false);
  const raw = await lib.ticketStore().get("ticket/" + before.body.ticket.id, { type: "json" });
  assert.equal(raw.requestType, "Promotional install");
  // Custom list without "Other" gets it appended; an admin who removes it after the upgrade keeps it removed.
  assert.deepEqual(tickets.normaliseSettings({ types: { signage: ["A", "B"] } }).types.signage, ["A", "B", "Print or reprint"]);
  assert.deepEqual(tickets.normaliseSettings({ typesVersion: 2, types: { signage: ["A", "B"] } }).types.signage, ["A", "B"]);
  const saved = await tickets.saveSettings(ADMIN, { ...settings, typesVersion: undefined, types: { ...settings.types, signage: ["A", "Other"] } });
  assert.deepEqual(saved.body.types.signage, ["A", "Other"]);
  assert.deepEqual((await tickets.readSettings()).types.signage, ["A", "Other"]);
  await tickets.saveSettings(ADMIN, settings);
  assert.ok((await tickets.readSettings()).types.signage.includes("Print or reprint"));
  await lib.ticketStore().delete("ticket/" + before.body.ticket.id);
});

test("All sites / National is a ticket-only site option that grants no site access", async () => {
  const created = await tickets.createTicket(ADMIN, {
    queue: "signage", siteId: "national", requestType: "Print or reprint", priority: "normal",
    subject: "TEST national print", description: "TEST bulk print", requesterEmail: "requester@example.com",
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const ticket = created.body.ticket;
  assert.equal(ticket.siteId, "national");
  assert.equal(ticket.siteLabel, "All sites / National");
  assert.equal(ticket.siteNational, true);
  assert.equal(ticket.siteFreeText, false);
  assert.equal(ticket.requestType, "Print or reprint");
  // Not a real site: not in the sites store or site choices, and dropped from site mappings.
  assert.equal(await lib.sitesStore().get("national"), null);
  const choices = await tickets.listSiteChoices();
  assert.equal(choices.length, 2);
  assert.equal(choices.some((row) => row.id === "national"), false);
  assert.deepEqual(tickets.nationalSiteChoice(), { id: "national", name: "All sites / National", area: "", national: true });
  const settings = await tickets.readSettings();
  assert.deepEqual(settings.domains[0].sites, ["s00000001"]);
  assert.deepEqual(tickets.requesterScope(settings, "someone@libertyretail.com.au").sites, ["s00000001"]);
  // Filters and board.
  const byNational = await tickets.listTickets(ADMIN, new URLSearchParams({ queue: "all", site: "national" }));
  assert.deepEqual(byNational.body.tickets.map((row) => row.id), [ticket.id]);
  const board = await tickets.listTickets(ADMIN, new URLSearchParams({ queue: "signage", column: "submitted" }));
  const card = board.body.tickets.find((row) => row.id === ticket.id);
  assert.equal(card.siteLabel, "All sites / National");
  assert.notEqual(card.siteLabel, "Other site");
  assert.equal(card.siteFreeText, false);
  // Free-text "Other" still works and stays distinct.
  const other = await tickets.siteChoiceFor("other", "Somewhere");
  assert.deepEqual(other, { siteId: "other", siteLabel: "Somewhere", area: "" });
  assert.equal((await tickets.siteChoiceFor("nationalx", "")).error, "Choose a site.");
});

test("requester form accepts All sites / National and shows it on their own board", async () => {
  const scope = { email: "ada.requester@libertyretail.com.au" };
  const form = await publicLib.requesterForm(scope);
  assert.equal(form.status, 200);
  assert.equal(form.body.sites.some((row) => row.id === "national"), false, "real site list only; the page adds the option");
  fakeNow += publicLib.MIN_FILL_MS + 1000;
  const raw = JSON.stringify({
    formToken: form.body.formToken, name: "Ada Requester", phone: "0400 000 000", queue: "signage",
    siteId: "national", requestType: "Print or reprint", priority: "normal",
    subject: "TEST requester national", description: "TEST national request", files: [],
  });
  const submitted = await publicLib.submitRequesterTicket(req("POST", "/api/support/submit", { body: {} }), raw, scope);
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  const own = await publicLib.listOwnTickets(scope);
  const row = own.body.tickets.find((item) => item.subject === "TEST requester national");
  assert.equal(row.site, "All sites / National");
});

test("staff edit changes site and type through the normal path, audits each change with the note, and sends no mail", async () => {
  const created = await tickets.createTicket(ADMIN, {
    queue: "signage", siteId: "other", siteOther: "All sites (national)", requestType: "Promotional install", priority: "normal",
    subject: "TEST edit me", description: "TEST edit", requesterEmail: "requester@example.com",
  });
  const id = created.body.ticket.id;
  const sentBefore = sent.length;
  const anonymous = await read(await ticketFn(req("POST", "/api/tickets/" + id + "/edit", { body: { siteId: "national" } })));
  assert.equal(anonymous.status, 401);
  const joshua = await otpCookie(JOSHUA);
  const otpSends = otpMail.length;
  const edited = await read(await ticketFn(req("POST", "/api/tickets/" + id + "/edit", { cookie: joshua, body: { siteId: "national", requestType: "Print or reprint", note: NOTE } })));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.ticket.siteId, "national");
  assert.equal(edited.body.ticket.siteLabel, "All sites / National");
  assert.equal(edited.body.ticket.siteFreeText, false);
  assert.equal(edited.body.ticket.requestType, "Print or reprint");
  assert.equal(edited.body.ticket.status, "new");
  assert.equal(sent.length, sentBefore, "edits never notify");
  assert.equal(otpMail.length, otpSends);
  const rows = await auditFor(id);
  const site = rows.find((row) => row.action === "edit-site");
  const type = rows.find((row) => row.action === "edit-type");
  assert.equal(site.actor, JOSHUA);
  assert.equal(site.detail, "All sites (national) -> All sites / National · " + NOTE);
  assert.equal(type.actor, JOSHUA);
  assert.equal(type.detail, "Promotional install -> Print or reprint · " + NOTE);
  const raw = await lib.ticketStore().get("ticket/" + id, { type: "json" });
  assert.equal(raw.editHistory.length, 2);
  assert.deepEqual(raw.editHistory.map((row) => [row.field, row.from, row.to, row.actor, row.note]), [
    ["site", "All sites (national)", "All sites / National", JOSHUA, NOTE],
    ["requestType", "Promotional install", "Print or reprint", JOSHUA, NOTE],
  ]);
  assert.equal(raw.siteFreeText, false);
  // Unchanged fields are not audited; repeat edit is rejected.
  const again = await tickets.editTicket(ADMIN, id, { siteId: "national", requestType: "Print or reprint" });
  assert.equal(again.status, 400);
  assert.equal(again.error, "Nothing changed.");
  const typeOnly = await tickets.editTicket(ADMIN, id, { requestType: "Replacement" });
  assert.equal(typeOnly.status, 200);
  assert.equal((await auditFor(id)).filter((row) => row.action === "edit-site").length, 1);
  assert.equal((await auditFor(id)).find((row) => row.action === "edit-type" && row.detail === "Print or reprint -> Replacement").actor, JOSHUA);
  // Validation and access.
  assert.equal((await tickets.editTicket(ADMIN, id, { requestType: "Content/playlist change" })).error, "Choose a request type.");
  assert.equal((await tickets.editTicket(ADMIN, id, { siteId: "s99999999" })).error, "Choose a site.");
  assert.equal((await tickets.editTicket(ADMIN, id, {})).status, 400);
  assert.equal((await tickets.editTicket(SCREENS_ACTOR, id, { siteId: "s00000002" })).status, 404);
  const signageStaff = await tickets.editTicket(SIGNAGE_ACTOR, id, { siteId: "s00000002" });
  assert.equal(signageStaff.status, 200);
  assert.equal(signageStaff.body.ticket.siteLabel, "Example South");
  assert.equal((await tickets.editTicket({ kind: "shared-password" }, id, { siteId: "national" })).status, 403);
  assert.equal(sent.length, sentBefore);
});

test("stored filenames match the stored content type", async () => {
  const png = await tickets.acceptTicketFile(pngBytes(), "reference.png");
  assert.equal(png.contentType, "image/png");
  assert.equal(png.name, "reference.png");
  const pngNamedJpg = await tickets.acceptTicketFile(pngBytes(), "photo.jpg");
  assert.equal(pngNamedJpg.name, "photo.png");
  const jpg = await tickets.acceptTicketFile(jpegBytes(), "camera.JPEG");
  assert.equal(jpg.contentType, "image/jpeg");
  assert.equal(jpg.name, "camera.jpg");
  const noName = await tickets.acceptTicketFile(pngBytes(), "");
  assert.equal(noName.name, "image.png");
  const pdf = await tickets.acceptTicketFile(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"), "quote");
  assert.equal(pdf.name, "quote.pdf");
  assert.equal(tickets.fileNameFor("a/b\\c.tar.gz", "image/png"), "a b c.tar.png");

  const created = await tickets.createTicket(ADMIN, {
    queue: "signage", siteId: "s00000001", requestType: "Replacement", priority: "normal",
    subject: "TEST upload", description: "TEST upload", requesterEmail: "requester@example.com",
  });
  const id = created.body.ticket.id;
  const uploaded = await tickets.addFile(ADMIN, id, { name: "design.png", data: pngBytes().toString("base64") });
  assert.deepEqual(uploaded.body.ticket.files.map((row) => [row.name, row.contentType]), [["design.png", "image/png"]]);
  const file = await tickets.readFile(ADMIN, id, uploaded.body.ticket.files[0].id);
  assert.equal(file.name, "design.png");
  assert.equal(file.contentType, "image/png");
});

test("correctFileNames fixes legacy .jpg names on PNGs (metadata only, audited, admin only)", async () => {
  const created = await tickets.createTicket(ADMIN, {
    queue: "signage", siteId: "s00000001", requestType: "Replacement", priority: "normal",
    subject: "TEST legacy names", description: "TEST legacy", requesterEmail: "requester@example.com",
  });
  const id = created.body.ticket.id;
  const bytes = pngBytes().toString("base64");
  const jpgBytes = jpegBytes().toString("base64");
  const legacy = [
    { id: "f00000000000000a1", name: "legacy-sign.jpg", contentType: "image/png" },
    { id: "f00000000000000a2", name: "camera.jpg", contentType: "image/jpeg" },
  ];
  await lib.ticketStore().setJSON("file/" + legacy[0].id, { ...legacy[0], ticketId: id, bytes });
  await lib.ticketStore().setJSON("file/" + legacy[1].id, { ...legacy[1], ticketId: id, bytes: jpgBytes });
  const raw = await lib.ticketStore().get("ticket/" + id, { type: "json" });
  await lib.ticketStore().setJSON("ticket/" + id, { ...raw, files: legacy });

  assert.equal((await tickets.correctFileNames(SIGNAGE_ACTOR, id)).status, 403);
  const fixed = await tickets.correctFileNames(ADMIN, id);
  assert.equal(fixed.status, 200, JSON.stringify(fixed));
  assert.deepEqual(fixed.body.renamed, [{ id: legacy[0].id, from: "legacy-sign.jpg", to: "legacy-sign.png" }]);
  assert.deepEqual(fixed.body.ticket.files.map((row) => row.name), ["legacy-sign.png", "camera.jpg"]);
  const stored = await lib.ticketStore().get("file/" + legacy[0].id, { type: "json" });
  assert.equal(stored.name, "legacy-sign.png");
  assert.equal(stored.bytes, bytes, "bytes untouched");
  assert.equal(stored.contentType, "image/png");
  const rename = (await auditFor(id)).filter((row) => row.action === "file-rename");
  assert.equal(rename.length, 1);
  assert.equal(rename[0].actor, JOSHUA);
  assert.equal(rename[0].detail, legacy[0].id + " legacy-sign.jpg -> legacy-sign.png");
  assert.equal((await tickets.correctFileNames(ADMIN, id)).error, "All attachment names already match.");
});

async function closable(requesterEmail = "closer.requester@libertyretail.com.au") {
  const created = await tickets.createTicket(ADMIN, {
    queue: "signage", siteId: "s00000001", requestType: "Replacement", priority: "normal",
    subject: "TEST close-out", description: "TEST close-out photo", requesterEmail,
  });
  assert.equal(created.status, 200);
  return created.body.ticket.id;
}

test("close-out accepts a PNG photo and stores it as close-out.png with image/png", async () => {
  const id = await closable();
  const sentBefore = sent.length;
  const closed = await tickets.closeTicket(ADMIN, id, { notes: "TEST installed", photo: pngBytes().toString("base64") });
  assert.equal(closed.status, 200, JSON.stringify(closed));
  const photoId = closed.body.ticket.closeOut.photoId;
  assert.match(photoId, /^f[a-f0-9]{16}$/);
  assert.deepEqual(closed.body.ticket.files, [{ id: photoId, name: "close-out.png", contentType: "image/png" }]);
  const stored = await lib.ticketStore().get("file/" + photoId, { type: "json" });
  assert.equal(stored.name, "close-out.png");
  assert.equal(stored.contentType, "image/png");
  assert.equal(stored.ticketId, id);
  assert.deepEqual([...Buffer.from(stored.bytes, "base64").subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = await tickets.readFile(ADMIN, id, photoId);
  assert.equal(file.contentType, "image/png");
  assert.equal(file.name, "close-out.png");
  assert.equal(closed.body.ticket.status, "closed");
  assert.equal(sent.length, sentBefore, "the lib close path never sends");
});

test("close-out still accepts JPEG and stores it as close-out.jpg with image/jpeg", async () => {
  const id = await closable();
  const closed = await tickets.closeTicket(ADMIN, id, { notes: "TEST installed", photo: jpegBytes().toString("base64") });
  assert.equal(closed.status, 200, JSON.stringify(closed));
  const photoId = closed.body.ticket.closeOut.photoId;
  assert.deepEqual(closed.body.ticket.files, [{ id: photoId, name: "close-out.jpg", contentType: "image/jpeg" }]);
  const stored = await lib.ticketStore().get("file/" + photoId, { type: "json" });
  assert.equal(stored.contentType, "image/jpeg");
  assert.deepEqual([...Buffer.from(stored.bytes, "base64").subarray(0, 2)], [0xff, 0xd8]);
});

test("close-out keeps the magic-byte check and size limits; rejects PDFs and non-images without closing", async () => {
  const id = await closable();
  const pdf = await tickets.closeTicket(ADMIN, id, { notes: "TEST", photo: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n").toString("base64") });
  assert.equal(pdf.status, 400);
  assert.equal(pdf.error, "Close-out uses a JPEG or PNG photo.");
  const text = await tickets.closeTicket(ADMIN, id, { notes: "TEST", photo: Buffer.from("not an image at all, renamed to photo.png").toString("base64") });
  assert.equal(text.status, 400);
  assert.equal(text.error, "Use a JPEG or PNG photo.");
  const huge = pngBytes();
  huge.writeUInt32BE(20000, 16);
  huge.writeUInt32BE(20000, 20);
  const tooBig = await tickets.closeTicket(ADMIN, id, { notes: "TEST", photo: huge.toString("base64") });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.error, "The photo is too large.");
  const oversize = Buffer.concat([pngBytes(), Buffer.alloc(8_000_001)]);
  const tooLarge = await tickets.closeTicket(ADMIN, id, { notes: "TEST", photo: oversize.toString("base64") });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.error, "The file is too large.");
  const raw = await lib.ticketStore().get("ticket/" + id, { type: "json" });
  assert.equal(raw.status, "new");
  assert.deepEqual(raw.files, []);
  const notes = await tickets.closeTicket(ADMIN, id, { notes: "", photo: pngBytes().toString("base64") });
  assert.equal(notes.error, "Completion notes are required.");
});

test("a PNG close-out photo stays hidden from the requester like the JPEG one", async () => {
  const scope = { email: "closer.requester@libertyretail.com.au" };
  const id = await closable(scope.email);
  const upload = await tickets.addFile(ADMIN, id, { name: "before.png", data: pngBytes().toString("base64") });
  const visibleId = upload.body.ticket.files[0].id;
  const closed = await tickets.closeTicket(ADMIN, id, { notes: "TEST done", photo: pngBytes().toString("base64") });
  const photoId = closed.body.ticket.closeOut.photoId;
  const own = await publicLib.readOwnTicket(scope, id);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.ticket.files.map((row) => row.id), [visibleId]);
  assert.equal((await publicLib.readOwnFile(scope, id, photoId)).status, 404);
  assert.equal((await publicLib.readOwnFile(scope, id, visibleId)).status, 200);
  assert.equal(tickets.isCloseOutFile({ closeOut: null }, { id: "fx", name: "close-out.jpg" }), true);
  assert.equal(tickets.isCloseOutFile({ closeOut: { photoId: "fy" } }, { id: "fy", name: "renamed.png" }), true);
  assert.equal(tickets.isCloseOutFile({ closeOut: null }, { id: "fz", name: "before.png" }), false);
  // Legacy-name correction leaves close-out photos alone.
  assert.equal((await tickets.correctFileNames(ADMIN, id)).error, "All attachment names already match.");
});
