// Shared submit guard for the public visitor forms: the button is disabled with a spinner while a
// submission is in flight, and each submission carries an idempotency key so a repeat (double tap,
// retry after a lost response) returns the original result instead of creating a second visit.
(function () {
  const style = document.createElement("style");
  style.textContent = "button[data-busy]{display:inline-flex;align-items:center;justify-content:center;gap:8px}"
    + ".visit-spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:visit-spin .8s linear infinite}"
    + "@keyframes visit-spin{to{transform:rotate(360deg)}}";
  document.head.appendChild(style);

  function newKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function setBusy(button, busy) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = true;
      button.setAttribute("data-busy", "");
      button.setAttribute("aria-busy", "true");
      button.textContent = "";
      const spin = document.createElement("span");
      spin.className = "visit-spinner";
      spin.setAttribute("aria-hidden", "true");
      button.append(spin, document.createTextNode("Submitting..."));
    } else {
      button.disabled = false;
      button.removeAttribute("data-busy");
      button.removeAttribute("aria-busy");
      button.textContent = button.dataset.label || button.textContent;
    }
  }

  /**
   * form: the <form>; url: API path; build(): async, returns the JSON body or throws Error(message);
   * errorEl: where to show errors; fallback: default error text; done(body): success callback.
   */
  window.visitSubmit = async function (form, { url, build, errorEl, fallback, done }) {
    if (form.dataset.submitting === "1") return;
    form.dataset.submitting = "1";
    const button = form.querySelector('button[type="submit"]');
    if (errorEl) errorEl.textContent = "";
    setBusy(button, true);
    let keepKey = false;
    try {
      const payload = await build();
      if (!form.dataset.idem) form.dataset.idem = newKey();
      payload.idempotencyKey = form.dataset.idem;
      let response;
      try {
        response = await fetch(url, {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        keepKey = true; // outcome unknown: a retry with the same key cannot create a second record
        throw new Error("No connection. Check your signal and try again. Pressing again will not create a duplicate.");
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        keepKey = response.status >= 500 || response.status === 409;
        throw new Error(body.error || fallback);
      }
      delete form.dataset.idem;
      done(body);
    } catch (error) {
      if (!keepKey) delete form.dataset.idem;
      if (errorEl) errorEl.textContent = (error && error.message) || fallback;
      setBusy(button, false);
    } finally {
      form.dataset.submitting = "";
    }
  };
})();
