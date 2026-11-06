import { env } from "./lib.mjs";

let transport = null;

/** Tests inject a transport. Production uses Resend only when both settings exist. */
export function setMailTransport(fn) {
  transport = fn || null;
}

export function mailConfigured() {
  return !!(env("RESEND_API_KEY") && env("RESEND_FROM"));
}

export function mailSetupMessage() {
  return "Email is not configured. Set RESEND_API_KEY and RESEND_FROM on the site. Nothing is sent until both are present. No other mailbox is used.";
}

/**
 * Returns sent only when a provider response says so.
 * A thrown request or a 5xx is unknown and must not be retried or labelled sent.
 * Exactly-once delivery is not claimed: Resend's idempotency key is sent when a call is made, and a lost response stays unknown.
 */
export async function deliver(message) {
  if (transport) return transport(message);
  if (!mailConfigured()) return { status: "not-configured" };
  const key = env("RESEND_API_KEY");
  const from = env("RESEND_FROM");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        attachments: message.attachments || undefined,
      }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return { status: "sent", id: typeof body.id === "string" ? body.id : "" };
    }
    if (res.status >= 500) return { status: "unknown" };
    return { status: "failed" };
  } catch {
    return { status: "unknown" };
  }
}
