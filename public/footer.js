// Shared Express Help footer. Every HTML page includes <script src="/footer.js" defer></script>
// (a test enforces this), and server-rendered pages and emails use netlify/lib/footer.mjs with the same text.
(function () {
  if (document.querySelector("footer.eh-footer")) return;
  var style = document.createElement("style");
  style.textContent = ".eh-footer{margin:24px auto 16px;padding:0 16px;max-width:960px;text-align:center;font:11px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;color:#667085}"
    + ".eh-footer a{color:inherit;text-decoration:underline;text-underline-offset:2px}"
    + ".eh-footer a:hover,.eh-footer a:focus{color:#1f4bdb}"
    + "@media print{.eh-footer{display:none}}";
  document.head.appendChild(style);
  var footer = document.createElement("footer");
  footer.className = "eh-footer";
  footer.setAttribute("data-testid", "eh-footer");
  footer.appendChild(document.createTextNode("Cowabunga - please hesitate to reach out "));
  var link = document.createElement("a");
  link.href = "mailto:jbattaglia@libertyretail.com.au";
  link.textContent = "email me here";
  footer.appendChild(link);
  document.body.appendChild(footer);
})();
