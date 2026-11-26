import { handleVisitScanEdge } from "../lib/visit-scan-edge.mjs";

export default async (request, context) => handleVisitScanEdge(request, context);

export const config = {
  path: ["/visit/sign-in", "/visit/sign-in/", "/visit/sign-out", "/visit/sign-out/"],
};
