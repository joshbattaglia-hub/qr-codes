/* Support tickets screen for the work TV. Plain ES5 for slow signage browsers (Fire TV Silk): no fetch, no arrow functions, no modules.
 * Read-only. The data comes from /api/tv/tickets, behind the TV link key that is in this page's address (?key=). It is never written
 * anywhere by this script except the sanitised payload cached in localStorage, so a restart or short outage still shows the last good screen. */
(function () {
  "use strict";
  var COLS = [
    { id: "submitted", label: "Submitted" },
    { id: "needs-info", label: "Needs more info" },
    { id: "in-progress", label: "In progress" },
    { id: "done", label: "Done (last 24h)" }
  ];
  var PER_COL = 5;
  var REFRESH_MS = 60 * 1000;
  var RETRY_MS = 30 * 1000;
  var CACHE_KEY = "tv-tickets-cache";
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function guessOffset() {
    try {
      var parts = new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":");
      var now = new Date();
      var diff = (Number(parts[0]) % 24) * 60 + Number(parts[1]) - (now.getUTCHours() * 60 + now.getUTCMinutes());
      if (diff < 0) diff += 1440;
      if (diff === 600 || diff === 660) return diff;
    } catch (e) { /* old browser */ }
    return 600;
  }
  function clockText(d) { var h = d.getUTCHours(); return (h % 12 || 12) + ":" + pad(d.getUTCMinutes()) + (h < 12 ? " am" : " pm"); }

  /** opts: { root: element, key: string, full: bool (standalone page), onState: function } */
  function create(opts) {
    var root = opts.root;
    var state = { data: null, offline: false, revoked: false, page: 0, offset: guessOffset(), receivedAt: 0 };
    var cols = {};
    var elTime, elDate, elSummary, elStatus, elPager, elMain;

    function build() {
      root.innerHTML =
        '<div class="tt-top"><div class="tt-brand"><img src="/brand/logo-mark-dark.svg" alt="" width="64" height="64">Liberty <span class="tt-sub">Support tickets</span></div>'
        + '<div class="tt-summary" data-tt="summary">&nbsp;</div>'
        + '<div class="tt-clock"><div class="tt-time" data-tt="time">--:--</div><div class="tt-date" data-tt="date">&nbsp;</div></div></div>'
        + '<div class="tt-main" data-tt="main"></div>'
        + '<div class="tt-bottom"><div class="tt-status" data-tt="status">Starting…</div><div class="tt-pager" data-tt="pager"></div></div>';
      function q(name) { var all = root.getElementsByTagName("div"); for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-tt") === name) return all[i]; return null; }
      elTime = q("time"); elDate = q("date"); elSummary = q("summary"); elStatus = q("status"); elPager = q("pager"); elMain = q("main");
    }

    function melbourneNow() { return new Date(Date.now() + state.offset * 60000); }
    function tick() {
      var d = melbourneNow();
      elTime.innerHTML = esc(clockText(d));
      elDate.innerHTML = esc(DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear());
    }

    function byColumn(id) {
      var out = [], rows = (state.data && state.data.tickets) || [];
      for (var i = 0; i < rows.length; i++) if (rows[i].column === id) out.push(rows[i]);
      return out;
    }
    function pageCount() {
      var max = 1;
      for (var i = 0; i < COLS.length; i++) max = Math.max(max, Math.ceil(byColumn(COLS[i].id).length / PER_COL));
      return max;
    }
    function cardHtml(t) {
      var chips = "";
      if (t.overdue) chips += '<span class="tt-chip tt-bad">OVERDUE</span>';
      if (t.priority === "urgent") chips += '<span class="tt-chip tt-bad">URGENT</span>';
      else if (t.priority === "high") chips += '<span class="tt-chip tt-hi">HIGH</span>';
      var bits = [];
      if (t.site) bits.push(esc(t.site));
      if (t.queue) bits.push(esc(t.queue));
      if (t.firstName) bits.push(esc(t.firstName));
      if (t.column === "done") bits.push(t.doneHoursAgo < 1 ? "done just now" : "done " + t.doneHoursAgo + "h ago");
      else bits.push(t.daysOpen < 1 ? "opened today" : t.daysOpen + (t.daysOpen === 1 ? " day open" : " days open"));
      return '<div class="tt-card"><div class="tt-line"><span class="tt-num">#' + esc(t.number) + "</span>" + chips + '</div><div class="tt-subj">' + esc(t.subject) + '</div><div class="tt-meta">' + bits.join(" · ") + "</div></div>";
    }
    function render() {
      var data = state.data;
      if (!data) { elSummary.innerHTML = "&nbsp;"; elMain.innerHTML = '<div class="tt-allclear"><div class="tt-small">Waiting for the first update…</div></div>'; return; }
      var pages = pageCount();
      if (state.page >= pages) state.page = 0;
      var open = data.counts["submitted"] + data.counts["needs-info"] + data.counts["in-progress"];
      elSummary.innerHTML = "<b>" + open + "</b> open" + (data.overdue ? ' · <span class="tt-od">' + data.overdue + " overdue</span>" : "") + (data.counts.done ? " · " + data.counts.done + " done today" : "");
      if (!data.tickets.length) {
        elMain.innerHTML = '<div class="tt-allclear"><div class="tt-big">All clear</div><div class="tt-small">No open support tickets right now.</div></div>';
        elPager.innerHTML = "";
        return;
      }
      var html = "";
      for (var c = 0; c < COLS.length; c++) {
        var all = byColumn(COLS[c].id);
        var start = state.page * PER_COL;
        var slice = all.slice(start, start + PER_COL);
        var inner = "";
        for (var i = 0; i < slice.length; i++) inner += cardHtml(slice[i]);
        if (!slice.length) inner = '<div class="tt-empty">' + (all.length ? "" : "Nothing here") + "</div>";
        html += '<div class="tt-col st-' + COLS[c].id + (c === COLS.length - 1 ? " tt-last" : "") + '"><div class="tt-head"><span class="tt-n">' + data.counts[COLS[c].id] + "</span>" + esc(COLS[c].label) + '</div><div class="tt-cards">' + inner + "</div></div>";
      }
      elMain.innerHTML = html;
      elPager.innerHTML = pages > 1 ? "Page " + (state.page + 1) + " of " + pages + (data.truncated ? " · showing the first " + data.tickets.length : "") : "";
    }
    function renderStatus() {
      var when = "";
      if (state.data) { var d = new Date(Date.parse(state.data.generatedAt) + state.offset * 60000); when = clockText(d); }
      if (state.revoked) { elStatus.className = "tt-status tt-offline"; elStatus.innerHTML = "This TV link is no longer valid. Ask for a new one in Support settings."; return; }
      if (!state.data) { elStatus.className = "tt-status"; elStatus.innerHTML = "Waiting for the first update…"; return; }
      elStatus.className = state.offline ? "tt-status tt-offline" : "tt-status";
      elStatus.innerHTML = state.offline ? "Offline: showing the last update from " + esc(when) + ". Retrying automatically." : "Updated " + esc(when);
    }
    function changed() { if (typeof opts.onState === "function") { try { opts.onState(api); } catch (e) { /* never break the screen */ } } }

    function save(data) { try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* disabled or full */ } }
    function load() { try { var raw = window.localStorage.getItem(CACHE_KEY); var d = raw ? JSON.parse(raw) : null; return d && d.generatedAt && d.tickets && d.counts ? d : null; } catch (e) { return null; } }
    function forget() { try { window.localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ } }

    function refresh() {
      if (state.revoked) return;
      var xhr = new XMLHttpRequest();
      var done = false;
      function fail() { state.offline = true; renderStatus(); changed(); setTimeout(refresh, RETRY_MS); }
      var timer = setTimeout(function () { if (!done) { done = true; try { xhr.abort(); } catch (e) {} fail(); } }, 30000);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || done) return;
        done = true; clearTimeout(timer);
        if (xhr.status === 401) { state.revoked = true; state.data = null; forget(); render(); renderStatus(); changed(); return; }
        var data = null;
        if (xhr.status === 200) { try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; } }
        if (data && data.generatedAt && data.tickets && data.counts) {
          state.data = data; state.offline = false; state.receivedAt = Date.now(); save(data);
          render(); renderStatus(); changed(); setTimeout(refresh, REFRESH_MS);
        } else fail();
      };
      try { xhr.open("GET", "/api/tv/tickets?key=" + encodeURIComponent(opts.key || ""), true); xhr.send(); } catch (e) { done = true; clearTimeout(timer); fail(); }
    }

    var api = {
      state: state,
      /** True when there is something worth showing (live or last good data). */
      ready: function () { return !!state.data && !state.revoked; },
      pages: function () { return state.data ? pageCount() : 1; },
      setPage: function (n) { state.page = n; try { render(); } catch (e) {} },
      nextPage: function () { state.page += 1; try { render(); } catch (e) {} },
      render: function () { try { render(); renderStatus(); } catch (e) {} },
      start: function () {
        build();
        var cached = load();
        if (cached) { state.data = cached; state.offline = true; }
        tick(); render(); renderStatus();
        setInterval(tick, 1000);
        setInterval(function () { try { renderStatus(); } catch (e) {} }, 60000);
        refresh();
        changed();
      }
    };
    return api;
  }
  window.EHTicketsTV = { create: create, PER_COL: PER_COL };
})();
