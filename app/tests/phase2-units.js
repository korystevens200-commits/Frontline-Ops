/* Phase 2 unit tests: the pieces of text-back that need no database.
   Signatures, TwiML, segment counting, wording, language handling, CSRF,
   provider selection, and the Twilio HTTP client against a stubbed fetch. */
import test from "node:test";
import assert from "node:assert/strict";

const { webhookSignature, signatureMatches, isTextableUsNumber, statusAdvances, ProviderError } =
  await import("../src/providers/common.js");
const { createTwilioProvider, voiceTwiml, parseMessageStatus } = await import("../src/providers/twilio.js");
const { resolveProvider, publicBaseUrl } = await import("../src/providers/sms.js");
const { countSegments } = await import("../src/delivery/segments.js");
const { composeTextback, composeFollowup, composeOwnerAlert, composeGreeting } =
  await import("../src/delivery/compose.js");
const { detectLanguage, matchKeyword, PHRASE_KEYS, languageCodes, defaultPhrase } =
  await import("../src/delivery/language/index.js");
const { languageModes } = await import("../src/delivery/lines.js");
const { withinSendingHours, nextSendingStart } = await import("../src/delivery/followups.js");
const { csrfToken, verifyCsrfToken, injectCsrfField, isSameOrigin } = await import("../src/security/csrf.js");

const LINE = {
  display_name: "AA Eagle Plumbing", number: "+13055550100",
  primary_language: "en", secondary_language: "es", alert_language: "es",
};

/* --- signatures -------------------------------------------------------------- */

