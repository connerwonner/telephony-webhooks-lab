// Free simulator: signs a saved fixture exactly like Twilio and POSTs it twice (retry).
// Usage: PUBLIC_BASE_URL=http://localhost:3000 TWILIO_AUTH_TOKEN=local_dummy npx tsx scripts/simulate.ts [fixture] [path]
import twilio from "twilio";
import { readFileSync } from "node:fs";

const [, , fixture = "voice-inbound", path = "/api/twilio/voice"] = process.argv;
const token = process.env.TWILIO_AUTH_TOKEN ?? "";
const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const target = process.env.SIM_TARGET ?? base;
const params = JSON.parse(readFileSync(`fixtures/${fixture}.json`, "utf8"));
const sig = twilio.getExpectedTwilioSignature(token, base + path, params);

for (let i = 1; i <= 2; i++) {
  const r = await fetch(target + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params),
  });
  console.log(`attempt ${i}: HTTP ${r.status}`, (await r.text()).slice(0, 100));
}
