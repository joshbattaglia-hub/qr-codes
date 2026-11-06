import crypto from "node:crypto";

const SITE_ID = /^s[a-f0-9]{8}$/;

function raw(value, max = 240) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/[\r\n]/g, " ").trim().slice(0, max);
}

function norm(value) {
  return raw(value, 400).replace(/\s+/g, " ").toLowerCase();
}

function normLoc(value) {
  return raw(value, 40).toUpperCase();
}

export function isSiteRecord(row) {
  return !!(row && typeof row.id === "string" && SITE_ID.test(row.id) && row.name);
}

function additive(existing, incoming) {
  const fields = ["loc", "address", "operationalRegion", "geographicState", "sourceRef", "sourceName"];
  const patch = {};
  for (const field of fields) {
    const next = incoming[field];
    const current = raw(existing[field] || "");
    if (!next) continue;
    if (!current) patch[field] = next;
    else if (norm(current) !== norm(next) || (field === "loc" && current.toUpperCase() !== next.toUpperCase())) {
      return { error: "Existing " + field + " differs" };
    }
  }
  if (norm(existing.name) !== norm(incoming.name)) return { error: "Existing name differs" };
  return { patch };
}

/**
 * Classifies rows without writing. Place names are not special-cased.
 * geographicState is stored only when the row supplies it.
 */
export function classifyImport(existingSites, inputRows) {
  const sites = (existingSites || []).filter(isSiteRecord);
  const rows = Array.isArray(inputRows) ? inputRows : [];
  if (rows.length > 500) return { error: "Too many rows" };
  const prepared = rows.map((row, index) => {
    const geographicState = raw(row?.geographicState, 80);
    return {
      index,
      loc: raw(row?.loc, 40),
      name: raw(row?.name, 120),
      address: raw(row?.address, 240),
      operationalRegion: raw(row?.operationalRegion, 80),
      geographicState,
      sourceRef: raw(row?.sourceRef, 120),
      sourceName: raw(row?.sourceName, 120) || raw(row?.name, 120),
      hold: row?.hold === true,
      holdReason: raw(row?.holdReason, 160),
    };
  });
  const counts = { rows: prepared.length, create: 0, update: 0, unchanged: 0, held: 0 };
  const result = prepared.map((row) => ({ ...row, status: "", reason: "", siteId: "" }));
  const mark = (row, status, reason, siteId = "") => {
    row.status = status;
    row.reason = reason || "";
    row.siteId = siteId;
    counts[status] += 1;
  };
  const grouped = (keyFn) => {
    const groups = new Map();
    for (const row of result) {
      const key = keyFn(row);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  };
  for (const row of result) {
    if (row.hold) mark(row, "held", row.holdReason || "Held by input");
    else if (!row.loc || !row.name) mark(row, "held", "LOC and name are required");
  }
  for (const group of grouped((row) => row.status ? "" : normLoc(row.loc)).values()) {
    if (group.length > 1) group.forEach((row) => mark(row, "held", "Duplicate LOC in this import"));
  }
  for (const group of grouped((row) => row.status ? "" : norm(row.name)).values()) {
    if (group.length > 1) group.forEach((row) => mark(row, "held", "Duplicate name in this import"));
  }
  for (const group of grouped((row) => row.status ? "" : norm(row.address)).values()) {
    if (group.length > 1) group.forEach((row) => mark(row, "held", "Duplicate address in this import"));
  }
  for (const row of result) {
    if (row.status) continue;
    const locMatches = sites.filter((site) => site.loc && normLoc(site.loc) === normLoc(row.loc));
    const nameMatches = sites.filter((site) => norm(site.name) === norm(row.name));
    const addrMatches = row.address ? sites.filter((site) => site.address && norm(site.address) === norm(row.address)) : [];
    if (locMatches.length > 1 || nameMatches.length > 1 || addrMatches.length > 1) {
      mark(row, "held", "Ambiguous existing match");
      continue;
    }
    const ids = new Set([...locMatches, ...nameMatches, ...addrMatches].map((site) => site.id));
    if (ids.size > 1) {
      mark(row, "held", "LOC, name, and address point at different sites");
      continue;
    }
    let target = locMatches[0] || null;
    if (!target && nameMatches.length === 1) {
      const site = nameMatches[0];
      const addressOk = !row.address || !site.address || norm(site.address) === norm(row.address);
      const locOk = !site.loc || normLoc(site.loc) === normLoc(row.loc);
      if (addressOk && locOk && (addrMatches.length === 0 || addrMatches[0].id === site.id)) target = site;
      else {
        mark(row, "held", "Name matches a different LOC or address");
        continue;
      }
    }
    if (!target && addrMatches.length === 1) {
      mark(row, "held", "Address matches a different site");
      continue;
    }
    if (!target) {
      mark(row, "create", "");
      continue;
    }
    const filled = additive(target, row);
    if (filled.error) {
      mark(row, "held", filled.error);
      continue;
    }
    if (Object.keys(filled.patch).length) mark(row, "update", "Fill empty source fields", target.id);
    else mark(row, "unchanged", "Already imported", target.id);
  }
  const locsPresent = new Set(sites.map((site) => site.loc && normLoc(site.loc)).filter(Boolean));
  return {
    counts,
    rows: result.map((row) => ({
      index: row.index,
      loc: row.loc,
      name: row.name,
      status: row.status,
      reason: row.reason,
      siteId: row.siteId,
      geographicState: row.geographicState,
      operationalRegion: row.operationalRegion,
    })),
    plan: result,
    readback: { sites: sites.length, locsPresent: [...locsPresent].filter((loc) => result.some((row) => normLoc(row.loc) === loc)).length },
  };
}

export async function readSites(store) {
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })));
  return rows.filter(isSiteRecord);
}

