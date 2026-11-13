/* Truckies Lounge TV. Plain ES5 for slow signage browsers: no framework, no fetch, no arrow functions. */
(function () {
  "use strict";
  var REFRESH_MS = 5 * 60 * 1000;
  var RETRY_MS = 60 * 1000;
  var PAGE_MS = 12 * 1000;
  var RELOAD_MS = 6 * 60 * 60 * 1000;
  var PER_PAGE = 5;
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Freezing fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Storm with hail", 99: "Storm with hail" };
  var COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  var query = buildQuery();
  var CACHE_KEY = "tv-truckies-lounge:" + query;
  var state = { data: null, receivedAt: 0, offline: false, page: 0, offset: guessOffset() };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function buildQuery() {
    var out = [];
    var search = (window.location.search || "").replace(/^\?/, "").split("&");
    for (var i = 0; i < search.length; i++) {
      var kv = search[i].split("=");
      var key = decodeURIComponent(kv[0] || "");
      if (key === "site" || key === "lat" || key === "lng" || key === "label") out.push(encodeURIComponent(key) + "=" + encodeURIComponent(decodeURIComponent((kv[1] || "").replace(/\+/g, " "))));
    }
    return out.join("&");
  }

  function guessOffset() {
    // Melbourne is UTC+10 or UTC+11 (daylight saving). The server sends the exact offset with each update.
    try {
      var parts = new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":");
      var now = new Date();
      var diff = (Number(parts[0]) % 24) * 60 + Number(parts[1]) - (now.getUTCHours() * 60 + now.getUTCMinutes());
      if (diff < 0) diff += 1440;
      if (diff === 600 || diff === 660) return diff;
    } catch (e) { /* old browser */ }
    return 600;
  }

  function melbourneNow() { return new Date(Date.now() + state.offset * 60000); }
  function clockText(d) {
    var h = d.getUTCHours();
    return (h % 12 || 12) + ":" + pad(d.getUTCMinutes()) + (h < 12 ? " am" : " pm");
  }
  function tick() {
    var d = melbourneNow();
    $("time").innerHTML = esc(clockText(d));
    $("date").innerHTML = esc(DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear());
  }
  function stamp(iso) {
    var t = Date.parse(iso);
    if (!t) return "";
    var d = new Date(t + state.offset * 60000);
    return DAYS[d.getUTCDay()] + " " + clockText(d);
  }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return "";
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  }
  function n(v, unit) { return v == null || isNaN(v) ? "–" : Math.round(v) + (unit || ""); }

  function renderNews() {
    var items = (state.data && state.data.news && state.data.news.items) || [];
    var box = $("news");
    if (!items.length) { box.innerHTML = '<li><div class="h">Headlines are unavailable right now.</div><div class="s">They will come back automatically.</div></li>'; $("pager").innerHTML = ""; return; }
    var pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
    if (state.page >= pages) state.page = 0;
    var html = "";
    for (var i = state.page * PER_PAGE; i < Math.min(items.length, (state.page + 1) * PER_PAGE); i++) {
      var it = items[i];
      html += '<li><div class="h">' + esc(it.title) + '</div><div class="s">' + esc(it.source) + (it.publishedAt ? ' <span>· ' + esc(ago(it.publishedAt)) + "</span>" : "") + "</div></li>";
    }
    box.innerHTML = html;
    $("pager").innerHTML = pages > 1 ? esc((state.page + 1) + " / " + pages) : "";
  }

  function renderWeather() {
    var w = state.data && state.data.weather;
    var box = $("weather");
    if (!w || !w.current) { box.innerHTML = '<div class="note">Weather is unavailable right now. It will come back automatically.</div>' + warningsHtml(); return; }
    var c = w.current;
    var html = '<div class="now"><div class="temp">' + n(c.temp, "°") + '</div><div class="cond">' + esc(WMO[c.code] || "—") + '</div>'
      + '<div class="meta">Feels like ' + n(c.feelsLike, "°") + " · Humidity " + n(c.humidity, "%") + "<br>Wind " + (c.windDir == null ? "" : COMPASS[Math.round(c.windDir / 45) % 8] + " ") + n(c.wind, " km/h") + (c.gusts ? " · gusts " + n(c.gusts, " km/h") : "") + "</div></div>";
    html += '<div class="days">';
    var days = w.daily || [];
    for (var i = 0; i < Math.min(4, days.length); i++) {
      var d = days[i];
      var parts = String(d.date).split("-");
      var label = i === 0 ? "Today" : DAYS[new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay()];
      html += '<div class="day"><div class="d">' + esc(label) + '</div><div class="c">' + esc(WMO[d.code] || "") + '</div><div class="t">' + n(d.max, "°") + ' <span>' + n(d.min, "°") + '</span></div><div class="r">' + (d.rainChance == null ? "&nbsp;" : "Rain " + n(d.rainChance, "%")) + "</div></div>";
    }
    html += "</div>" + warningsHtml();
    box.innerHTML = html;
  }

  function warningsHtml() {
    var w = state.data && state.data.warnings;
    if (!w) return "";
    if (w.items && w.items.length) {
      var top = w.items[0];
      return '<div class="warn alert">WARNING · ' + esc(top.level ? top.level + ": " : "") + esc(top.title) + (top.location ? " — " + esc(top.location) : "") + " (" + esc(top.km) + " km)" + (w.items.length > 1 ? " +" + (w.items.length - 1) + " more" : "") + "</div>";
    }
    return w.note ? '<div class="warn">' + esc(w.note) + "</div>" : "";
  }

  function renderSites() {
    var s = state.data && state.data.sites;
    var box = $("sites");
    if (!s) { box.innerHTML = '<div class="note">Site list is unavailable right now.</div>'; return; }
    if (!s.items || !s.items.length) { box.innerHTML = '<div class="note">' + esc(s.note || "No nearby sites to show.") + "</div>"; return; }
    var html = "<table>";
    for (var i = 0; i < s.items.length; i++) {
      var it = s.items[i];
      var flags = (it.diesel ? '<span class="flag">DIESEL</span>' : "") + (it.truckAccess ? '<span class="flag">TRUCKS</span>' : "");
      html += "<tr><td>" + esc(it.name) + flags + (it.suburb && it.suburb !== it.name ? '<span class="sub">' + esc(it.suburb) + "</span>" : "") + '</td><td class="km">' + esc(it.km < 10 ? it.km.toFixed(1) : Math.round(it.km)) + " km</td></tr>";
    }
    box.innerHTML = html + "</table>";
  }

  function renderHeader() {
    var loc = state.data && state.data.location;
    if (!loc) return;
    var note = loc.notes && loc.notes.length ? ' <span class="muted">· ' + esc(loc.notes.join(" ")) + "</span>" : "";
    $("where").innerHTML = esc(loc.label) + note;
    $("weather-title").innerHTML = "Weather · " + esc(loc.label);
    if (state.data.attribution) $("attrib").innerHTML = esc(state.data.attribution);
  }

  function renderStatus() {
    var el = $("status");
    if (!state.data) { el.className = "status"; el.innerHTML = "Waiting for the first update…"; return; }
    var when = stamp(state.data.generatedAt);
    el.className = state.offline ? "status offline" : "status";
    el.innerHTML = state.offline ? "Offline — showing the last update from " + esc(when) + ". Retrying automatically." : "Last updated " + esc(when);
  }

  function renderAll() {
    try { renderHeader(); } catch (e) {}
    try { renderNews(); } catch (e) {}
    try { renderWeather(); } catch (e) {}
    try { renderSites(); } catch (e) {}
    try { renderStatus(); } catch (e) {}
  }

  function save(data) { try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* storage full or disabled */ } }
  function load() { try { var raw = window.localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

  function accept(data) {
    state.data = data;
    state.offline = false;
    if (typeof data.melbourneOffsetMinutes === "number" && data.melbourneOffsetMinutes >= 480 && data.melbourneOffsetMinutes <= 720) state.offset = data.melbourneOffsetMinutes;
    save(data);
    renderAll();
  }

  function refresh() {
    var xhr = new XMLHttpRequest();
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; try { xhr.abort(); } catch (e) {} fail(); } }, 30000);
    function fail() { state.offline = true; renderStatus(); setTimeout(refresh, RETRY_MS); }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || done) return;
      done = true;
      clearTimeout(timer);
      var data = null;
      if (xhr.status === 200) { try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; } }
      if (data && data.generatedAt) { accept(data); setTimeout(refresh, REFRESH_MS); } else fail();
    };
    try { xhr.open("GET", "/api/tv/truckies-lounge" + (query ? "?" + query : ""), true); xhr.send(); } catch (e) { done = true; clearTimeout(timer); fail(); }
  }

  /* Reload the page every few hours to clear memory on long-running players, but only when the site answers. */
  function maybeReload() {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200) window.location.reload();
      else setTimeout(maybeReload, 10 * 60 * 1000);
    };
    try { xhr.open("GET", window.location.pathname + "?ping=" + Date.now(), true); xhr.send(); } catch (e) { setTimeout(maybeReload, 10 * 60 * 1000); }
  }

  window.onerror = function () { return true; };
  var cached = load();
  if (cached) { state.data = cached; state.offline = true; if (typeof cached.melbourneOffsetMinutes === "number") state.offset = cached.melbourneOffsetMinutes; }
  tick();
  renderAll();
  if (cached) { $("status").innerHTML = "Showing the last update from " + esc(stamp(cached.generatedAt)) + " while refreshing…"; }
  setInterval(tick, 1000);
  setInterval(function () { state.page += 1; try { renderNews(); } catch (e) {} }, PAGE_MS);
  setInterval(function () { try { renderStatus(); } catch (e) {} }, 60000);
  setTimeout(maybeReload, RELOAD_MS);
  refresh();
})();
