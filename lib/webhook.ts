import twilio from "twilio";
import { cfg } from "./config";
import { getStore } from "./idempotency";
import { logEvent } from "./eventLog";
import { phoneSuffix } from "./redact";
import { maybeSendConfirmation } from "./sms";

export type Kind = "voice" | "status";
const MAX_BYTES = 4096;
const PATHS: Record<Kind, string> = { voice: "/api/twilio/voice", status: "/api/twilio/status" };
const REQUIRED: Record<Kind, string[]> = { voice: ["CallSid", "From", "To"], status: ["CallSid", "CallStatus"] };

const twiml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
export const VOICE_TWIML = twiml(`<Say>Thanks for calling the Telephony Webhooks Lab. Goodbye.</Say><Hangup/>`);
export const FALLBACK_TWIML = twiml(`<Say>Sorry, something went wrong. Please try again later.</Say><Hangup/>`);
const xml = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });
const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

export async function handleWebhook(req: Request, kind: Kind): Promise<Response> {
  if (req.method !== "POST") return text(405, "Method Not Allowed", { Allow: "POST" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
    return text(415, "Unsupported Media Type");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return text(413, "Payload Too Large");

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BYTES) return text(413, "Payload Too Large");
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Signature: header supplied by caller is only *compared*, never trusted.
  // URL comes from server config, not from the Host header.
  const c = cfg();
  const sig = req.headers.get("x-twilio-signature");
  const ok = !!c.authToken && !!c.baseUrl && !!sig &&
    twilio.validateRequest(c.authToken, sig, c.baseUrl + PATHS[kind], params);
  if (!ok) {
    logEvent({ evt: kind, outcome: "rejected:bad_signature" });
    return text(403, "Forbidden");
  }

  const missing = REQUIRED[kind].filter((k) => !params[k]);
  if (missing.length) {
    logEvent({ evt: kind, outcome: "rejected:missing_fields" });
    return text(400, "Bad Request");
  }

  const eventId = kind === "voice" ? params.CallSid : `${params.CallSid}:${params.CallStatus}`;
  const key = `${kind}:${eventId}`;
  const base = { evt: kind, eventId, status: params.CallStatus, from: phoneSuffix(params.From) };
  const done = () => (kind === "voice" ? xml(VOICE_TWIML) : new Response(null, { status: 204 }));

  try {
    if (!(await getStore().claim(key))) {
      logEvent({ ...base, outcome: "duplicate" });
      return done(); // same answer, no side effects
    }
    logEvent({ ...base, outcome: "received" });
    if (kind === "voice") await maybeSendConfirmation(params.From, params.CallSid);
    return done();
  } catch {
    logEvent({ ...base, outcome: "error" });
    if (kind === "voice") return xml(FALLBACK_TWIML); // never a dead line
    try { await getStore().release(key); } catch {}
    return text(500, "Internal Error"); // let Twilio retry status callbacks
  }
}