export async function applyImport(store, inputRows) {
  const before = await readSites(store);
  const classified = classifyImport(before, inputRows);
  if (classified.error) return classified;
  for (const row of classified.plan) {
    if (row.status === "create") {
      const id = "s" + crypto.randomBytes(4).toString("hex");
      const site = {
        id,
        name: row.name,
        created: new Date().toISOString(),
        loc: row.loc,
        address: row.address,
        operationalRegion: row.operationalRegion,
        geographicState: row.geographicState,
        sourceRef: row.sourceRef,
        sourceName: row.sourceName,
      };
      const gate = await store.setJSON("loc/" + crypto.createHash("sha256").update(normLoc(row.loc)).digest("hex"), { id }, { onlyIfNew: true });
      if (gate?.modified !== true) {
        row.status = "held";
        row.reason = "LOC already exists";
        classified.counts.create -= 1;
        classified.counts.held += 1;
        continue;
      }
      const created = await store.setJSON(id, site, { onlyIfNew: true });
      if (created?.modified !== true) {
        await store.delete("loc/" + crypto.createHash("sha256").update(normLoc(row.loc)).digest("hex"));
        row.status = "held";
        row.reason = "Could not store a new site";
        classified.counts.create -= 1;
        classified.counts.held += 1;
        continue;
      }
      row.siteId = id;
    } else if (row.status === "update") {
      const meta = await store.getWithMetadata(row.siteId, { type: "json" });
      if (!meta?.etag || !meta.data) {
        row.status = "held";
        row.reason = "Site disappeared during import";
        classified.counts.update -= 1;
        classified.counts.held += 1;
        continue;
      }
      const filled = additive(meta.data, row);
      if (filled.error || !Object.keys(filled.patch).length) {
        row.status = "held";
        row.reason = filled.error || "Nothing to add";
        classified.counts.update -= 1;
        classified.counts.held += 1;
        continue;
      }
      const next = { ...meta.data, ...filled.patch };
      const write = await store.setJSON(row.siteId, next, { onlyIfMatch: meta.etag });
      if (write?.modified !== true) {
        row.status = "held";
        row.reason = "Site changed during import";
        classified.counts.update -= 1;
        classified.counts.held += 1;
      }
    }
  }
  const after = await readSites(store);
  const locs = new Set(after.map((site) => site.loc && normLoc(site.loc)).filter(Boolean));
  return {
    counts: classified.counts,
    rows: classified.plan.map((row) => ({ index: row.index, loc: row.loc, name: row.name, status: row.status, reason: row.reason, siteId: row.siteId })),
    readback: {
      sites: after.length,
      locsPresent: classified.plan.filter((row) => row.loc && locs.has(normLoc(row.loc))).length,
    },
  };
}

export function auditView(report) {
  return {
    counts: report.counts,
    readback: report.readback,
    rows: (report.rows || []).map((row) => ({ loc: row.loc, status: row.status, reason: row.reason, siteId: row.siteId || "" })),
  };
}
