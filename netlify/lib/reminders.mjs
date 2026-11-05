import { addDays } from "./lib.mjs";
import { melbourneDate, nextDrawDate, periodCount } from "./competitions.mjs";

/** In-app reminders only. Dates are Australia/Melbourne calendar days. */
export function competitionReminders(comp, today = melbourneDate()) {
  if (!comp || comp.status === "draft") return [];
  const items = [];
  const drawn = (comp.winners || []).filter((w) => !w.superseded).length;
  const remaining = Math.max(0, periodCount(comp) - drawn);
  const next = nextDrawDate(comp);
  const href = "#/competitions/" + encodeURIComponent(comp.slug || "");
  const closed = comp.status === "ended" || (!!comp.end && comp.end < today);
  // A closed or ended competition still shows a draw that is actually overdue.
  if (remaining > 0 && next && next < today) items.push({ kind: "overdue-draw", date: next, href, name: comp.name, slug: comp.slug });
  else if (!closed && comp.status === "active" && remaining > 0 && next && next <= addDays(today, 7)) items.push({ kind: "upcoming-draw", date: next, href, name: comp.name, slug: comp.slug });
  if (comp.end && comp.status !== "draft") {
    if (comp.end < today) items.push({ kind: "past-close", date: comp.end, href, name: comp.name, slug: comp.slug });
    else if (comp.status === "active" && comp.end <= addDays(today, 7)) items.push({ kind: "closing", date: comp.end, href, name: comp.name, slug: comp.slug });
  }
  return items;
}
