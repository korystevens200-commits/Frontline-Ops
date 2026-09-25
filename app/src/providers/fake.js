/* A provider that talks to nobody, for the test suite and local development.

   It speaks Twilio's wire format -- the same payload parsing, the same TwiML,
   the same signature scheme under a fixed development token -- so everything
   above the provider seam runs exactly as it would against the real thing,
   and scripts/simulate.js can drive a local server end to end.

   Sends are recorded, not delivered. It is refused outright when
   NODE_ENV=production: a server that silently drops every text would look
   healthy right up until a client asks why nobody got one. */
import { ProviderError, signatureMatches } from "./common.js";
import {
  parseInboundCall, parseInboundMessage, parseMessageStatus,
  voiceTwiml, hangupTwiml, emptyTwiml, TWILIO_OPT_OUT_KEYWORDS,
} from "./twilio.js";

/* Not a secret: it only ever signs requests to a development server. */
export const FAKE_AUTH_TOKEN = "frontline-ops-fake-provider";

export function createFakeProvider({ baseUrl = "http://localhost:8080" } = {}) {
  const state = { sent: [], purchased: [], released: [], failures: [], seq: 0 };
  const webhookUrl = (kind, query = "") => `${baseUrl}/webhooks/twilio/${kind}${query}`;
  const xml = (body) => ({ contentType: "text/xml; charset=utf-8", body });

  function nextFailure() {
    const failure = state.failures.shift();
    if (failure) throw failure;
  }

  return {
    name: "fake",
    enabled: true,
    reason: "",
    isFake: true,
    defaultMessagingServiceSid: "",
    state,

    /* Make the next provider call throw this ProviderError. */
    failNext(error) {
      state.failures.push(error instanceof ProviderError ? error : new ProviderError(String(error)));
    },
    reset() {
      state.sent.length = 0;
      state.purchased.length = 0;
      state.released.length = 0;
      state.failures.length = 0;
    },

    webhookUrl,
    requestUrl: (rawUrl) => `${baseUrl}${rawUrl}`,
    verifyWebhook: ({ url, params, signature }) => signatureMatches(FAKE_AUTH_TOKEN, url, params, signature),

    parseInboundCall,
    parseInboundMessage,
    parseMessageStatus,
    handlesOptOutKeyword: (word) => TWILIO_OPT_OUT_KEYWORDS.has(String(word).toUpperCase()),

    voiceResponse: (parts) => xml(voiceTwiml(parts)),
    hangupResponse: () => xml(hangupTwiml()),
    messagingResponse: () => xml(emptyTwiml()),

    async sendMessage(message) {
      nextFailure();
      state.seq += 1;
      const sid = `SMfake${String(state.seq).padStart(26, "0")}`;
      state.sent.push({ sid, ...message });
      return { sid, status: "sent" };
    },

    async searchNumbers({ areaCode, limit = 10 }) {
      nextFailure();
      /* 555-0100 through 555-0199 are reserved for fiction. */
      return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
        number: `+1${areaCode}55501${String(10 + i)}`, locality: "Fake City", region: "FL",
      }));
    },

    async purchaseNumber({ number }) {
      nextFailure();
      state.seq += 1;
      const purchased = { sid: `PNfake${String(state.seq).padStart(26, "0")}`, number };
      state.purchased.push(purchased);
      return purchased;
    },

    async findNumber(number) {
      nextFailure();
      return { sid: `PNfake${number.replace(/\D/g, "").padStart(26, "0")}`, number };
    },

    async configureNumber() { nextFailure(); },
    async addToMessagingService() { nextFailure(); },
    async releaseNumber(sid) { nextFailure(); state.released.push(sid); },
  };
}
