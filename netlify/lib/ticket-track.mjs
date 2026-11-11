import crypto from "node:crypto";
import { env, ticketStore } from "./lib.mjs";

/**
 * Private tracking links.
 *
 * A link is /support/track#<number>.<token>. Only SHA-256 hashes of tokens are stored on the ticket
 * (trackHash, plus trackHashes for any later tokens), so verification never needs the key.
 *
 * Tokens minted from this change on are recoverable: token = HMAC-SHA256(trackKey, "track\n" + ticketId).
 * The key is TICKET_TRACK_KEY (Netlify Production, functions scope). If that variable is missing, the key
 * is derived with HKDF-SHA256 from OTP_SESSION_SECRET. If the key ever changes, older links keep working
 * because their hashes stay on the ticket; the next notification adds the hash of the new derived token.
 */

export function trackKey() {
  const dedicated = env("TICKET_TRACK_KEY");
  if (dedicated.length >= 32) return crypto.createHash("sha256").update("ticket-track-key\n" + dedicated).digest();
  const base = env("OTP_SESSION_SECRET") || env("ADMIN_PASSWORD") || "";
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(base), Buffer.from("expresshelp-track"), Buffer.from("ticket-track-v1"), 32));
}

export function hashTrackToken(token) {
  return crypto.createHash("sha256").update("track\n" + String(token || "")).digest("hex");
}

export function derivedTrackToken(ticketId) {
  return crypto.createHmac("sha256", trackKey()).update("track\n" + String(ticketId || "")).digest("base64url");
}

export function trackPath(number, token) {
  return "/support/track#" + number + "." + token;
}

export function trackHashesOf(ticket) {
  const out = [];
  if (ticket?.trackHash) out.push(String(ticket.trackHash));
  for (const value of Array.isArray(ticket?.trackHashes) ? ticket.trackHashes : []) out.push(String(value));
  return out.filter((value) => /^[a-f0-9]{64}$/.test(value));
}

export function trackTokenMatches(ticket, token) {
  const actual = Buffer.from(hashTrackToken(token), "hex");
  let match = false;
  const hashes = trackHashesOf(ticket);
  for (const value of hashes.length ? hashes : ["0".repeat(64)]) {
    const expected = Buffer.from(value, "hex");
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) match = true;
  }
  return match && hashes.length > 0;
}

/** Fields to set on a brand-new ticket so it has a recoverable tracking link from the start. */
export function newTicketTracking(ticketId) {
  return { trackHash: hashTrackToken(derivedTrackToken(ticketId)) };
}

export async function writeTrackIndex(number, id) {
  await ticketStore().setJSON("track/" + number, { id });
}

/**
 * Returns the recoverable tracking path for a ticket, minting it on first use for older tickets
 * (including email-in tickets with no token). Existing hashes are kept, so old links stay valid.
 */
export async function ensureTrackingPath(ticketId) {
  if (!/^t[a-f0-9]{16}$/.test(ticketId || "")) return "";
  const token = derivedTrackToken(ticketId);
  const hash = hashTrackToken(token);
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await ticketStore().getWithMetadata("ticket/" + ticketId, { type: "json", consistency: "strong" });
    if (!meta?.data) return "";
    const ticket = meta.data;
    const index = await ticketStore().get("track/" + ticket.number, { type: "json" });
    if (index?.id !== ticket.id) await writeTrackIndex(ticket.number, ticket.id);
    if (trackHashesOf(ticket).includes(hash)) return trackPath(ticket.number, token);
    const next = { ...ticket, trackHashes: [...(Array.isArray(ticket.trackHashes) ? ticket.trackHashes : []), hash].slice(-8) };
    const write = await ticketStore().setJSON("ticket/" + ticketId, next, meta.etag ? { onlyIfMatch: meta.etag } : {});
    if (write?.modified !== false) return trackPath(ticket.number, token);
  }
  return "";
}