test("webhook signature matches Twilio's published example", () => {
  /* From Twilio's "Validating requests" documentation, and cross-checked
     against the official twilio-node library. */
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234",
    From: "+12349013030", To: "+18005551212",
  };
  assert.equal(webhookSignature("12345", url, params), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  assert.ok(signatureMatches("12345", url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="));
});

test("a tampered parameter, URL or token fails the signature", () => {
  const url = "https://frontline-ops.fly.dev/webhooks/twilio/sms";
  const params = { From: "+13055550142", Body: "¿Hola? ñ & <b>" };
  const good = webhookSignature("secret", url, params);
  assert.ok(signatureMatches("secret", url, params, good));
  assert.equal(signatureMatches("secret", url, { ...params, Body: "changed" }, good), false);
  assert.equal(signatureMatches("secret", `${url}?x=1`, params, good), false);
  assert.equal(signatureMatches("other", url, params, good), false);
  assert.equal(signatureMatches("secret", url, params, undefined), false);
  assert.equal(signatureMatches("", url, params, good), false);
});

test("the webhook URL checked is built from the configured base, not the request's Host", () => {
  const provider = createTwilioProvider({
    accountSid: `AC${"a".repeat(32)}`, authToken: "tok", baseUrl: "https://frontline-ops.fly.dev",
  });
  assert.equal(provider.requestUrl("/webhooks/twilio/voice"), "https://frontline-ops.fly.dev/webhooks/twilio/voice");
  const params = { CallSid: "CA1" };
  const signature = webhookSignature("tok", "https://frontline-ops.fly.dev/webhooks/twilio/voice", params);
  assert.ok(provider.verifyWebhook({ url: provider.requestUrl("/webhooks/twilio/voice"), params, signature }));
  assert.equal(provider.verifyWebhook({ url: "https://attacker.example/webhooks/twilio/voice", params, signature }), false);
});

/* --- TwiML ------------------------------------------------------------------- */

test("spoken greetings are XML-escaped and use a voice per language", () => {
  const xml = voiceTwiml([
    { text: `Smith & Sons <"best">`, locale: "en-US" },
    { text: "Gracias por llamar", locale: "es-US" },
  ]);
  assert.ok(xml.includes("Smith &amp; Sons &lt;&quot;best&quot;&gt;"));
  assert.ok(!xml.includes("<\"best\">"));
  assert.ok(xml.includes(`voice="Polly.Joanna" language="en-US"`));
  assert.ok(xml.includes(`voice="Polly.Lupe" language="es-US"`));
  assert.ok(xml.endsWith("<Hangup/></Response>"));
});

test("the greeting only promises a text when one is on its way", () => {
  const texted = composeGreeting(LINE, ["en", "es"], { texted: true });
  const plain = composeGreeting(LINE, ["en"], { texted: false });
  assert.equal(texted.length, 2);
  assert.match(texted[0].text, /sent you a text/);
  assert.match(texted[1].text, /mensaje de texto/);
  assert.doesNotMatch(plain[0].text, /text/);
});

/* --- segments ---------------------------------------------------------------- */

test("SMS segments are counted the way carriers bill them", () => {
  assert.deepEqual(countSegments("a".repeat(160)), { encoding: "GSM-7", length: 160, segments: 1 });
  assert.equal(countSegments("a".repeat(161)).segments, 2);
  assert.equal(countSegments("a".repeat(306)).segments, 2);
  assert.equal(countSegments("a".repeat(307)).segments, 3);
  /* Extension characters cost two. */
  assert.equal(countSegments("{".repeat(80)).length, 160);
  assert.equal(countSegments("{".repeat(81)).segments, 2);
  /* é, ñ, ¿ and ¡ are GSM-7; á, í, ó, ú are not. */
  assert.equal(countSegments("¿Qué tal, señor? ¡Olé!").encoding, "GSM-7");
  assert.equal(countSegments("baño y más").encoding, "UCS-2");
  assert.equal(countSegments("á" + "a".repeat(69)).segments, 1);
  assert.equal(countSegments("á" + "a".repeat(70)).segments, 2);
  /* An emoji is two UTF-16 units. */
  assert.equal(countSegments("👍").length, 2);
});

/* --- wording ----------------------------------------------------------------- */

test("the default first text is bilingual, short, and one segment", () => {
  const body = composeTextback(LINE, ["en", "es"]);
  assert.equal(body,
    "AA Eagle Plumbing: Sorry we missed your call. How can we help?\n" +
    "Disculpe que no pudimos contestar. ¿En qué le podemos ayudar?");
  assert.deepEqual(
    { encoding: countSegments(body).encoding, segments: countSegments(body).segments },
    { encoding: "GSM-7", segments: 1 }
  );
});

test("a caller whose language is known gets it alone", () => {
  assert.equal(composeTextback(LINE, ["es"]),
    "Hola, le escribe AA Eagle Plumbing. Disculpe que no pudimos contestar. ¿En qué le podemos ayudar?");
  assert.equal(composeTextback(LINE, ["en"]),
    "Hi, this is AA Eagle Plumbing. Sorry we missed your call. How can we help?");
  assert.match(composeFollowup(LINE, ["es"]), /^Le saluda de nuevo AA Eagle Plumbing\. ¿Todavía/);
});

test("a client's reworded text replaces only the body, and never leaks a placeholder", () => {
  const overrides = new Map([["textback:en", "We'll call {business} you right back {nonsense}."]]);
  const body = composeTextback(LINE, ["en", "es"], overrides);
  assert.ok(body.startsWith("AA Eagle Plumbing: We'll call AA Eagle Plumbing you right back ."));
  assert.ok(body.includes("¿En qué le podemos ayudar?"), "the other language keeps its default");
  assert.ok(!body.includes("{"));
});

test("owner alerts are in the owner's language, truncated, and name the customer", () => {
  const alert = composeOwnerAlert(LINE, { leadPhone: "+13055550142", text: "Tengo  una\nfuga " + "x".repeat(200) });
  assert.match(alert, /^Frontline Ops: nuevo cliente potencial para AA Eagle Plumbing\. \(305\) 555-0142 escribió: "Tengo una fuga x+…"/);
  assert.ok(alert.length < 240);
  const photo = composeOwnerAlert({ ...LINE, alert_language: "en" }, { leadPhone: "+13055550142", text: "", mediaCount: 1 });
  assert.match(photo, /texted: "\(sent a photo\)"/);
});

/* --- languages ----------------------------------------------------------------- */

test("every language defines every phrase, so adding one cannot half-work", () => {
  for (const code of languageCodes()) {
    for (const key of PHRASE_KEYS) {
      assert.ok(defaultPhrase(code, key).trim(), `${code} is missing "${key}"`);
    }
  }
  const modes = languageModes().map((m) => m.value);
  for (const mode of ["en,es", "es,en", "en", "es"]) assert.ok(modes.includes(mode), mode);
});

test("reply language is detected, and short or mixed text is left undecided", () => {
  assert.equal(detectLanguage("Hola, tengo una fuga en el baño"), "es");
  assert.equal(detectLanguage("¿Cuánto cuesta?"), "es");
  assert.equal(detectLanguage("Hi, my kitchen sink is leaking, can you come today?"), "en");
  assert.equal(detectLanguage("ok"), null);
  assert.equal(detectLanguage("👍"), null);
  assert.equal(detectLanguage(""), null);
});

test("opt-out keywords match the whole message only, in English and Spanish", () => {
  assert.deepEqual(matchKeyword("stop"), { type: "optout", keyword: "STOP", language: "en" });
  assert.deepEqual(matchKeyword("  Stop. "), { type: "optout", keyword: "STOP", language: "en" });
  assert.deepEqual(matchKeyword("PARAR"), { type: "optout", keyword: "PARAR", language: "es" });
  assert.deepEqual(matchKeyword("baja!"), { type: "optout", keyword: "BAJA", language: "es" });
  assert.equal(matchKeyword("stop by tomorrow please"), null);
  assert.equal(matchKeyword("please stop"), null);
  assert.equal(matchKeyword("START").type, "optin");
  assert.equal(matchKeyword("hello"), null);
});

/* --- sending hours --------------------------------------------------------------- */

test("follow-ups wait for 8am-8pm on the line's clock, across a DST change", () => {
  const zone = "America/New_York";
  /* 21:00 EDT on Sept 24 -> 08:00 EDT on Sept 25. */
  const late = new Date("2026-09-25T01:00:00Z");
  assert.equal(withinSendingHours(late, zone), false);
  assert.equal(nextSendingStart(late, zone).toISOString(), "2026-09-25T12:00:00.000Z");
  /* 06:00 EDT -> 08:00 the same day. */
  const early = new Date("2026-09-25T10:00:00Z");
  assert.equal(nextSendingStart(early, zone).toISOString(), "2026-09-25T12:00:00.000Z");
  /* 21:00 EDT on Oct 31 -> 08:00 EST on Nov 1, after clocks go back. */
  const beforeFallBack = new Date("2026-11-01T01:00:00Z");
  assert.equal(nextSendingStart(beforeFallBack, zone).toISOString(), "2026-11-01T13:00:00.000Z");
  assert.equal(withinSendingHours(new Date("2026-09-25T16:00:00Z"), zone), true);
  assert.equal(withinSendingHours(new Date("2026-09-25T16:00:00Z"), "America/Los_Angeles"), true);
  assert.equal(withinSendingHours(new Date("2026-09-25T13:30:00Z"), "America/Los_Angeles"), false);
});

/* --- CSRF ------------------------------------------------------------------------- */

test("CSRF tokens are bound to the session and injected into POST forms only", () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "unit-test-secret";
  const session = { user: "Kory", iat: 1_790_000_000 };
  const token = csrfToken(session);
  assert.equal(token, csrfToken({ ...session }), "stable for the life of a session");
  assert.notEqual(token, csrfToken({ ...session, iat: session.iat + 1 }), "dies with the session");
  assert.notEqual(token, csrfToken({ ...session, user: "Isa" }));
  assert.ok(verifyCsrfToken(session, token));
  assert.equal(verifyCsrfToken(session, token.slice(1)), false);
  assert.equal(verifyCsrfToken(session, undefined), false);
  assert.equal(verifyCsrfToken(null, token), false);

  const page = `<form method="GET" action="/pipeline"></form>` +
               `<form method="POST" action="/a" class="x"></form>` +
               `<p>&lt;form method="POST"&gt;</p>` +
               `<form class="y" method="POST" action="/b" enctype="multipart/form-data"></form>`;
  const out = injectCsrfField(page, token);
  assert.equal(out.split(`name="_csrf" value="${token}"`).length - 1, 2, "both POST forms, nothing else");
  assert.ok(out.startsWith(`<form method="GET" action="/pipeline"></form>`));
});

test("cross-origin writes are recognised", () => {
  const req = (headers) => ({ headers: { host: "frontline-ops.fly.dev", ...headers } });
  assert.ok(isSameOrigin(req({ origin: "https://frontline-ops.fly.dev" })));
  assert.equal(isSameOrigin(req({ origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(req({ origin: "null" })), false);
  assert.ok(isSameOrigin(req({ "sec-fetch-site": "same-origin" })));
  assert.equal(isSameOrigin(req({ "sec-fetch-site": "cross-site" })), false);
  assert.ok(isSameOrigin(req({})), "no browser headers: left to the token check");
});

/* --- provider selection --------------------------------------------------------------- */

test("the provider is chosen from the environment, and Phase 1 survives without one", () => {
  const sid = `AC${"0".repeat(32)}`;
  assert.equal(resolveProvider({}).enabled, false);
  assert.match(resolveProvider({}).reason, /TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set/);
  assert.match(resolveProvider({ TWILIO_ACCOUNT_SID: "nope", TWILIO_AUTH_TOKEN: "t", PUBLIC_BASE_URL: "https://x.dev" }).reason,
               /does not look like an account SID/);
  assert.match(resolveProvider({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "t" }).reason, /PUBLIC_BASE_URL/);
  assert.match(resolveProvider({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "t", TWILIO_API_KEY_SID: `SK${"0".repeat(32)}`,
                                 PUBLIC_BASE_URL: "https://x.dev" }).reason, /both/);
  assert.match(resolveProvider({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "t", NODE_ENV: "production",
                                 PUBLIC_BASE_URL: "http://x.dev" }).reason, /https/);

  const live = resolveProvider({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "t", FLY_APP_NAME: "frontline-ops" });
  assert.equal(live.name, "twilio");
  assert.equal(live.webhookUrl("voice"), "https://frontline-ops.fly.dev/webhooks/twilio/voice");
  assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://ops.example.com/", FLY_APP_NAME: "x" }), "https://ops.example.com");

  assert.equal(resolveProvider({ SMS_PROVIDER: "fake" }).name, "fake");
  assert.throws(() => resolveProvider({ SMS_PROVIDER: "fake", NODE_ENV: "production" }), /refused in production/);
  /* The reason text never carries a credential value. */
  const reason = resolveProvider({ TWILIO_ACCOUNT_SID: "ACsecretlooking", TWILIO_AUTH_TOKEN: "hunter2" }).reason;
  assert.ok(!reason.includes("hunter2") && !reason.includes("ACsecretlooking"));
});

/* --- the Twilio HTTP client, against a stubbed fetch --------------------------------- */

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("sending a text posts the right form, with the API key and the status callback", async () => {
  const provider = createTwilioProvider({
    accountSid: `AC${"1".repeat(32)}`, authToken: "authtoken",
    apiKeySid: `SK${"2".repeat(32)}`, apiKeySecret: "keysecret",
    messagingServiceSid: `MG${"3".repeat(32)}`, baseUrl: "https://frontline-ops.fly.dev",
  });
  await withFetch(() => json(201, { sid: "SM123", status: "queued" }), async (calls) => {
    const result = await provider.sendMessage({
      from: "+13055550100", to: "+13055550142", body: "Hola",
      statusCallback: provider.webhookUrl("message-status", "?m=7"),
    });
    assert.deepEqual(result, { sid: "SM123", status: "sent" });
    const { url, init } = calls[0];
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/AC${"1".repeat(32)}/Messages.json`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`SK${"2".repeat(32)}:keysecret`).toString("base64")}`);
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("To"), "+13055550142");
    assert.equal(form.get("From"), "+13055550100");
    assert.equal(form.get("Body"), "Hola");
    assert.equal(form.get("MessagingServiceSid"), `MG${"3".repeat(32)}`);
    assert.equal(form.get("StatusCallback"), "https://frontline-ops.fly.dev/webhooks/twilio/message-status?m=7");
  });
});

test("provider failures are classified so a customer is never texted twice", async () => {
  const provider = createTwilioProvider({ accountSid: `AC${"1".repeat(32)}`, authToken: "t", baseUrl: "https://x.dev" });
  const send = () => provider.sendMessage({ from: "+13055550100", to: "+13055550142", body: "x" });

  await withFetch(() => json(429, { code: 20429, message: "Too many requests" }), async () => {
    await assert.rejects(send, (err) => err instanceof ProviderError && err.retryable && !err.ambiguous);
  });
  await withFetch(() => json(400, { code: 21211, message: "Invalid 'To' Phone Number" }), async () => {
    await assert.rejects(send, (err) => err.code === "21211" && !err.retryable && !err.ambiguous);
  });
  await withFetch(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }, async () => {
    await assert.rejects(send, (err) => err.retryable && !err.ambiguous);
  });
  await withFetch(() => { throw new DOMException("timed out", "TimeoutError"); }, async () => {
    await assert.rejects(send, (err) => err.ambiguous && !err.retryable, "a timed-out send may have gone out");
  });
  await withFetch(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }, async () => {
    await assert.rejects(send, (err) => err.ambiguous && !err.retryable);
  });
  /* A timed-out search is safe to repeat. */
  await withFetch(() => { throw new DOMException("timed out", "TimeoutError"); }, async () => {
    await assert.rejects(() => provider.searchNumbers({ areaCode: "305" }), (err) => err.retryable && !err.ambiguous);
  });
});

