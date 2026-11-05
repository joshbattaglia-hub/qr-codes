import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { publicBase } from "./lib.mjs";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata.google.com"]);

export function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      if (mapped[2] != null && !mapped[0].includes(".")) {
        const hi = parseInt(mapped[1], 16);
        const lo = parseInt(mapped[2], 16);
        return isPrivateAddress([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."));
      }
      return isPrivateAddress(mapped[1]);
    }
    if (lower === "::1" || lower === "::") return true;
    const head = parseInt(lower.split(":")[0] || "0", 16);
    if (head >= 0xfe80 && head <= 0xfebf) return true;
    if (head >= 0xfc00 && head <= 0xfdff) return true;
    return false;
  }
  return true;
}

export async function hostBlocked(hostname, lookupFn = lookup) {
  const host = String(hostname || "").replace(/\.+$/, "").toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^\d+$/.test(host) || (/^[\d.]+$/.test(host) && !net.isIP(host))) return true;
  if (net.isIP(host)) return isPrivateAddress(host);
  let records = [];
  try {
    records = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    return "unresolved";
  }
  if (!records.length) return "unresolved";
  return records.some((row) => isPrivateAddress(row.address));
}

function classifyHttp(status) {
  if (status === 403 || status === 429) return { status: "unknown", httpStatus: status, reason: String(status) };
  if (status >= 200 && status < 300) return { status: "ok", httpStatus: status };
  if (status === 404 || status === 410 || status >= 500) return { status: "broken", httpStatus: status };
  return { status: "unknown", httpStatus: status };
}

/**
 * Checks a public http(s) URL. Redirects are followed manually and each hop
 * is screened again. Private, local, and credentialled targets are not requested.
 */
function nodeRequest(url, lookupFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, {
      method: "GET",
      timeout: timeoutMs,
      headers: { "user-agent": "ExpressHelpHealth/1.0" },
      lookup(hostname, options, cb) {
        lookupFn(hostname, { all: true, verbatim: true }).then((records) => {
          if (!records?.length) return cb(Object.assign(new Error("dns"), { code: "ENOTFOUND" }));
          if (records.some((row) => isPrivateAddress(row.address))) return cb(Object.assign(new Error("blocked"), { code: "EBLOCKED" }));
          cb(null, records[0].address, records[0].family);
        }).catch((err) => cb(err));
      },
    }, (incoming) => {
      resolve({
        status: incoming.statusCode,
        headers: { get: (name) => incoming.headers[String(name).toLowerCase()] || null },
        body: incoming,
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "AbortError" })));
    req.on("error", reject);
    req.end();
  });
}

export async function checkDestination(input, deps = {}) {
  const fetchImpl = deps.fetch || null;
  const lookupFn = deps.lookup || lookup;
  const timeoutMs = deps.timeoutMs || 5000;
  const maxRedirects = deps.maxRedirects ?? 3;
  let current;
  try { current = new URL(input); } catch { return { status: "unknown", reason: "invalid-url", checkedAt: new Date().toISOString() }; }
  if (current.username || current.password) return { status: "unknown", reason: "credentials", checkedAt: new Date().toISOString() };
  if (current.protocol !== "http:" && current.protocol !== "https:") return { status: "unknown", reason: "scheme", checkedAt: new Date().toISOString() };
  try {
    const home = new URL(publicBase());
    if (current.host === home.host && /^\/(?:r|p|c)\//.test(current.pathname)) {
      return { status: "unknown", reason: "own-link", checkedAt: new Date().toISOString() };
    }
  } catch { /* ignore a bad public base */ }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const blocked = await hostBlocked(current.hostname, lookupFn);
    if (blocked === true) return { status: "unknown", reason: "blocked", checkedAt: new Date().toISOString() };
    if (blocked === "unresolved") return { status: "unknown", reason: "dns", checkedAt: new Date().toISOString() };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = fetchImpl
        ? await fetchImpl(current, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "user-agent": "ExpressHelpHealth/1.0" } })
        : await nodeRequest(current, lookupFn, timeoutMs);
    } catch (e) {
      clearTimeout(timer);
      const reason = e?.name === "AbortError" ? "timeout" : e?.code === "EBLOCKED" ? "blocked" : e?.code === "ENOTFOUND" ? "dns" : "network";
      return { status: "unknown", reason, checkedAt: new Date().toISOString() };
    }
    clearTimeout(timer);
    await drain(res, deps.maxBytes || 65536);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { status: "broken", httpStatus: res.status, reason: "redirect", checkedAt: new Date().toISOString() };
      let next;
      try { next = new URL(loc, current); } catch { return { status: "unknown", reason: "redirect", checkedAt: new Date().toISOString() }; }
      if (next.username || next.password || (next.protocol !== "http:" && next.protocol !== "https:")) {
        return { status: "unknown", reason: "redirect-blocked", checkedAt: new Date().toISOString() };
      }
      current = next;
      continue;
    }
    return { ...classifyHttp(res.status), checkedAt: new Date().toISOString() };
  }
  return { status: "unknown", reason: "redirects", checkedAt: new Date().toISOString() };
}

async function drain(res, maxBytes) {
  try {
    if (res.body && typeof res.body[Symbol.asyncIterator] === "function" && !res.body.getReader) {
      let seen = 0;
      for await (const chunk of res.body) {
        seen += chunk.length || 0;
        if (seen >= maxBytes) { res.body.destroy(); break; }
      }
      return;
    }
    const reader = res.body?.getReader?.();
    if (!reader) return;
    let seen = 0;
    while (seen < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.byteLength || 0;
    }
    await reader.cancel().catch(() => {});
  } catch { /* ignore body errors */ }
}
