/* Twilio, spoken to directly over its REST API with fetch -- no SDK. The app
   uses a handful of endpoints, and five form-encoded requests are easier to
   read, test and trust than a dependency tree.

   Credentials: REST calls use an API key when one is configured (it can be
   rotated or revoked on its own), falling back to the account's auth token.
   Webhook signatures are always checked against the auth token -- that is
   what Twilio signs with. Neither value is ever logged: errors carry Twilio's
   message and code, never the request. */
import { ProviderError, signatureMatches, escapeXml } from "./common.js";

const API = "https://api.twilio.com/2010-04-01";
const MESSAGING_API = "https://messaging.twilio.com/v1";
const TIMEOUT_MS = 10_000;

/* Opt-out words Twilio acts on by itself, replying with its own
   confirmation. Anything else we recognise, we have to confirm ourselves. */
export const TWILIO_OPT_OUT_KEYWORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE",
]);

/* Amazon Polly voices Twilio offers for <Say>, by locale. */
const VOICES = {
  "en-US": "Polly.Joanna",
  "es-US": "Polly.Lupe",
  "pt-BR": "Polly.Camila",
};

/* Twilio's message statuses onto ours. Everything short of a final answer
   means "Twilio has it", which is what our 'sent' records. */
const MESSAGE_STATUS = {
  accepted: "sent", scheduled: "sent", queued: "sent", sending: "sent", sent: "sent",
  delivered: "delivered", read: "delivered",
  undelivered: "undelivered", failed: "failed", canceled: "failed",
};

/* --- webhook payloads, normalised ------------------------------------------ */

export function parseInboundCall(p = {}) {
  return {
    callSid: String(p.CallSid ?? ""),
    from: String(p.From ?? ""),
    to: String(p.To ?? ""),
    forwardedFrom: String(p.ForwardedFrom ?? ""),
    verification: String(p.StirVerstat ?? ""),
  };
}

export function parseInboundMessage(p = {}) {
  return {
    messageSid: String(p.MessageSid ?? p.SmsSid ?? ""),
    from: String(p.From ?? ""),
    to: String(p.To ?? ""),
    body: String(p.Body ?? ""),
    mediaCount: Math.max(0, Number.parseInt(p.NumMedia ?? "0", 10) || 0),
  };
}

export function parseMessageStatus(p = {}) {
  const raw = String(p.MessageStatus ?? p.SmsStatus ?? "").toLowerCase();
  return {
    messageSid: String(p.MessageSid ?? p.SmsSid ?? ""),
    status: MESSAGE_STATUS[raw] ?? null,
    errorCode: String(p.ErrorCode ?? ""),
    errorMessage: String(p.ErrorMessage ?? "").slice(0, 300),
  };
}

/* --- TwiML ------------------------------------------------------------------ */

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8"?>`;

/* Speak each part in its own voice, then hang up. */
export function voiceTwiml(parts) {
  const says = parts.map(({ text, locale }) => {
    const voice = VOICES[locale];
    return `<Say${voice ? ` voice="${voice}"` : ""} language="${escapeXml(locale)}">${escapeXml(text)}</Say>`;
  }).join("");
  return `${XML_HEAD}<Response>${says}<Hangup/></Response>`;
}

export function hangupTwiml() {
  return `${XML_HEAD}<Response><Hangup/></Response>`;
}

/* Replies to a text are sent through the outbox, never inline, so the answer
   to an inbound-message webhook is always empty. */
export function emptyTwiml() {
  return `${XML_HEAD}<Response></Response>`;
}

/* --- the provider ----------------------------------------------------------- */

