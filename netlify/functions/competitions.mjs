import crypto from "node:crypto";
import {
  json, env, publicBase, validSlug, visitorHash,
  competitionsStore, compEntries, compFiles, compViews, vouchersStore,
} from "../lib/lib.mjs";
import { actorFrom, assignSite, canSeeSite, forbidden, siteOf, unauthorised } from "../lib/access.mjs";
import { competitionReminders } from "../lib/reminders.mjs";
import { posterHtml } from "../lib/posters.mjs";
import { issueVoucher, voucherConfig } from "../lib/vouchers.mjs";
import { updateCollection, winnerNotice } from "../lib/notices.mjs";
import { competitionSnapshot } from "../lib/templates.mjs";
import { recordView } from "../lib/pages.mjs";
import {
  defaultCompetition, applyCompetitionPatch, buildIncoming, classifyEntry, dashboard,
  chooseWinner, melbourneDate, melbourneStamp, accepting, entryNotice, periodCount, publicCompetition,
  renderCompetitionPage, unavailableCompetition, parseImportRows, summariseEntry, normaliseEmail, normalisePhone,
} from "../lib/competitions.mjs";

const gen = () => Array.from(crypto.randomBytes(6), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

function html(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function listEntries(slug) {
  const { blobs } = await compEntries().list({ prefix: slug + "/" });
  const items = await Promise.all(blobs.map((b) => compEntries().get(b.key, { type: "json" })));
  return items.filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function notify(subject, text) {
  const key = env("RESEND_API_KEY");
  const from = env("RESEND_FROM");
  const to = env("RESEND_TO");
  if (!key || !from || !to) return { sent: false };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) console.error("email", res.status);
    return { sent: res.ok };
  } catch (e) {
    console.error("email", e && e.message);
    return { sent: false };
  }
}

function summary(comp, entries, views) {
  const stats = dashboard(comp, entries);
  const pub = publicCompetition(comp);
  delete pub.heroData;
  delete pub.logoData;
  return {
    ...pub,
    hasHero: !!(comp.heroData || comp.heroUrl),
    hasLogo: !!comp.logoData,
    reminders: competitionReminders(comp),
    voucher: voucherConfig(comp),
    ...stats,
    entries: entries.length,
    views: views?.total || 0,
    daily: views?.daily || {},
  };
}

async function handlePublic(req, context, slug) {
  const comp = await competitionsStore().get(slug, { type: "json" }).catch(() => null);
  if (!comp || comp.status === "draft") return html(404, unavailableCompetition());
  const today = melbourneDate();
  if (req.method === "GET") {
    try {
      const prev = await compViews().get(slug, { type: "json" });
      await compViews().setJSON(slug, recordView(prev, { day: melbourneDate(), at: new Date().toISOString(), visitor: visitorHash(context.ip || "", req.headers.get("user-agent") || "") }));
    } catch (e) { console.error("comp-view", e && e.message); }
    return html(200, renderCompetitionPage(comp, { notice: entryNotice(comp, today) }));
  }
  if (req.method === "POST") return submit(req, comp);
  return html(405, unavailableCompetition());
}

async function submit(req, comp) {
  if (!accepting(comp)) return json(400, { error: "This competition is not accepting entries" });
  const idem = String(req.headers.get("idempotency-key") || "").trim().slice(0, 80);
  const idemKey = idem ? "entry-idem/" + comp.slug + "/" + idem : "";
  if (idemKey) {
    const prior = await vouchersStore().get(idemKey, { type: "json" });
    if (prior?.response) return json(200, prior.response);
    const gate = await vouchersStore().setJSON(idemKey, { pending: true }, { onlyIfNew: true });
    if (!gate || gate.modified !== true) return json(409, { error: "This entry is already being saved" });
  }
  const body = await req.json().catch(() => ({}));
  const incoming = buildIncoming(comp, body);
  if (incoming.error) {
    if (idemKey) await vouchersStore().delete(idemKey);
    return json(400, { error: incoming.error });
  }
  const existing = await listEntries(comp.slug);
  const verdict = classifyEntry(comp, existing, incoming);
  const now = new Date();
  const id = "e" + crypto.randomBytes(6).toString("hex");
  const entry = {
    id,
    campaign: comp.slug,
    at: now.toISOString(),
    melbourne: melbourneStamp(now),
    formDate: melbourneDate(now),
    period: comp.currentPeriod || 1,
    name: incoming.name,
    contact: incoming.contact,
    contactNorm: incoming.contactNorm,
    contactType: incoming.contactType,
    emailNorm: incoming.emailNorm,
    phoneNorm: incoming.phoneNorm,
    regoNorm: incoming.regoNorm,
    receiptNumber: incoming.receiptNumber,
    receiptHash: incoming.receiptHash,
    photoHash: incoming.photoHash,
    receiptMatch: incoming.receiptHash || incoming.photoHash ? "sha256" : "",
    receiptStored: !!incoming.photo,
    site: incoming.site,
    over18: incoming.over18,
    consent: incoming.consent,
    note: "",
    values: incoming.values,
    status: verdict.status,
    duplicateReason: verdict.duplicateReason,
    matchedEntryId: verdict.matchedEntryId,
    source: "form",
    pageUrl: publicBase() + "/c/" + comp.slug,
  };
  await compEntries().setJSON(comp.slug + "/" + id, entry);
  if (incoming.photo) await compFiles().setJSON(comp.slug + "/" + id, { data: incoming.photo });
  let voucherToken;
  const offer = voucherConfig(comp);
  if (entry.status === "valid" && offer.enabled) {
    const issued = await issueVoucher(vouchersStore(), {
      competition: comp.slug,
      siteId: comp.siteId || "",
      source: "entry",
      sourceId: idem || entry.id,
      expires: offer.expires,
      label: offer.label,
    });
    if (issued?.token) {
      voucherToken = issued.token;
      entry.voucherId = issued.id;
      await compEntries().setJSON(comp.slug + "/" + id, entry);
    }
  }
  if (entry.status === "valid") {
    await notify("New competition entry: " + (comp.name || comp.slug), [comp.name, entry.pageUrl, "", entry.name, entry.contact, "Period " + entry.period].join("\n"));
  }
  const response = { ok: true, status: entry.status, id: entry.id, thankYou: comp.thankYou, ...(voucherToken ? { voucherToken } : {}) };
  if (idemKey) await vouchersStore().setJSON(idemKey, { response });
  return json(200, response);
}

async function performDraw(comp, entries, { redraw = false, drawNumber = 0 } = {}) {
  const active = (comp.winners || []).filter((w) => !w.superseded);
  if (!redraw && active.length >= periodCount(comp)) return { error: "All draws for this competition are complete" };
  if (redraw) {
    const target = active.find((w) => w.drawNumber === drawNumber) || active[active.length - 1];
    if (!target) return { error: "There is no draw to redraw" };
    const exclude = (comp.winners || []).filter((w) => w.drawNumber === target.drawNumber).map((w) => w.entryId);
    const picked = chooseWinner(entries, target.period, exclude);
    if (picked.error) return picked;
    const winner = winnerRecord(comp, picked.winner, target.drawNumber, picked.poolSize, true);
    const winners = (comp.winners || []).map((w) => w.drawNumber === target.drawNumber && !w.superseded ? { ...w, superseded: true } : w);
    winners.push(winner);
    return { competition: { ...comp, winners, updated: new Date().toISOString() }, winner, archive: null };
  }
  const period = comp.currentPeriod || 1;
  const picked = chooseWinner(entries, period);
  if (picked.error) return picked;
  const drawNo = active.length + 1;
  const winner = winnerRecord(comp, picked.winner, drawNo, picked.poolSize, false);
  const archiveIds = entries.filter((e) => e.period === period && e.status === "valid").map((e) => e.id);
  return {
    competition: { ...comp, winners: [...(comp.winners || []), winner], currentPeriod: period + 1, updated: new Date().toISOString() },
    winner,
    archive: archiveIds,
  };
}

function winnerRecord(comp, entry, drawNumber, poolSize, redraw) {
  const now = new Date();
  return {
    id: "w" + crypto.randomBytes(4).toString("hex"),
    campaign: comp.slug,
    drawNumber,
    at: now.toISOString(),
    melbourne: melbourneStamp(now),
    name: entry.name,
    contact: entry.contact,
    contactNorm: entry.contactNorm,
    receiptHash: entry.receiptHash || entry.photoHash || "",
    receiptStored: !!entry.receiptStored,
    entryAt: entry.at,
    entryId: entry.id,
    period: entry.period,
    pool: "period-" + entry.period,
    poolSize,
    redraw,
    superseded: false,
  };
}

export default async (req, context) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const pub = path.match(/^\/c\/([^/]+)$/);
  if (pub) return handlePublic(req, context, decodeURIComponent(pub[1]).toLowerCase());
  const actor = await actorFrom(req);
  if (!actor) return unauthorised();

  if (path === "/api/competitions" && req.method === "GET") {
    const { blobs } = await competitionsStore().list();
    const comps = (await Promise.all(blobs.map((b) => competitionsStore().get(b.key, { type: "json" })))).filter((comp) => comp && canSeeSite(actor, siteOf(comp)));
    const out = await Promise.all(comps.map(async (comp) => summary(comp, await listEntries(comp.slug), await compViews().get(comp.slug, { type: "json" }))));
    return json(200, out.sort((a, b) => String(b.created).localeCompare(String(a.created))));
  }
  if (path === "/api/competitions" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const assigned = assignSite(actor, null, body);
    if (assigned.error) return forbidden();
    let slug = String(body.slug || "").trim().toLowerCase();
    if (slug) {
      if (!validSlug(slug)) return json(400, { error: "Slug: 2–41 chars, a-z, 0-9 and hyphens" });
      if (await competitionsStore().get(slug)) return json(409, { error: "Slug already in use" });
    } else do slug = gen(); while (await competitionsStore().get(slug));
    const built = applyCompetitionPatch(defaultCompetition({ slug, created: new Date().toISOString() }), { name: body.name || "Untitled competition", ...body, status: body.status || "draft" });
    if (built.error) return json(400, { error: built.error });
    const comp = { ...built.competition, slug, siteId: assigned.siteId, winners: built.competition.winners || [] };
    await competitionsStore().setJSON(slug, comp);
    return json(201, publicCompetition(comp));
  }

  const draw = path.match(/^\/api\/competitions\/([^/]+)\/draw$/);
  if (draw && req.method === "POST") {
    const slug = decodeURIComponent(draw[1]).toLowerCase();
    const comp = await competitionsStore().get(slug, { type: "json" });
    if (!comp) return json(404, { error: "Not found" });
    if (!canSeeSite(actor, siteOf(comp))) return forbidden();
    const body = await req.json().catch(() => ({}));
    const entries = await listEntries(slug);
    const result = await performDraw(comp, entries, { redraw: !!body.redraw, drawNumber: Number(body.drawNumber) || 0 });
    if (result.error) return json(400, { error: result.error });
    await competitionsStore().setJSON(slug, result.competition);
    if (result.archive) {
      await Promise.all(result.archive.map(async (id) => {
        const entry = entries.find((e) => e.id === id);
        if (entry) await compEntries().setJSON(slug + "/" + id, { ...entry, status: "archived" });
      }));
    }
    await notify("Competition draw: " + (comp.name || slug), [comp.name, "Draw " + result.winner.drawNumber, result.winner.name, result.winner.contact, "Pool " + result.winner.poolSize].join("\n"));
    return json(200, { winner: result.winner, competition: publicCompetition(result.competition) });
  }

  const imp = path.match(/^\/api\/competitions\/([^/]+)\/import$/);
  if (imp && req.method === "POST") return importEntries(decodeURIComponent(imp[1]).toLowerCase(), req, actor);

  const file = path.match(/^\/api\/competitions\/([^/]+)\/files\/([^/]+)$/);
  if (file && req.method === "GET") {
    const slug = decodeURIComponent(file[1]).toLowerCase();
    const id = decodeURIComponent(file[2]);
    const comp = await competitionsStore().get(slug, { type: "json" });
    if (!comp) return json(404, { error: "Not found" });
    if (!canSeeSite(actor, siteOf(comp))) return forbidden();
    const stored = await compFiles().get(slug + "/" + id, { type: "json" });
    if (!stored?.data) return json(404, { error: "No receipt file" });
    return json(200, stored);
  }

  const poster = path.match(/^\/api\/competitions\/([^/]+)\/poster$/);
  if (poster && req.method === "GET") return competitionPoster(decodeURIComponent(poster[1]).toLowerCase(), req, actor);

  const copy = path.match(/^\/api\/competitions\/([^/]+)\/copy$/);
  if (copy && req.method === "POST") return copyCompetition(decodeURIComponent(copy[1]).toLowerCase(), req, actor);

  const exported = path.match(/^\/api\/competitions\/([^/]+)\/export$/);
  if (exported && req.method === "GET") return exportEntries(decodeURIComponent(exported[1]).toLowerCase(), actor);

  const notice = path.match(/^\/api\/competitions\/([^/]+)\/winners\/([^/]+)\/notice$/);
  if (notice && req.method === "GET") return winnerDraft(decodeURIComponent(notice[1]).toLowerCase(), decodeURIComponent(notice[2]), actor);

  const collection = path.match(/^\/api\/competitions\/([^/]+)\/winners\/([^/]+)\/collection$/);
  if (collection && req.method === "POST") return saveCollection(decodeURIComponent(collection[1]).toLowerCase(), decodeURIComponent(collection[2]), req, actor);

  const one = path.match(/^\/api\/competitions\/([^/]+)$/);
  if (!one) return json(404, { error: "Not found" });
  const slug = decodeURIComponent(one[1]).toLowerCase();
  const comp = await competitionsStore().get(slug, { type: "json" });
  if (!comp) return json(404, { error: "Not found" });
  if (!canSeeSite(actor, siteOf(comp))) return forbidden();
  if (req.method === "GET") {
    const [entries, views] = await Promise.all([listEntries(slug), compViews().get(slug, { type: "json" })]);
    return json(200, { competition: { ...publicCompetition(comp), voucher: voucherConfig(comp) }, entries: entries.map(summariseEntry), stats: dashboard(comp, entries), views: views || { total: 0, daily: {}, visitors: {} } });
  }
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const assigned = assignSite(actor, comp, body);
    if (assigned.error) return forbidden();
    const patched = applyCompetitionPatch(comp, body);
    if (patched.error) return json(400, { error: patched.error });
    const next = { ...patched.competition, slug, siteId: assigned.siteId, winners: comp.winners || [], currentPeriod: body.currentPeriod ? patched.competition.currentPeriod : (comp.currentPeriod || 1) };
    await competitionsStore().setJSON(slug, next);
    return json(200, publicCompetition(next));
  }
  if (req.method === "DELETE") {
    await competitionsStore().delete(slug);
    await compViews().delete(slug);
    const { blobs } = await compEntries().list({ prefix: slug + "/" });
    await Promise.all(blobs.map((b) => compEntries().delete(b.key)));
    const files = await compFiles().list({ prefix: slug + "/" });
    await Promise.all((files.blobs || []).map((b) => compFiles().delete(b.key)));
    return json(200, { ok: true });
  }
  return json(405, { error: "Method not allowed" });
};

