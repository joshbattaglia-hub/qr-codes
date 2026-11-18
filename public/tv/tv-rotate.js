/* Optional second screen for the Truckies Lounge TV: add ?key=<TV link key> (and optionally &rotate=30) to the TV address and the page
 * alternates between the lounge screen and the support tickets screen. Without a key this file does nothing, so the plain TV address
 * behaves exactly as before. ES5 for signage browsers. */
(function () {
  "use strict";
  function param(name) {
    var parts = (window.location.search || "").replace(/^\?/, "").split("&");
    for (var i = 0; i < parts.length; i++) { var kv = parts[i].split("="); if (decodeURIComponent(kv[0] || "") === name) return decodeURIComponent((kv[1] || "").replace(/\+/g, " ")); }
    return null;
  }
  var key = param("key");
  if (!key || !window.EHTicketsTV) return;
  var raw = param("rotate");
  var rotate = raw === null || raw === "" ? 30 : Number(raw);
  if (!(rotate >= 0)) rotate = 30;
  if (rotate === 0) return;
  rotate = Math.max(10, Math.min(300, Math.floor(rotate)));

  var overlay = document.createElement("div");
  overlay.className = "tt-screen tt-overlay";
  overlay.id = "tickets-screen";
  document.body.appendChild(overlay);
  var tickets = window.EHTicketsTV.create({ root: overlay, key: key });
  tickets.start();

  var pageTimer = null;
  function hide() { if (pageTimer) { clearInterval(pageTimer); pageTimer = null; } overlay.style.display = "none"; }
  function showTickets() {
    var pages = tickets.pages();
    var step = Math.max(6000, Math.floor(rotate * 1000 / pages));
    tickets.setPage(0);
    overlay.style.display = "block";
    if (pages > 1) { pageTimer = setInterval(function () { tickets.nextPage(); }, step); }
    return step * pages;
  }
  function toLounge() { hide(); setTimeout(toTickets, rotate * 1000); }
  function toTickets() {
    /* Nothing to show (no data yet, or the link was switched off): stay on the lounge screen and check again later. */
    if (!tickets.ready()) { setTimeout(toTickets, rotate * 1000); return; }
    var stay = showTickets();
    setTimeout(toLounge, stay);
  }
  setTimeout(toTickets, rotate * 1000);
})();
