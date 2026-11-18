/* Tickets-only TV page: /tv/support-tickets?key=...  Pages through the columns every 12 seconds, refreshes every minute. ES5 for signage browsers. */
(function () {
  "use strict";
  var PAGE_MS = 12 * 1000;
  var RELOAD_MS = 6 * 60 * 60 * 1000;
  function param(name) {
    var parts = (window.location.search || "").replace(/^\?/, "").split("&");
    for (var i = 0; i < parts.length; i++) { var kv = parts[i].split("="); if (decodeURIComponent(kv[0] || "") === name) return decodeURIComponent((kv[1] || "").replace(/\+/g, " ")); }
    return "";
  }
  window.onerror = function () { return true; };
  var screen = window.EHTicketsTV.create({ root: document.getElementById("tt-root"), key: param("key") });
  screen.start();
  setInterval(function () { screen.nextPage(); }, PAGE_MS);
  /* Clear memory on long-running players: reload every few hours, but only when the site answers. */
  function maybeReload() {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () { if (xhr.readyState !== 4) return; if (xhr.status === 200) window.location.reload(); else setTimeout(maybeReload, 10 * 60 * 1000); };
    try { xhr.open("GET", window.location.pathname + "?ping=" + Date.now(), true); xhr.send(); } catch (e) { setTimeout(maybeReload, 10 * 60 * 1000); }
  }
  setTimeout(maybeReload, RELOAD_MS);
})();
