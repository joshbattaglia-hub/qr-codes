import { json } from "../lib/lib.mjs";
import { originBlocked, forbidden } from "../lib/access.mjs";
import { actorFromRequest } from "../lib/identity.mjs";
import { runVisitorCleanup, visitorCapability } from "../lib/visitor-log.mjs";

export default async (req) => {
  const scheduled = (req.headers.get("x-nf-event") || "") === "schedule";
  if (!scheduled) {
    if (originBlocked(req)) return forbidden();
    const actor = await actorFromRequest(req);
    if (!visitorCapability(actor)) return json(401, { error: "Unauthorized" });
  }
  const result = await runVisitorCleanup();
  return json(200, result);
};

export const config = { schedule: "0 16 * * *" };
