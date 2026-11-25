import { test } from "node:test";
import assert from "node:assert/strict";

/** Editable Express Help footer. In-memory store, mail mocked, no live writes. */
const H = await import("./support/browser-harness.mjs");
const lib = await import("../netlify/lib/lib.mjs");
const footer = await import("../netlify/lib/footer.mjs");
const owner = await H.otpCookie(H.JOSHUA);
const j = async (p) => { const r = await p; const t = r.headers.get("content-type") || ""; return { status: r.status, headers: r.headers, body: t.includes("json") ? await r.json() : await r.text() }; };

test("GET /api/footer is public and returns the usual wording when the setting is unset", async () => {
  const r = await j(H.call("GET", "/api/footer"));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(r.body, { lead: footer.FOOTER_LEAD, linkText: footer.FOOTER_LINK_TEXT, email: footer.FOOTER_EMAIL });
  assert.equal(footer.footerHtml().includes(footer.FOOTER_LEAD), true);
  assert.equal(footer.footerText(), footer.FOOTER_LEAD + " " + footer.FOOTER_LINK_TEXT + ": mailto:" + footer.FOOTER_EMAIL);
});

test("owner can save the footer; blank fields keep the defaults; invalid email is refused", async () => {
  const anon = await j(H.call("POST", "/api/footer", { body: { lead: "Hello", email: "hello@libertyretail.com.au", linkText: "write" } }));
  assert.equal(anon.status, 401);
  const bad = await j(H.call("POST", "/api/footer", { cookie: owner, body: { lead: "Hello", email: "not-an-email", linkText: "write" } }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not valid/i);
  const saved = await j(H.call("POST", "/api/footer", { cookie: owner, body: { lead: "  Thanks for visiting  ", email: "  Help@LibertyRetail.com.au ", linkText: " send a note " } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { lead: "Thanks for visiting", linkText: "send a note", email: "help@libertyretail.com.au" });
  const got = await j(H.call("GET", "/api/footer"));
  assert.deepEqual(got.body, saved.body);
  assert.equal(footer.footerText(got.body), "Thanks for visiting send a note: mailto:help@libertyretail.com.au");
  assert.match(footer.footerHtml(got.body), /mailto:help@libertyretail\.com\.au/);
  assert.match(footer.footerHtml(got.body), />send a note</);

  const blanks = await j(H.call("POST", "/api/footer", { cookie: owner, body: { lead: "", email: "", linkText: "" } }));
  assert.equal(blanks.status, 200);
  assert.deepEqual(blanks.body, { lead: footer.FOOTER_LEAD, linkText: footer.FOOTER_LINK_TEXT, email: footer.FOOTER_EMAIL }, "blank fields fall back so the footer never disappears");
});

test("footer text is escaped in HTML and the saved wording is used on server-rendered pages", async () => {
  const saved = await j(H.call("POST", "/api/footer", { cookie: owner, body: { lead: 'Cowabunga <script>alert(1)</script> & "quoted"', email: "safe@libertyretail.com.au", linkText: 'click <b>here</b>' } }));
  assert.equal(saved.status, 200);
  const html = footer.footerHtml(saved.body);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;quoted&quot;/);
  assert.match(html, /click &lt;b&gt;here&lt;\/b&gt;/);
  assert.match(html, /mailto:safe@libertyretail\.com\.au/);

  const redirect = (await import("../netlify/functions/redirect.mjs")).default;
  const res = await redirect(new Request("https://expresshelp.site/r/nothing-here"), { params: { slug: "nothing-here" } });
  const text = await res.text();
  assert.equal(res.status, 404);
  assert.match(text, /data-testid="eh-footer"/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /mailto:safe@libertyretail\.com\.au/);
  assert.match(text, /click &lt;b&gt;here&lt;\/b&gt;/);

  // Restore defaults so later checks see the usual wording.
  const restored = await j(H.call("POST", "/api/footer", { cookie: owner, body: { lead: footer.FOOTER_LEAD, email: footer.FOOTER_EMAIL, linkText: footer.FOOTER_LINK_TEXT } }));
  assert.equal(restored.status, 200);
  assert.equal(restored.body.lead, footer.FOOTER_LEAD);
});

test("staff cannot change the footer; previews refuse writes", async () => {
  const users = await import("../netlify/lib/users.mjs");
  const added = await users.saveUser(H.OWNER, { mode: "add", email: "staff.footer@libertyretail.com.au", visitor: "view", tickets: [], assets: "none", warehouse: true });
  assert.equal(added.status, 200, added.error);
  const staff = await H.otpCookie("staff.footer@libertyretail.com.au");
  const denied = await j(H.call("POST", "/api/footer", { cookie: staff, body: { lead: "Nope", email: "nope@libertyretail.com.au", linkText: "no" } }));
  assert.equal(denied.status, 403);

  const fn = (await import("../netlify/functions/footer.mjs")).default;
  const previewReq = new Request("https://visitor-contact-email-footer--liberty-qr-353.netlify.app/api/footer", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ lead: "Preview", email: "preview@libertyretail.com.au", linkText: "link" }) });
  const blocked = await fn(previewReq, { deploy: { context: "production" } });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /preview/);
  const still = await j(H.call("GET", "/api/footer"));
  assert.equal(still.body.lead, footer.FOOTER_LEAD, "preview POST does not write");
});
