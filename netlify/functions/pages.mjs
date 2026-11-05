import crypto from "node:crypto";
import {
  authed, json, env, publicBase, validSlug, dayKey, visitorHash,
  pagesStore, pageViews, submissionsStore,
} from "../lib/lib.mjs";
import {
  defaultPage, applyPagePatch, readSubmission, recordView, publicPage,
  renderPublicPage, unavailablePage,
} from "../lib/pages.mjs";

const gen = () => Array.from(crypto.randomBytes(6), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

function html(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function listSubmissions(slug) {
  const { blobs } = await submissionsStore().list({ prefix: slug + "/" });
  const items = await Promise.all(blobs.map(async (b) => submissionsStore().get(b.key, { type: "json" })));
  return items.filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function notifySubmission(page, item) {
  const key = env("RESEND_API_KEY");
  const from = env("RESEND_FROM");
  const to = env("RESEND_TO");
  if (!key || !from || !to) return { sent: false };
  const lines = (page.fields || []).map((f) => f.label + ": " + (item.values?.[f.id] || ""));
  const text = [page.name || page.slug, publicBase() + "/p/" + page.slug, "", ...lines].join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "New page submission: " + (page.name || page.slug),
        text,
      }),
    });
    if (!res.ok) console.error("email", res.status);
    return { sent: res.ok };
  } catch (e) {
    console.error("email", e && e.message);
    return { sent: false };
  }
}

async function handlePublic(req, context, slug) {
  const page = await pagesStore().get(slug, { type: "json" }).catch(() => null);
  if (!page || page.status !== "published") return html(404, unavailablePage());
  if (req.method === "GET") {
    try {
      const ua = req.headers.get("user-agent") || "";
      const prev = await pageViews().get(slug, { type: "json" });
      const next = recordView(prev, {
        day: dayKey(),
        at: new Date().toISOString(),
        visitor: visitorHash(context.ip || "", ua),
      });
      await pageViews().setJSON(slug, next);
    } catch (e) { console.error("page-view", e && e.message); }
    return html(200, renderPublicPage(page));
  }
  if (req.method === "POST") return submit(req, context, page);
  return html(405, unavailablePage());
}

async function submit(req, context, page) {
  if (page.status !== "published") return json(404, { error: "This page is not available" });
  const type = req.headers.get("content-type") || "";
  let body = {};
  if (type.includes("application/json")) body = await req.json().catch(() => ({}));
  else {
    const text = await req.text();
    body = Object.fromEntries(new URLSearchParams(text));
  }
  const parsed = readSubmission(page.fields, body);
  if (parsed.error) {
    if (type.includes("application/json")) return json(400, { error: parsed.error });
    return html(400, renderPublicPage(page, { error: parsed.error }));
  }
  const existing = await listSubmissions(page.slug);
  if (existing.length >= 1000) return json(429, { error: "This page is not accepting more submissions" });
  const item = { id: crypto.randomBytes(8).toString("hex"), at: new Date().toISOString(), values: parsed.values };
  await submissionsStore().setJSON(page.slug + "/" + item.id, item);
  await notifySubmission(page, item);
  if (type.includes("application/json") || (req.headers.get("accept") || "").includes("application/json")) {
    return json(200, { ok: true, thankYou: page.thankYou });
  }
  return html(200, renderPublicPage(page, { thankYou: true }));
}

async function summary(page) {
  const [views, submissions] = await Promise.all([
    pageViews().get(page.slug, { type: "json" }).catch(() => null),
    listSubmissions(page.slug),
  ]);
  const pub = publicPage(page);
  return { ...pub, submissions: submissions.length, views: views?.total || 0, daily: views?.daily || {} };
}

export default async (req, context) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  const pub = path.match(/^\/p\/([^/]+)$/);
  if (pub) return handlePublic(req, context, decodeURIComponent(pub[1]).toLowerCase());

  if (!authed(req)) return json(401, { error: "Unauthorized" });
  if (path === "/api/pages" && req.method === "GET") {
    const { blobs } = await pagesStore().list();
    const pages = (await Promise.all(blobs.map((b) => pagesStore().get(b.key, { type: "json" })))).filter(Boolean);
    const out = await Promise.all(pages.map(summary));
    return json(200, out.sort((a, b) => String(b.created).localeCompare(String(a.created))));
  }
  if (path === "/api/pages" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    let slug = String(body.slug || "").trim().toLowerCase();
    if (slug) {
      if (!validSlug(slug)) return json(400, { error: "Slug: 2–41 chars, a-z, 0-9 and hyphens" });
      if (await pagesStore().get(slug)) return json(409, { error: "Slug already in use" });
    } else {
      do slug = gen(); while (await pagesStore().get(slug));
    }
    const built = applyPagePatch(defaultPage({ slug, created: new Date().toISOString() }), { name: body.name || "Untitled page", ...body, status: body.status || "draft" });
    if (built.error) return json(400, { error: built.error });
    const page = { ...built.page, slug };
    await pagesStore().setJSON(slug, page);
    return json(201, publicPage(page, { hero: true }));
  }

  const sub = path.match(/^\/api\/pages\/([^/]+)\/submit$/);
  if (sub) {
    const slug = decodeURIComponent(sub[1]).toLowerCase();
    const page = await pagesStore().get(slug, { type: "json" });
    if (!page) return json(404, { error: "Not found" });
    return submit(req, context, page);
  }
  const one = path.match(/^\/api\/pages\/([^/]+)$/);
  if (!one) return json(404, { error: "Not found" });
  const slug = decodeURIComponent(one[1]).toLowerCase();
  const page = await pagesStore().get(slug, { type: "json" });
  if (!page) return json(404, { error: "Not found" });

  if (req.method === "GET") {
    const [views, submissions] = await Promise.all([
      pageViews().get(slug, { type: "json" }).catch(() => null),
      listSubmissions(slug),
    ]);
    return json(200, { page: publicPage(page, { hero: true }), submissions, stats: views || { total: 0, last: null, daily: {}, visitors: {} } });
  }
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const patched = applyPagePatch(page, body);
    if (patched.error) return json(400, { error: patched.error });
    const next = { ...patched.page, slug };
    await pagesStore().setJSON(slug, next);
    return json(200, publicPage(next, { hero: true }));
  }
  if (req.method === "DELETE") {
    await pagesStore().delete(slug);
    await pageViews().delete(slug);
    const { blobs } = await submissionsStore().list({ prefix: slug + "/" });
    await Promise.all(blobs.map((b) => submissionsStore().delete(b.key)));
    return json(200, { ok: true });
  }
  return json(405, { error: "Method not allowed" });
};

export const config = {
  path: ["/api/pages", "/api/pages/:slug", "/api/pages/:slug/submit", "/p/:slug"],
};
