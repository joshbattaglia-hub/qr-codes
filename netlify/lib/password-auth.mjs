import { consumeLink, killLinks, limit, passwordProblem, peekLink, sendLinkEmail, storedHash, verifyPasswordHash, writePassword } from "./credentials.mjs";
import { normalizeEmail, startSessionForEmail } from "./otp.mjs";
import { endSessions, userFor } from "./users.mjs";
import { env } from "./lib.mjs";

export const LOGIN_REJECTED = "That email and password were not accepted.";
export const FORGOT_ACCEPTED = "If that address can sign in to Express Help, a reset link is on its way. It works once and lasts one hour.";
export const LINK_BAD = "This link is not valid. Ask for a new one.";
export const LINK_EXPIRED = "This link has expired. Ask for a new one.";

const secretOk = () => env("OTP_SESSION_SECRET").length >= 32;

/** Email + password sign-in. Same session as the email code, so the Users list decides access on every request. */
export async function passwordLogin(req, email, password) {
  if (!secretOk()) return { status: 503, error: "Password sign-in is not available right now." };
  const address = normalizeEmail(email);
  const text = typeof password === "string" ? password : "";
  if (!address || !text || text.length > 1024) return { status: 401, error: LOGIN_REJECTED };
  const gate = await limit(req, "login", address);
  if (gate) return gate;
  const user = await userFor(address);
  const hash = user ? await storedHash(address) : "";
  const ok = await verifyPasswordHash(text, hash); // one scrypt either way
  if (!user || !hash || !ok) return { status: 401, error: LOGIN_REJECTED };
  const started = await startSessionForEmail(req, address);
  if (!started) return { status: 401, error: LOGIN_REJECTED };
  return { status: 200, actor: started.actor, cookie: started.cookie };
}

/** Always the same answer. Only an address on the Users list gets a message. */
export async function forgotPassword(req, email) {
  const address = normalizeEmail(email);
  if (!address) return { status: 400, error: "Enter your email address." };
  const gate = await limit(req, "forgot", address);
  if (gate) return gate;
  const user = await userFor(address);
  if (user) await sendLinkEmail(address, "reset").catch(() => null);
  return { status: 200, body: { ok: true, message: FORGOT_ACCEPTED } };
}

export async function checkLink(req, token) {
  const gate = await limit(req, "token", "");
  if (gate) return gate;
  const peek = await peekLink(token);
  if (!peek.ok) return { status: 200, body: { valid: false, reason: peek.reason, message: peek.reason === "expired" ? LINK_EXPIRED : LINK_BAD } };
  if (!(await userFor(peek.email))) return { status: 200, body: { valid: false, reason: "invalid", message: LINK_BAD } };
  return { status: 200, body: { valid: true, kind: peek.kind, email: peek.email } };
}

/** Sets the password from a link. The link is checked, the password is checked, then the link is used once. */
export async function setPasswordFromLink(req, token, password) {
  const gate = await limit(req, "token", "");
  if (gate) return gate;
  const peek = await peekLink(token);
  if (!peek.ok) return { status: 400, error: peek.reason === "expired" ? LINK_EXPIRED : LINK_BAD };
  if (!(await userFor(peek.email))) return { status: 400, error: LINK_BAD };
  const problem = passwordProblem(password, peek.email);
  if (problem) return { status: 422, error: problem };
  const used = await consumeLink(token);
  if (!used.ok) return { status: 400, error: used.reason === "expired" ? LINK_EXPIRED : LINK_BAD };
  await writePassword(peek.email, password);
  await killLinks(peek.email);
  // A new password signs out sessions started before it (permissions are not touched).
  await endSessions(peek.email);
  return { status: 200, body: { ok: true, email: peek.email, message: "Your password is set. Sign in with it, or use an email code." } };
}
