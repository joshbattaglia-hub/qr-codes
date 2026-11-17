// Set-password page. The one-time link arrives in the address after "#", which browsers never send to a server or in a Referer.
(function () {
  var token = (location.hash || "").replace(/^#/, "");
  var $ = function (id) { return document.getElementById(id); };
  // Remove the token from the address bar and history straight away.
  try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
  function show(id) { ["sp-form", "sp-done", "sp-bad"].forEach(function (x) { $(x).hidden = x !== id; }); }
  function bad(text) { $("sp-lead").textContent = ""; $("sp-bad-text").textContent = text; show("sp-bad"); }
  function post(path, body) {
    return fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; }); });
  }
  if (!token) { bad("This link is not valid. Ask for a new one."); return; }
  post("/api/identity/password/link", { token: token }).then(function (r) {
    if (!r.ok || !r.data.valid) { bad(r.data.message || r.data.error || "This link is not valid. Ask for a new one."); return; }
    var reset = r.data.kind === "reset";
    $("sp-title").textContent = reset ? "Choose a new password" : "Set your password";
    $("sp-lead").textContent = reset ? "Pick a new password for your Express Help sign-in. Your access does not change." : "Welcome to Express Help. Pick a password to sign in with. You can still use an email code any time.";
    $("sp-email").value = r.data.email;
    show("sp-form");
    $("sp-pw").focus();
  }).catch(function () { bad("Could not check this link. Check your connection and try again."); });
  $("sp-toggle").addEventListener("click", function () {
    var showing = $("sp-pw").type === "password";
    $("sp-pw").type = showing ? "text" : "password";
    $("sp-pw2").type = showing ? "text" : "password";
    $("sp-toggle").textContent = showing ? "Hide" : "Show";
    $("sp-toggle").setAttribute("aria-pressed", String(showing));
  });
  $("sp-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = $("sp-submit");
    if (button.disabled) return;
    var error = $("sp-error");
    error.textContent = "";
    var pw = $("sp-pw").value;
    if (pw.length < 10) { error.textContent = "Use at least 10 characters."; return; }
    if (pw !== $("sp-pw2").value) { error.textContent = "The two passwords are different."; return; }
    var label = button.textContent;
    button.disabled = true; button.textContent = "Saving…"; button.setAttribute("aria-busy", "true");
    post("/api/identity/password/set", { token: token, password: pw }).then(function (r) {
      if (r.ok) { $("sp-lead").textContent = ""; $("sp-done-text").textContent = r.data.message || "Your password is set."; $("sp-pw").value = ""; $("sp-pw2").value = ""; token = ""; show("sp-done"); return; }
      if (r.status === 422 || r.status === 429) { error.textContent = r.data.error || "Not saved."; return; }
      bad(r.data.error || "This link is not valid. Ask for a new one.");
    }).catch(function () { error.textContent = "Could not save. Check your connection and try again."; })
      .then(function () { button.disabled = false; button.textContent = label; button.removeAttribute("aria-busy"); });
  });
})();
