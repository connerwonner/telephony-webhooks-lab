\# Telephony Webhooks Lab: Written Answers



Notes: Vapi is not wired in; the route returns TwiML itself, so "Vapi / TwiML Engine" is the TwiML response. The idempotency store is in-memory behind an interface that maps to Redis or Postgres.



\## 1. Sequence trace



```

Caller Phone         Twilio Gateway              /api/twilio/voice (lib/webhook.ts)         TwiML response (Vapi slot)

&#x20;   | dials number          |                                  |                                   |

&#x20;   |---------------------->|                                  |                                   |

&#x20;   |                       | POST CallSid, From, To           |                                   |

&#x20;   |                       | X-Twilio-Signature               |                                   |

&#x20;   |                       |--------------------------------->|                                   |

&#x20;   |                       |                  1. method / content-type / size checks               |

&#x20;   |                       |                  2. validateRequest (403 on fail)                     |

&#x20;   |                       |                  3. required fields (400 on fail)                     |

&#x20;   |                       |                  4. claim voice:<CallSid> (atomic)                    |

&#x20;   |                       |                  5. log received (\*\*\*last4)                           |

&#x20;   |                       |                  6. maybeSendConfirmation (flag + consent + claim)    |

&#x20;   |                       |<-- 200 text/xml <Say>...<Hangup/> |                                   |

&#x20;   |<== caller hears greeting, call ends ==|                                                       |

&#x20;   |                       | retry same CallSid ------------->| claim fails -> "duplicate", same 200 TwiML, no SMS

&#x20;   |                       | POST /api/twilio/status -------->| claim status:<CallSid>:<CallStatus> -> 204

```



To make Vapi the fourth actor, replace `VOICE\_TWIML` with TwiML that hands the call to Vapi (for example `<Connect>` or `<Dial><Sip>`). Not implemented in this lab.



\## 2. Signature validation



Code, from `lib/webhook.ts`:



```ts

const c = cfg();

const sig = req.headers.get("x-twilio-signature");

const ok = !!c.authToken \&\& !!c.baseUrl \&\& !!sig \&\&

&#x20; twilio.validateRequest(c.authToken, sig, c.baseUrl + PATHS\[kind], params);

if (!ok) {

&#x20; logEvent({ evt: kind, outcome: "rejected:bad\_signature" });

&#x20; return text(403, "Forbidden");

}

```



\- \*\*Header verified:\*\* `X-Twilio-Signature`.

\- \*\*Secret:\*\* `TWILIO\_AUTH\_TOKEN` from `.env.local` (read in `lib/config.ts`). Twilio's HMAC-SHA1 covers the full URL plus the sorted POST parameters. The URL is built from `PUBLIC\_BASE\_URL` plus the route path, not the request `Host` header.

\- \*\*On failure:\*\* HTTP `403`, plain-text body `Forbidden`. A missing token, base URL, or header fails closed the same way.



\## 3. Idempotency



\- \*\*Identifier:\*\* `CallSid` for voice. Status callbacks use `CallSid:CallStatus`. SMS uses `sms:<CallSid>`.



```ts

if (!(await getStore().claim(key))) {

&#x20; logEvent({ ...base, outcome: "duplicate" });

&#x20; return done(); // same answer, no side effects

}

```



\- \*\*How it works:\*\* `claim()` returns `true` only for the first caller with that key. A Twilio retry (or concurrent retries, covered by a test) gets `false`, so it returns the same TwiML and skips the SMS and other side effects.

\- \*\*Caveat:\*\* the current store is `MemoryStore`, which resets on restart and is not shared across serverless instances. Production swap (see `lib/idempotency.ts`): Redis `SET key 1 NX EX 86400`, or Postgres `INSERT ... ON CONFLICT DO NOTHING` and check the row count.



\## 4. PII and safe logging



Logging statement, `lib/eventLog.ts`:



```ts

if (process.env.NODE\_ENV !== "test") console.log(JSON.stringify(entry));

```



Masking, `lib/redact.ts`:



```ts

export const phoneSuffix = (p?: string) => (p ? `\*\*\*${p.replace(/\\D/g, "").slice(-4)}` : "unknown");

```



`logEvent` accepts only `evt`, `eventId`, `status`, `from` (already masked) and `outcome`. The raw `From`, request body, signature, and token are never passed in. Real log output shows `"from":"\*\*\*0123"`, and a test asserts the log has no full number, token, or bad signature. The route never reads `SpeechResult` or any transcript field, so none can be logged.



\## 5. Fallback TwiML on internal error



If the store or anything in the try block throws, the voice route returns HTTP `200` with this payload (`FALLBACK\_TWIML`):



```xml

<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Please try again later.</Say><Hangup/></Response>

```



The caller hears a spoken message instead of a dead line or an error tone. The status route returns 500 on internal error and releases its claim so Twilio can retry. A store-outage test covers the voice case.

