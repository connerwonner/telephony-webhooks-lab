import { describe, it, expect, beforeEach } from "vitest";
import twilio from "twilio";
import { readFileSync } from "node:fs";
import * as voiceRoute from "../app/api/twilio/voice/route";
import * as statusRoute from "../app/api/twilio/status/route";
import { MemoryStore, setStore, type IdempotencyStore } from "../lib/idempotency";
import { setSmsSender } from "../lib/sms";
import { clearEventLog, getEventLog } from "../lib/eventLog";
import { FALLBACK_TWIML, VOICE_TWIML } from "../lib/webhook";

const TOKEN = "test_token_not_real";
const BASE = "https://example.test";
const VOICE = "/api/twilio/voice";
const STATUS = "/api/twilio/status";
const fx = (n: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), "utf8"));
let sent: { to: string; body: string }[] = [];

type Opts = { sig?: string | null; signUrl?: string; method?: string; contentType?: string; rawBody?: string };
function req(path: string, params: Record<string, string>, o: Opts = {}) {
  const sig = o.sig === undefined ? twilio.getExpectedTwilioSignature(TOKEN, o.signUrl ?? BASE + path, params) : o.sig;
  const headers: Record<string, string> = { "content-type": o.contentType ?? "application/x-www-form-urlencoded" };
  if (sig) headers["x-twilio-signature"] = sig;
  const method = o.method ?? "POST";
  return new Request(BASE + path, { method, headers, body: method === "GET" ? undefined : o.rawBody ?? new URLSearchParams(params).toString() });
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.SMS_ENABLED = "true";
  process.env.SMS_CONSENT_NUMBERS = "+15555550123";
  setStore(new MemoryStore());
  clearEventLog();
  sent = [];
  setSmsSender({ send: async (to, body) => { sent.push({ to, body }); } });
});

describe("signature validation", () => {
  it("accepts a valid signature and returns minimal TwiML", async () => {
    const r = await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/xml");
    expect(await r.text()).toBe(VOICE_TWIML);
  });
  it("rejects an invalid signature with 403 and no side effects", async () => {
    const r = await voiceRoute.POST(req(VOICE, fx("voice-inbound"), { sig: "AAAAinvalid=" }));
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("Forbidden");
    expect(sent).toHaveLength(0);
  });
  it("rejects a missing signature header", async () => {
    expect((await voiceRoute.POST(req(VOICE, fx("voice-inbound"), { sig: null }))).status).toBe(403);
  });
  it("rejects a signature computed for a different URL", async () => {
    const r = await voiceRoute.POST(req(VOICE, fx("voice-inbound"), { signUrl: "https://evil.test" + VOICE }));
    expect(r.status).toBe(403);
  });
  it("rejects a tampered body", async () => {
    const p = fx("voice-inbound");
    const sig = twilio.getExpectedTwilioSignature(TOKEN, BASE + VOICE, p);
    const tampered = new URLSearchParams({ ...p, To: "+15555559999" }).toString();
    expect((await voiceRoute.POST(req(VOICE, p, { sig, rawBody: tampered }))).status).toBe(403);
  });
});

describe("request hygiene", () => {
  it("returns 400 when required fields are missing (validly signed)", async () => {
    const { CallSid, ...rest } = fx("voice-inbound");
    expect((await voiceRoute.POST(req(VOICE, rest))).status).toBe(400);
  });
  it("returns 405 + Allow for unexpected methods", async () => {
    const r = await voiceRoute.GET(req(VOICE, {}, { method: "GET" }));
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
  it("returns 415 for the wrong content type", async () => {
    expect((await voiceRoute.POST(req(VOICE, fx("voice-inbound"), { contentType: "application/json" }))).status).toBe(415);
  });
  it("returns 413 for oversized bodies", async () => {
    const big = { ...fx("voice-inbound"), Junk: "x".repeat(10_000) };
    expect((await voiceRoute.POST(req(VOICE, big))).status).toBe(413);
  });
});

describe("idempotency", () => {
  it("duplicate event creates no duplicate SMS", async () => {
    const a = await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    const b = await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(await a.text()).toBe(await b.text());
    expect(sent).toHaveLength(1);
    expect(getEventLog().some((e) => e.outcome === "duplicate")).toBe(true);
  });
  it("concurrent provider retries still send exactly one SMS", async () => {
    await Promise.all([1, 2, 3].map(() => voiceRoute.POST(req(VOICE, fx("voice-inbound")))));
    expect(sent).toHaveLength(1);
  });
  it("status callbacks: same CallSid+status deduped, new status processed", async () => {
    const s1 = req(STATUS, fx("status-completed"));
    expect((await statusRoute.POST(s1)).status).toBe(204);
    expect((await statusRoute.POST(req(STATUS, fx("status-completed")))).status).toBe(204);
    const received = getEventLog().filter((e) => e.evt === "status" && e.outcome === "received");
    expect(received).toHaveLength(1);
  });
});

describe("SMS gating", () => {
  it("defaults to off", async () => {
    delete process.env.SMS_ENABLED;
    await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(sent).toHaveLength(0);
    expect(getEventLog().some((e) => e.outcome === "skipped:flag_off")).toBe(true);
  });
  it("requires recipient consent even when enabled", async () => {
    process.env.SMS_CONSENT_NUMBERS = "";
    await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(sent).toHaveLength(0);
  });
  it("template names the project and offers opt-out", async () => {
    await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(sent[0].body).toMatch(/Telephony Webhooks Lab/);
    expect(sent[0].body).toMatch(/STOP/);
  });
  it("SMS provider failure does not break the call", async () => {
    setSmsSender({ send: async () => { throw new Error("boom"); } });
    const r = await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(await r.text()).toBe(VOICE_TWIML);
    expect(getEventLog().some((e) => e.outcome === "failed")).toBe(true);
  });
});

describe("logging and errors", () => {
  it("logs contain no full phone numbers, signatures or tokens", async () => {
    await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    await voiceRoute.POST(req(VOICE, fx("voice-inbound"), { sig: "badsig" }));
    const dump = JSON.stringify(getEventLog());
    expect(dump).not.toContain("5555550123");
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("badsig");
    expect(dump).toContain("***0123");
  });
  it("store outage returns fallback TwiML with 200 (no dead line)", async () => {
    const broken: IdempotencyStore = { claim: async () => { throw new Error("db timeout"); }, release: async () => {} };
    setStore(broken);
    const r = await voiceRoute.POST(req(VOICE, fx("voice-inbound")));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(FALLBACK_TWIML);
  });
});
