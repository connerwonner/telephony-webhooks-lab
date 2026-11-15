// Read lazily so tests and tunnels can change env without a restart.
export function cfg() {
  return {
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    baseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    smsEnabled: process.env.SMS_ENABLED === "true", // default false
    consent: new Set((process.env.SMS_CONSENT_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  };
}
