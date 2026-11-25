/* Site picker for the visitor sign-in forms: type-ahead search plus "Use my location".
   Plain ES5 so it runs on older phones and the lounge browser.
   Privacy: location is asked for only when the button is tapped, used in this browser to sort sites by distance,
   and never sent anywhere or stored. Only the chosen site's id goes with the sign-in. */
(function () {
  "use strict";
  var roots = document.querySelectorAll("[data-site-pick]");
  if (!roots.length) return;
  // One shared copy of the site list for every picker on the page (sign-in and sign-out on /visit).
  var shared = { sites: [], withCoords: 0, ready: false, waiting: [] };
  function failLoad() {
    shared.failed = true;
    shared.sites = [];
    shared.withCoords = 0;
    shared.ready = true;
    for (var r = 0; r < roots.length; r++) roots[r].setAttribute("data-ready", "error");
    for (var j = 0; j < shared.waiting.length; j++) shared.waiting[j]();
  }
  function loadShared() {
    if (!window.fetch) return;
    fetch("/api/visit/sites", { credentials: "same-origin" }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || !Array.isArray(data.sites)) { failLoad(); return; }
        shared.sites = data.sites;
        shared.withCoords = data.withCoordinates || 0;
        for (var i = 0; i < shared.sites.length; i++) shared.sites[i]._hay = " " + norm([shared.sites[i].name, shared.sites[i].loc, shared.sites[i].suburb, shared.sites[i].address, shared.sites[i].tradingName].join(" "));
        shared.ready = true;
        for (var j = 0; j < shared.waiting.length; j++) shared.waiting[j]();
      }, function () { failLoad(); });
    })["catch"](function () { failLoad(); });
  }
  function norm(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/^\s+|\s+$/g, ""); }
  for (var r = 0; r < roots.length; r++) init(roots[r]);
  loadShared();

  function init(root) {
  var pick = function (name) { return root.querySelector("[data-sp=" + name + "]"); };
  var input = pick("q");
  var list = pick("options");
  var hidden = root.querySelector("input[name=siteId]");
  var card = pick("card");
  var nearBtn = pick("near");
  var nearNote = pick("near-note");
  var nearList = pick("near-list");
  var optPrefix = (input.id || "site-q") + "-opt-";
  var sites = shared.sites;
  var withCoords = 0;
  var shown = [];
  var active = -1;
  var chosen = null;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function typeInfo(type) {
    if (type === "commission_agent") return { cls: "agent", label: "LOC CA" };
    if (type === "unattended") return { cls: "unattended", label: "Unattended" };
    return { cls: "company", label: "VEA Retail" };
  }
  function label(site) { return site.name + (site.loc ? " (" + site.loc + ")" : ""); }
  function sub(site) { return [site.loc, site.suburb].filter(Boolean).join(" · "); }

  function typeLabel(site) {
    if (site.type === "commission_agent") return "LOC CA";
    if (site.type === "unattended") return "Unattended";
    return "VEA Retail";
  }
  function typeClass(site) {
    if (site.type === "commission_agent") return "agent";
    if (site.type === "unattended") return "unattended";
    return "company";
  }

  function setEmptyMode(empty) {
    root.setAttribute("data-empty", empty ? "1" : "0");
    if (nearBtn) nearBtn.hidden = !!empty;
    var privacy = root.querySelector(".near-privacy");
    if (privacy) privacy.hidden = !!empty;
    if (nearList) nearList.hidden = !!empty;
    if (nearNote) nearNote.hidden = !!empty;
    var emptyNote = root.querySelector(".site-pick-empty-note");
    if (emptyNote) emptyNote.hidden = !empty;
    var lab = input && input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    if (lab && !lab.getAttribute("data-full-label")) lab.setAttribute("data-full-label", lab.innerHTML);
    if (empty) {
      input.removeAttribute("role");
      input.removeAttribute("aria-autocomplete");
      input.removeAttribute("aria-expanded");
      input.removeAttribute("aria-controls");
      if (lab) {
        var hint = input.required ? "Type the site name or number." : "Optional. Type the site name or number.";
        lab.innerHTML = "<span class=\"muted\">" + hint + "</span>";
      }
    } else {
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", "false");
      if (list && list.id) input.setAttribute("aria-controls", list.id);
      if (lab && lab.getAttribute("data-full-label")) lab.innerHTML = lab.getAttribute("data-full-label");
    }
  }

  shared.waiting.push(function () {
    sites = shared.sites; withCoords = shared.withCoords;
    if (shared.failed) {
      setEmptyMode(false);
      if (nearNote) {
        nearNote.hidden = false;
        nearNote.textContent = "The site list could not be loaded. Type the site name, or try again in a moment.";
      }
    } else {
      setEmptyMode(!sites.length);
      root.setAttribute("data-ready", "1");
    }
    if (input.value && !chosen) search();
  });

  function search() {
    var q = norm(input.value);
    shown = [];
    if (q.length >= 1 && sites.length) {
      var words = q.split(" ");
      var scored = [];
      for (var i = 0; i < sites.length; i++) {
        var s = sites[i], hay = s._hay, ok = true;
        for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) < 0) { ok = false; break; }
        if (!ok) continue;
        var name = " " + norm(s.name);
        var score = norm(s.loc) === q ? 0 : name.indexOf(" " + q) === 0 ? 1 : name.indexOf(" " + words[0]) >= 0 ? 2 : hay.indexOf(" " + words[0]) >= 0 ? 3 : 4;
        scored.push({ s: s, score: score });
      }
      scored.sort(function (a, b) { return a.score - b.score || (a.s.name < b.s.name ? -1 : 1); });
      for (var j = 0; j < scored.length && j < 8; j++) shown.push(scored[j].s);
    }
    active = -1;
    paintOptions();
  }

  function paintOptions() {
    list.innerHTML = "";
    if (!shown.length) {
      var q = norm(input.value);
      if (q && sites.length) {
        list.appendChild(el("li", "site-none", "No listed site matches. You can keep what you typed."));
        list.hidden = false; input.setAttribute("aria-expanded", "true");
      } else { list.hidden = true; input.setAttribute("aria-expanded", "false"); }
      input.removeAttribute("aria-activedescendant");
      return;
    }
    for (var i = 0; i < shown.length; i++) {
      var li = el("li", "site-option" + (i === active ? " active" : ""));
      li.id = optPrefix + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      li.setAttribute("data-index", String(i));
      li.appendChild(el("strong", "", shown[i].name));
      var meta = sub(shown[i]);
      if (meta) li.appendChild(el("span", "muted", meta));
      list.appendChild(li);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", optPrefix + active); else input.removeAttribute("aria-activedescendant");
  }

  function close() { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; }

  function row(dl, term, value, href) {
    if (!value) return;
    dl.appendChild(el("dt", "", term));
    var dd = el("dd");
    if (href) { var a = el("a", "", value); a.href = href; dd.appendChild(a); } else dd.textContent = value;
    dl.appendChild(dd);
  }

  function choose(site) {
    chosen = site;
    hidden.value = site.id;
    input.value = label(site);
    close();
    card.innerHTML = "";
    var head = el("div", "site-card-head");
    head.appendChild(el("h3", "", site.name));
    var info = typeInfo(site.type);
    head.appendChild(el("span", "site-type " + info.cls, info.label));
    card.appendChild(head);
    var dl = el("dl");
    row(dl, "Trading name", site.tradingName);
    row(dl, "ABN", site.abn);
    row(dl, "Address", site.address);
    row(dl, "Phone", site.phone, site.phoneHref);
    row(dl, "Email", site.contactEmail, site.contactEmailHref);
    if (dl.childNodes.length) card.appendChild(dl);
    if (site.type === "commission_agent") card.appendChild(el("p", "muted small", "This site is run by an independently owned commission agent."));
    if (site.proposed) card.appendChild(el("p", "muted small", "Preview only. This site is not on the live list yet."));
    card.hidden = false;
    root.setAttribute("data-chosen", site.type);
  }

  function unchoose() {
    if (!chosen) return;
    chosen = null; hidden.value = ""; card.hidden = true; card.innerHTML = ""; root.removeAttribute("data-chosen");
  }

  input.addEventListener("input", function () {
    if (chosen && input.value !== label(chosen)) unchoose();
    search();
  });
  input.addEventListener("focus", function () { if (!chosen && input.value) search(); });
  input.addEventListener("keydown", function (e) {
    var key = e.key || e.keyCode;
    if ((key === "ArrowDown" || key === 40) && shown.length) { e.preventDefault(); active = (active + 1) % shown.length; paintOptions(); }
    else if ((key === "ArrowUp" || key === 38) && shown.length) { e.preventDefault(); active = active <= 0 ? shown.length - 1 : active - 1; paintOptions(); }
    else if ((key === "Enter" || key === 13) && !list.hidden && shown.length) { e.preventDefault(); choose(shown[active >= 0 ? active : 0]); }
    else if (key === "Escape" || key === 27) { if (!list.hidden) { e.preventDefault(); close(); } }
  });
  // mousedown (not click) so the choice lands before the input loses focus
  list.addEventListener("mousedown", function (e) {
    var t = e.target;
    while (t && t !== list && !t.getAttribute("data-index")) t = t.parentNode;
    if (t && t !== list) { e.preventDefault(); choose(shown[Number(t.getAttribute("data-index"))]); }
  });
  input.addEventListener("blur", function () { setTimeout(close, 150); });

  function km(a, b) {
    var rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function showNearest(here) {
    var ranked = [];
    for (var i = 0; i < sites.length; i++) if (sites[i].lat != null) ranked.push({ s: sites[i], d: km(here, sites[i]) });
    ranked.sort(function (a, b) { return a.d - b.d; });
    nearList.innerHTML = "";
    if (!ranked.length) { nearNote.textContent = "Nearest-site matching is not set up yet. Search for your site below."; return; }
    nearNote.textContent = "Closest sites to you. Tap yours:";
    for (var j = 0; j < ranked.length && j < 3; j++) {
      (function (item) {
        var b = el("button", "site-near-item");
        b.type = "button";
        b.appendChild(el("strong", "", item.s.name));
        b.appendChild(el("span", "muted", (item.d < 10 ? item.d.toFixed(1) : Math.round(item.d)) + " km" + (item.s.suburb ? " · " + item.s.suburb : "")));
        b.addEventListener("click", function () { choose(item.s); nearList.innerHTML = ""; nearNote.textContent = ""; });
        nearList.appendChild(b);
      })(ranked[j]);
    }
  }

  nearBtn.addEventListener("click", function () {
    nearList.innerHTML = "";
    if (shared.failed || !shared.ready) { nearNote.textContent = "The site list could not be loaded. Type the site name, or try again in a moment."; return; }
    if (!sites.length) { nearNote.textContent = "No listed sites are set up for location matching. Type the site name."; return; }
    if (!navigator.geolocation) { nearNote.textContent = "This browser cannot share location. Search for your site below."; return; }
    if (sites.length && !withCoords) { nearNote.textContent = "Nearest-site matching is not set up yet. Search for your site below."; return; }
    nearNote.textContent = "Finding sites near you…";
    nearBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      nearBtn.disabled = false;
      // Used here only; not kept, not sent.
      showNearest({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    }, function (err) {
      nearBtn.disabled = false;
      nearNote.textContent = err && err.code === 1 ? "Location is off for this page. Search for your site below." : "Your location could not be found. Search for your site below.";
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });

  }
})();
