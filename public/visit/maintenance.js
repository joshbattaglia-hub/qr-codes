// Maintenance phone numbers on the "Thanks for signing in" screen. Hidden until at least one number is set.
(function () {
  const box = document.getElementById("maintenance-contacts");
  const list = document.getElementById("maintenance-list");
  if (!box || !list) return;
  fetch("/api/visit/contacts", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : { contacts: [] }))
    .then((body) => {
      const contacts = (Array.isArray(body && body.contacts) ? body.contacts : []).slice(0, 4).filter((row) =>
        row && typeof row.label === "string" && typeof row.display === "string" && /^tel:\+?[0-9]{6,15}$/.test(String(row.href || "")));
      list.textContent = "";
      for (const row of contacts) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = row.href;
        link.setAttribute("data-testid", "visit-maintenance-line");
        const label = document.createElement("span");
        label.textContent = row.label;
        const number = document.createElement("strong");
        number.textContent = row.display;
        link.append(label, number);
        item.append(link);
        list.append(item);
      }
      box.hidden = contacts.length === 0;
    })
    .catch(() => { box.hidden = true; });
})();