export function createTwilioProvider({
  accountSid, authToken, apiKeySid = "", apiKeySecret = "", messagingServiceSid = "", baseUrl,
}) {
  const useKey = Boolean(apiKeySid && apiKeySecret);
  const authorization = "Basic " +
    Buffer.from(`${useKey ? apiKeySid : accountSid}:${useKey ? apiKeySecret : authToken}`).toString("base64");
  const account = `${API}/Accounts/${encodeURIComponent(accountSid)}`;

  /* One request. `idempotent` says whether repeating it is harmless, which
     decides how a timeout is classified: a repeated search is fine, a
     repeated send is a second text to a customer. */
  async function call(method, url, form = null, { idempotent }) {
    const headers = { Authorization: authorization, Accept: "application/json" };
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    let response;
    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw networkError(err, idempotent);
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON; fall through */ }
    if (!response.ok) {
      throw new ProviderError(json?.message || `Twilio answered HTTP ${response.status}.`, {
        code: json?.code ?? response.status,
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return json;
  }

  const webhookUrl = (kind, query = "") => `${baseUrl}/webhooks/twilio/${kind}${query}`;

  return {
    name: "twilio",
    enabled: true,
    reason: "",
    defaultMessagingServiceSid: messagingServiceSid,

    webhookUrl,
    /* The URL Twilio signed is the one it was configured with, which is built
       from PUBLIC_BASE_URL -- not from the Host header, which Fly's proxy and
       anyone upstream of it get to write. */
    requestUrl: (rawUrl) => `${baseUrl}${rawUrl}`,
    verifyWebhook: ({ url, params, signature }) => signatureMatches(authToken, url, params, signature),

    parseInboundCall,
    parseInboundMessage,
    parseMessageStatus,
    handlesOptOutKeyword: (word) => TWILIO_OPT_OUT_KEYWORDS.has(String(word).toUpperCase()),

    voiceResponse: (parts) => ({ contentType: "text/xml; charset=utf-8", body: voiceTwiml(parts) }),
    hangupResponse: () => ({ contentType: "text/xml; charset=utf-8", body: hangupTwiml() }),
    messagingResponse: () => ({ contentType: "text/xml; charset=utf-8", body: emptyTwiml() }),

    async sendMessage({ from, to, body, messagingServiceSid: service = "", statusCallback }) {
      const form = { To: to, From: from, Body: body };
      /* From plus a Messaging Service: the service carries the A2P campaign,
         From pins the sender to this client's own number within it. */
      const sid = service || messagingServiceSid;
      if (sid) form.MessagingServiceSid = sid;
      if (statusCallback) form.StatusCallback = statusCallback;
      const json = await call("POST", `${account}/Messages.json`, form, { idempotent: false });
      return { sid: json.sid, status: MESSAGE_STATUS[json.status] ?? "sent" };
    },

    async searchNumbers({ areaCode, limit = 10 }) {
      const query = new URLSearchParams({
        AreaCode: String(areaCode), SmsEnabled: "true", VoiceEnabled: "true", PageSize: String(limit),
      });
      const json = await call("GET", `${account}/AvailablePhoneNumbers/US/Local.json?${query}`, null,
                              { idempotent: true });
      return (json?.available_phone_numbers ?? []).map((n) => ({
        number: n.phone_number, locality: n.locality ?? "", region: n.region ?? "",
      }));
    },

    async purchaseNumber({ number, friendlyName }) {
      const json = await call("POST", `${account}/IncomingPhoneNumbers.json`, {
        PhoneNumber: number,
        FriendlyName: friendlyName.slice(0, 64),
        ...numberWebhooks(webhookUrl),
      }, { idempotent: false });
      return { sid: json.sid, number: json.phone_number };
    },

    async findNumber(number) {
      const query = new URLSearchParams({ PhoneNumber: number });
      const json = await call("GET", `${account}/IncomingPhoneNumbers.json?${query}`, null,
                              { idempotent: true });
      const hit = json?.incoming_phone_numbers?.[0];
      return hit ? { sid: hit.sid, number: hit.phone_number } : null;
    },

    async configureNumber(sid, { friendlyName }) {
      await call("POST", `${account}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
        FriendlyName: friendlyName.slice(0, 64),
        ...numberWebhooks(webhookUrl),
      }, { idempotent: true });
    },

    async addToMessagingService(numberSid, serviceSid) {
      try {
        await call("POST", `${MESSAGING_API}/Services/${encodeURIComponent(serviceSid)}/PhoneNumbers`,
                   { PhoneNumberSid: numberSid }, { idempotent: true });
      } catch (err) {
        /* 21710: already in this service. That is the state we wanted. */
        if (err instanceof ProviderError && err.code === "21710") return;
        throw err;
      }
    },

    async releaseNumber(sid) {
      try {
        await call("DELETE", `${account}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, null,
                   { idempotent: true });
      } catch (err) {
        /* Already gone -- released in the console, say. Nothing left to do. */
        if (err instanceof ProviderError && err.httpStatus === 404) return;
        throw err;
      }
    },
  };
}

function numberWebhooks(webhookUrl) {
  return {
    VoiceUrl: webhookUrl("voice"), VoiceMethod: "POST",
    SmsUrl: webhookUrl("sms"), SmsMethod: "POST",
  };
}

/* Connection-level failures. Some prove the request never left (nothing to
   duplicate); a timeout or a reset mid-response proves nothing. */
const NEVER_SENT = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);

function networkError(err, idempotent) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new ProviderError("Timed out waiting for Twilio.", {
      code: "timeout", retryable: idempotent, ambiguous: !idempotent,
    });
  }
  const code = err?.cause?.code || err?.code || "";
  const neverSent = NEVER_SENT.has(code);
  return new ProviderError(`Could not reach Twilio (${code || "network error"}).`, {
    code: code || "network", retryable: neverSent || idempotent, ambiguous: !neverSent && !idempotent,
  });
}
