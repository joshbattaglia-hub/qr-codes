// Shared Express Help footer. Every HTML page includes <script src="/footer.js" defer></script>
// (a test enforces this), and server-rendered pages use netlify/lib/footer.mjs with the same text.
(function () {
  if (document.querySelector("footer.eh-footer")) return;
  var style = document.createElement("style");
  style.textContent = ".eh-footer{margin:24px auto 16px;padding:0 16px;max-width:960px;text-align:center;font:12px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;color:#667085}"
    + ".eh-footer a{color:inherit;text-decoration:underline;text-underline-offset:2px}"
    + ".eh-footer a:hover,.eh-footer a:focus{color:#1f4bdb}"
    + ".eh-footer .eh-car{font-family:\"Segoe UI Symbol\",\"Noto Sans Symbols 2\",\"Noto Sans Symbols\",\"Apple Symbols\",\"DejaVu Sans\",sans-serif;font-variant-emoji:text}"
    + "@media print{.eh-footer{display:none}}";
  document.head.appendChild(style);
  var footer = document.createElement("footer");
  footer.className = "eh-footer";
  footer.setAttribute("data-testid", "eh-footer");
  footer.appendChild(document.createTextNode("Built, not bought, by J.Batt "));
  var car = document.createElement("span");
  car.className = "eh-car";
  car.setAttribute("role", "img");
  car.setAttribute("aria-label", "racing car");
  car.textContent = "\u{1F3CE}\uFE0E";
  footer.appendChild(car);
  footer.appendChild(document.createTextNode(" \u2014 need changes? "));
  var link = document.createElement("a");
  link.href = "mailto:jbattaglia@libertyretail.com.au";
  link.textContent = "email me here";
  footer.appendChild(link);
  document.body.appendChild(footer);
})();
