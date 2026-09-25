/* The seam between the app and whoever carries its calls and texts.

   Nothing outside src/providers/ knows Twilio exists. Everything else asks
   getProvider() for an object with this shape:

     name, enabled, reason            which provider, and why not, if not
     defaultMessagingServiceSid       server-wide A2P messaging service
     webhookUrl(kind, query)          where the provider should call us
     requestUrl(rawUrl)               the public URL a webhook was sent to
     verifyWebhook({url, params, signature})
     parseInboundCall / parseInboundMessage / parseMessageStatus (params)
     handlesOptOutKeyword(word)       does the provider confirm this itself?
     voiceResponse(parts) / hangupResponse() / messagingResponse()
     sendMessage({from, to, body, messagingServiceSid, statusCallback})
     searchNumbers / purchaseNumber / findNumber / configureNumber /
       addToMessagingService / releaseNumber

   Provider calls throw ProviderError, classified retryable / ambiguous /
   permanent. Swapping carrier means one new file here and a case below.

   Which provider runs is decided by the environment:
     SMS_PROVIDER=fake      local development and tests; refused in production
     Twilio secrets set     Twilio
     otherwise              disabled -- text-back is off and says why, and the
                            rest of the app (all of Phase 1) is unaffected */
import { ProviderError } from "./common.js";
import { createTwilioProvider } from "./twilio.js";
import { createFakeProvider } from "./fake.js";

let current = null;

export function getProvider() {
  if (!current) current = resolveProvider(process.env);
  return current;
}

/* Tests swap in a fresh fake; nothing else calls this. */
export function setProvider(provider) {
  current = provider;
}

/* Where Twilio reaches this app. Explicit when set; otherwise Fly's own
   hostname for the app, which Fly provides as FLY_APP_NAME on every machine. */
export function publicBaseUrl(env = process.env) {
  const explicit = String(env.PUBLIC_BASE_URL ?? "").trim();
  const fly = env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : "";
  return (explicit || fly).replace(/\/+$/, "");
}

export function resolveProvider(env = process.env) {
  const choice = String(env.SMS_PROVIDER ?? "").trim().toLowerCase();
  const baseUrl = publicBaseUrl(env);

  if (choice === "fake") {
    if (env.NODE_ENV === "production") {
      throw new Error("SMS_PROVIDER=fake is refused in production: every text would be silently dropped.");
    }
    return createFakeProvider({ baseUrl: baseUrl || `http://localhost:${env.PORT || 8080}` });
  }
  if (choice && choice !== "twilio") {
    return disabledProvider(`SMS_PROVIDER "${choice}" is not a provider this app knows.`);
  }

  const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].filter((name) => !env[name]);
  if (missing.length) {
    return disabledProvider(`Twilio is not configured: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.`);
  }
  /* Shape checks only -- a typo'd secret should say so at boot rather than
     surface as a 401 on the first missed call. Values are never echoed. */
  if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID)) {
    return disabledProvider("TWILIO_ACCOUNT_SID does not look like an account SID (AC followed by 32 hex characters).");
  }
  if (Boolean(env.TWILIO_API_KEY_SID) !== Boolean(env.TWILIO_API_KEY_SECRET)) {
    return disabledProvider("Set both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or neither.");
  }
  if (env.TWILIO_API_KEY_SID && !/^SK[0-9a-f]{32}$/i.test(env.TWILIO_API_KEY_SID)) {
    return disabledProvider("TWILIO_API_KEY_SID does not look like an API key SID (SK followed by 32 hex characters).");
  }
  if (env.TWILIO_MESSAGING_SERVICE_SID && !/^MG[0-9a-f]{32}$/i.test(env.TWILIO_MESSAGING_SERVICE_SID)) {
    return disabledProvider("TWILIO_MESSAGING_SERVICE_SID does not look like a Messaging Service SID (MG followed by 32 hex characters).");
  }
  if (!baseUrl) {
    return disabledProvider("PUBLIC_BASE_URL is not set, so Twilio cannot be told where to send calls and texts.");
  }
  if (env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    return disabledProvider("PUBLIC_BASE_URL must be https:// in production.");
  }

  return createTwilioProvider({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    apiKeySid: env.TWILIO_API_KEY_SID || "",
    apiKeySecret: env.TWILIO_API_KEY_SECRET || "",
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || "",
    baseUrl,
  });
}

export function disabledProvider(reason) {
  const off = async () => { throw new ProviderError(reason, { code: "not_configured" }); };
  return {
    name: "disabled",
    enabled: false,
    reason,
    defaultMessagingServiceSid: "",
    webhookUrl: () => "",
    requestUrl: () => "",
    verifyWebhook: () => false,
    handlesOptOutKeyword: () => false,
    sendMessage: off,
    searchNumbers: off,
    purchaseNumber: off,
    findNumber: off,
    configureNumber: off,
    addToMessagingService: off,
    releaseNumber: off,
  };
}

/* One line for the boot log. Names what is configured, never a value. */
export function describeProvider(provider) {
  if (!provider.enabled) return `text-back disabled: ${provider.reason}`;
  if (provider.isFake) return "text-back using the FAKE provider (development only; nothing is delivered)";
  return `text-back via ${provider.name}${provider.defaultMessagingServiceSid ? " with a messaging service" : " (no messaging service set)"}`;
}
