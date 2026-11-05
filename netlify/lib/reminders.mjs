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
  if (comp.status === "active" && remaining > 0 && next) {
    if (next < today) items.push({ kind: "overdue-draw", date: next, href, name: comp.name, slug: comp.slug });
    else if (next <= addDays(today, 7)) items.push({ kind: "upcoming-draw", date: next, href, name: comp.name, slug: comp.slug });
  }
  if (comp.end) {
    if (comp.end < today && comp.status === "active") items.push({ kind: "past-close", date: comp.end, href, name: comp.name, slug: comp.slug });
    else if (comp.status === "active" && comp.end >= today && comp.end <= addDays(today, 7)) items.push({ kind: "closing", date: comp.end, href, name: comp.name, slug: comp.slug });
  }
  return items;
}