async function visibleComp(slug, actor) {
  const comp = await competitionsStore().get(slug, { type: "json" });
  if (!comp) return { error: json(404, { error: "Not found" }) };
  if (!canSeeSite(actor, siteOf(comp))) return { error: forbidden() };
  return { comp };
}

async function competitionPoster(slug, req, actor) {
  const found = await visibleComp(slug, actor);
  if (found.error) return found.error;
  const size = new URL(req.url).searchParams.get("size") === "a3" ? "a3" : "a4";
  const html = posterHtml(found.comp, { base: publicBase(), size });
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function copyCompetition(slug, req, actor) {
  const found = await visibleComp(slug, actor);
  if (found.error) return found.error;
  const body = await req.json().catch(() => ({}));
  const assigned = assignSite(actor, null, Object.prototype.hasOwnProperty.call(body, "siteId") ? body : { siteId: found.comp.siteId || "" });
  if (assigned.error) return forbidden();
  let nextSlug = String(body.slug || "").trim().toLowerCase();
  if (nextSlug) {
    if (!validSlug(nextSlug)) return json(400, { error: "Slug: 2–41 chars, a-z, 0-9 and hyphens" });
    if (await competitionsStore().get(nextSlug)) return json(409, { error: "Slug already in use" });
  } else do nextSlug = gen(); while (await competitionsStore().get(nextSlug));
  const snap = competitionSnapshot(found.comp);
  const built = applyCompetitionPatch(defaultCompetition({ slug: nextSlug, created: new Date().toISOString() }), {
    ...snap,
    name: body.name || (snap.name ? snap.name + " copy" : "Untitled competition"),
    sites: body.sites !== undefined ? body.sites : snap.sites,
    prize: body.prize !== undefined ? body.prize : snap.prize,
    start: body.start !== undefined ? body.start : snap.start,
    end: body.end !== undefined ? body.end : snap.end,
    status: "draft",
    codeSlug: "",
    voucher: { enabled: false },
  });
  if (built.error) return json(400, { error: built.error });
  const comp = { ...built.competition, slug: nextSlug, siteId: assigned.siteId, winners: [], currentPeriod: 1, status: "draft", codeSlug: "", voucher: { enabled: false } };
  await competitionsStore().setJSON(nextSlug, comp);
  return json(201, publicCompetition(comp));
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportEntries(slug, actor) {
  const found = await visibleComp(slug, actor);
  if (found.error) return found.error;
  const entries = await listEntries(slug);
  const headers = ["Entry ID", "Name", "Contact", "Status", "Period", "Site"];
  const lines = [headers.join(",")];
  for (const entry of entries) lines.push([entry.id, entry.name, entry.contact, entry.status, entry.period, entry.site].map(csvCell).join(","));
  return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" } });
}

async function winnerDraft(slug, winnerId, actor) {
  const found = await visibleComp(slug, actor);
  if (found.error) return found.error;
  const winner = (found.comp.winners || []).find((item) => item.id === winnerId && !item.superseded);
  if (!winner) return json(404, { error: "Not found" });
  return json(200, winnerNotice(found.comp, winner));
}

async function saveCollection(slug, winnerId, req, actor) {
  const found = await visibleComp(slug, actor);
  if (found.error) return found.error;
  const body = await req.json().catch(() => ({}));
  const winners = found.comp.winners || [];
  const index = winners.findIndex((item) => item.id === winnerId && !item.superseded);
  if (index < 0) return json(404, { error: "Not found" });
  const updated = updateCollection(winners[index], { status: body.status, notes: body.notes, actor: actor.id });
  if (updated.error) return json(400, { error: updated.error });
  const nextWinners = winners.slice();
  nextWinners[index] = updated.winner;
  const next = { ...found.comp, winners: nextWinners, updated: new Date().toISOString() };
  await competitionsStore().setJSON(slug, next);
  return json(200, { winner: updated.winner });
}

async function importEntries(slug, req, actor) {
  const found = await visibleComp(slug, actor);
  if (found.error) return found.error;
  const comp = found.comp;
  const body = await req.json().catch(() => ({}));
  const rows = parseImportRows(body.entries || body.rows || []);
  if (!rows.length) return json(400, { error: "No rows to import" });
  if (rows.length > 2000) return json(400, { error: "Import up to 2000 rows at a time" });
  const existing = await listEntries(slug);
  let imported = 0;
  for (const row of rows) {
    const id = /^[a-z0-9_-]{2,40}$/i.test(row.id) ? row.id : "e" + crypto.randomBytes(6).toString("hex");
    if (existing.some((e) => e.id === id)) continue;
    const contactType = row.contactType === "phone" || row.contactType === "email" ? row.contactType : (row.contact.includes("@") ? "email" : "phone");
    const contactNorm = row.contactNorm || (contactType === "email" ? normaliseEmail(row.contact) : normalisePhone(row.contact));
    const receiptHash = row.receiptHash || "";
    const base = {
      id, campaign: slug, at: row.at || new Date().toISOString(), melbourne: row.at ? melbourneStamp(new Date(row.at)) : melbourneStamp(),
      formDate: row.formDate || (row.at ? melbourneDate(new Date(row.at)) : melbourneDate()),
      period: row.period || comp.currentPeriod || 1,
      name: row.name, contact: row.contact, contactNorm, contactType,
      emailNorm: contactType === "email" ? contactNorm : "",
      phoneNorm: contactType === "phone" ? contactNorm : "",
      regoNorm: "", receiptNumber: "", receiptHash, photoHash: "", receiptMatch: receiptHash ? "sha256" : "",
      receiptUrl: row.receiptUrl, receiptStored: false, site: row.site, over18: row.over18, consent: row.consent,
      note: row.note, values: {}, source: "import", pageUrl: row.receiptUrl || "",
      status: "valid", duplicateReason: row.duplicateReason, matchedEntryId: row.matchedEntryId,
    };
    if (row.status === "duplicate" || row.status === "archived" || row.status === "valid") base.status = row.status;
    else {
      const verdict = classifyEntry(comp, existing, base);
      base.status = verdict.status;
      base.duplicateReason = verdict.duplicateReason;
      base.matchedEntryId = verdict.matchedEntryId;
    }
    if (row.at && Number.isNaN(new Date(row.at).getTime())) base.at = new Date().toISOString();
    await compEntries().setJSON(slug + "/" + id, base);
    existing.push(base);
    imported += 1;
  }
  return json(200, { imported });
}

export const config = {
  path: [
    "/api/competitions",
    "/api/competitions/:slug",
    "/api/competitions/:slug/draw",
    "/api/competitions/:slug/import",
    "/api/competitions/:slug/files/:entryId",
    "/api/competitions/:slug/poster",
    "/api/competitions/:slug/copy",
    "/api/competitions/:slug/export",
    "/api/competitions/:slug/winners/:winnerId/notice",
    "/api/competitions/:slug/winners/:winnerId/collection",
    "/c/:slug",
  ],
};
