import twilio from "twilio";
import { cfg } from "./config";
import { getStore } from "./idempotency";
import { logEvent } from "./eventLog";
import { phoneSuffix } from "./redact";

export interface SmsSender { send(to: string, body: string): Promise<void>; }

const twilioSender: SmsSender = {
  async send(to, body) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM_NUMBER: from } = process.env;
    if (!sid || !tok || !from) throw new Error("twilio_credentials_missing");
    await twilio(sid, tok).messages.create({ to, from, body });
  },
};
let sender: SmsSender = twilioSender;
export const setSmsSender = (s: SmsSender) => { sender = s; };

export const confirmationBody = (callSid: string) =>
  `Telephony Webhooks Lab (class project): thanks for calling. Ref ${callSid.slice(-6)}. Reply STOP to opt out.`;

export async function maybeSendConfirmation(from: string, callSid: string) {
  const c = cfg();
  const base = { evt: "sms", eventId: callSid, from: phoneSuffix(from) };
  if (!c.smsEnabled) return logEvent({ ...base, outcome: "skipped:flag_off" });
  if (!c.consent.has(from)) return logEvent({ ...base, outcome: "skipped:no_consent" });
  if (!(await getStore().claim(`sms:${callSid}`))) return logEvent({ ...base, outcome: "skipped:duplicate" });
  try {
    await sender.send(from, confirmationBody(callSid));
    logEvent({ ...base, outcome: "sent" });
  } catch (e) {
    // At-most-once: key stays claimed. Extension: push to a dead-letter table.
    logEvent({ ...base, outcome: "failed" });
  }
}
