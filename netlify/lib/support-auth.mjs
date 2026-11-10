import crypto from "node:crypto";
import { conditionalIncrement, env, rateStore, ticketStore } from "./lib.mjs";
import { deliver } from "./mail.mjs";
import { readSettings, requesterScope } from "./tickets.mjs";

const WINDOW_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SUPPORT_ACCEPTED = "If this address can open the support portal, a code will arrive shortly.";

let testDeliver = null;
let clock = () => Date.now();
export function setSupportTestHooks({ deliver: deliverImpl = null, now = null } = {}) {
  testDeliver = typeof deliverImpl === "function" ? deliverImpl : null;
  clock = typeof now === "function" ? now : () => Date.now();
}
function now() { return clock(); }
function secret() { return env("OTP_SESSION_SECRET"); }

function sign(id, exp) {
  return crypto.createHmac("sha256", secret()).update(`support:${id}.${exp}`).digest("hex");
}
function sameHex(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function cookieBase(req) {
  let secure = false;
  try {
    const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
    secure = proto === "https" || new URL(req.url).protocol === "https:";
  } catch { /* local http */ }
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

async function limited(email) {
  const windowId = Math.floor(now() / WINDOW_MS);
  const hash = crypto.createHash("sha256").update("support\n" + email).digest("hex").slice(0, 24);
  const gate = await conditionalIncrement(rateStore(), `support/start/${hash}/${windowId}`, 3);
  if (!gate.ok && gate.reason === "limit") return { status: 429, error: "Too many attempts. Wait and try again." };
  if (!gate.ok) return { status: 503, error: "Support sign-in is temporarily unavailable." };
  return null;
}

export async function startSupportCode(req, email) {
  if (secret().length < 32) return { status: 503, error: "Support sign-in is not operational." };
  const settings = await readSettings();
  const scope = requesterScope(settings, email);
  const address = scope?.email || "";
  if (address) {
    const gate = await limited(address);
    if (gate) return gate;
    const code = crypto.randomInt(0, 100000000).toString().padStart(8, "0");
    const id = "c" + crypto.randomBytes(8).toString("hex");
    const send = testDeliver || deliver;
    const result = await send({ to: address, subject: "Your Express Help support code", text: "Your support code is " + code + ".", idempotencyKey: "support-" + id });
    if (result?.status === "sent") {
      await ticketStore().setJSON("code/" + id, { id, email: address, exp: now() + CODE_TTL_MS, mac: crypto.createHmac("sha256", secret()).update(id + "\n" + code).digest("hex"), used: false });
    }
  }
  return { status: 200, body: { ok: true, message: SUPPORT_ACCEPTED } };
}

export async function verifySupportCode(req, email, code) {
  if (secret().length < 32) return { status: 503, error: "Support sign-in is not operational." };
  const settings = await readSettings();
  const scope = requesterScope(settings, email);
  if (!scope || !/^\d{8}$/.test(String(code || ""))) return { status: 401, error: "That code was not accepted." };
  const { blobs } = await ticketStore().list({ prefix: "code/" });
  const rows = (await Promise.all(blobs.map((blob) => ticketStore().get(blob.key, { type: "json" })))).filter((row) => row && row.email === scope.email && !row.used && row.exp >= now());
  const mac = (id) => crypto.createHmac("sha256", secret()).update(id + "\n" + code).digest("hex");
  const match = rows.find((row) => sameHex(row.mac, mac(row.id)));
  if (!match) return { status: 401, error: "That code was not accepted." };
  await ticketStore().setJSON("code/" + match.id, { ...match, used: true });
  const id = "s" + crypto.randomBytes(8).toString("hex");
  const exp = now() + SESSION_TTL_MS;
  await ticketStore().setJSON("session/" + id, { id, email: scope.email, exp });
  const maxAge = Math.max(0, Math.floor((exp - now()) / 1000));
  return { status: 200, body: { ok: true, email: scope.email }, cookie: `qr_support=${id}.${exp}.${sign(id, exp)}; ${cookieBase(req)}; Max-Age=${maxAge}` };
}

export async function supportFromRequest(req) {
  if (secret().length < 32) return null;
  const match = (req.headers.get("cookie") || "").match(/(?:^|;\s*)qr_support=(s[a-f0-9]{16})\.(\d+)\.([a-f0-9]+)/);
  if (!match || +match[2] < now()) return null;
  if (!sameHex(sign(match[1], match[2]), match[3])) return null;
  const row = await ticketStore().get("session/" + match[1], { type: "json" });
  if (!row || row.exp < now()) return null;
  const settings = await readSettings();
  return requesterScope(settings, row.email);
}
