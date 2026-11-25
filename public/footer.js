// Shared Express Help footer. Every HTML page includes <script src="/footer.js" defer></script>
// (a test enforces this), and server-rendered pages and emails use netlify/lib/footer.mjs with the same defaults.
// Saved wording is loaded from /api/footer; these strings stay as the fallback when that setting is unset.
(function () {
  var DEFAULT_LEAD = "Cowabunga - please hesitate to reach out ";
  var DEFAULT_EMAIL = "jbattaglia@libertyretail.com.au";
  var DEFAULT_LINK = "email me here";
  if (document.querySelector("footer.eh-footer")) return;
  var style = document.createElement("style");
  style.textContent = ".eh-footer{margin:24px auto 16px;padding:0 16px;max-width:960px;text-align:center;font:11px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;color:var(--footer-ink,#667085)}"
    + ".eh-footer a{color:inherit;text-decoration:underline;text-underline-offset:2px}"
    + ".eh-footer a:hover,.eh-footer a:focus{color:var(--footer-hover,#1f4bdb)}"
    + "@media print{.eh-footer{display:none}}";
  document.head.appendChild(style);
  var footer = document.createElement("footer");
  footer.className = "eh-footer";
  footer.setAttribute("data-testid", "eh-footer");
  var leadNode = document.createTextNode(DEFAULT_LEAD);
  footer.appendChild(leadNode);
  var link = document.createElement("a");
  link.href = "mailto:" + DEFAULT_EMAIL;
  link.textContent = DEFAULT_LINK;
  footer.appendChild(link);
  document.body.appendChild(footer);
  fetch("/api/footer", { credentials: "same-origin" }).then(function (res) { return res.ok ? res.json() : null; }).then(function (body) {
    if (!body || !body.email) return;
    var lead = String(body.lead || "").trim() || DEFAULT_LEAD.trim();
    var linkText = String(body.linkText || "").trim() || DEFAULT_LINK;
    var email = String(body.email || "").trim().toLowerCase();
    if (!/^[a-z0-9._%+'’-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return;
    leadNode.nodeValue = lead + " ";
    link.href = "mailto:" + email;
    link.textContent = linkText;
  }).catch(function () {});
})();