test("buying a number points its voice and SMS webhooks here", async () => {
  const provider = createTwilioProvider({ accountSid: `AC${"1".repeat(32)}`, authToken: "t", baseUrl: "https://frontline-ops.fly.dev" });
  await withFetch(() => json(201, { sid: "PN1", phone_number: "+13055550110" }), async (calls) => {
    const bought = await provider.purchaseNumber({ number: "+13055550110", friendlyName: "Frontline Ops · AA Eagle" });
    assert.deepEqual(bought, { sid: "PN1", number: "+13055550110" });
    const form = new URLSearchParams(calls[0].init.body);
    assert.equal(form.get("VoiceUrl"), "https://frontline-ops.fly.dev/webhooks/twilio/voice");
    assert.equal(form.get("SmsUrl"), "https://frontline-ops.fly.dev/webhooks/twilio/sms");
    assert.equal(form.get("VoiceMethod"), "POST");
  });
  /* Releasing a number that is already gone is not an error. */
  await withFetch(() => json(404, { code: 20404, message: "not found" }), async () => {
    await provider.releaseNumber("PN404");
  });
});

/* --- small rules ----------------------------------------------------------------------- */

test("only a real US caller ID can be texted", () => {
  assert.ok(isTextableUsNumber("+13055550142"));
  for (const junk of ["+266696687", "+7378742833", "anonymous", "", "+13051234567"]) {
    assert.equal(isTextableUsNumber(junk), false, junk);
  }
  assert.equal(isTextableUsNumber("+447700900123"), false, "the service only texts within the US");
});

test("delivery receipts only ever move a message forward", () => {
  assert.ok(statusAdvances("sending", "sent"));
  assert.ok(statusAdvances("sent", "delivered"));
  assert.ok(statusAdvances("unknown", "delivered"), "a receipt resolves an unconfirmed send");
  assert.equal(statusAdvances("delivered", "sent"), false);
  assert.equal(statusAdvances("failed", "delivered"), false);
  assert.equal(parseMessageStatus({ MessageStatus: "undelivered", ErrorCode: "30006" }).status, "undelivered");
  assert.equal(parseMessageStatus({ MessageStatus: "queued" }).status, "sent");
});
