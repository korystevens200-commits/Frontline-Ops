/* Twilio's three ways into the app. No session and no CSRF token here --
   Twilio has neither. Instead every request must carry a valid Twilio
   signature over the exact public URL and parameters, checked before
   anything is read from it. Unsigned or mis-signed requests get a 403 and
   touch nothing.

   Each line is also rate limited: past WEBHOOK_LIMIT_PER_MINUTE requests a
   minute, calls are answered with a plain hang-up and texts are
   acknowledged, but nothing is processed or sent. A flood costs Twilio
   minutes, not a text to every number in it. */
import { getProvider } from "../providers/sms.js";
import { query } from "../db.js";
import { hit } from "../security/ratelimit.js";
import { recordMissedCall, greetingTexted } from "../delivery/missed-calls.js";
import { recordInboundMessage } from "../delivery/inbound.js";
import { applyDeliveryStatus } from "../delivery/outbox.js";
import { composeGreeting } from "../delivery/compose.js";
import { kickDispatcher } from "../delivery/dispatcher.js";

export const WEBHOOK_PATHS = [
  "/webhooks/twilio/voice",
  "/webhooks/twilio/sms",
  "/webhooks/twilio/message-status",
];

const WEBHOOK_LIMIT_PER_MINUTE = 120;

/* Spoken if the app itself fails mid-call: the caller is on the line right
   now, and Twilio's own "an application error has occurred" is worse than
   an apology. English and Spanish, because we cannot know which. */
const FALLBACK_GREETING = [
  { text: "Thanks for calling. Sorry we missed you. Please try again a little later.", locale: "en-US" },
  { text: "Gracias por llamar. Disculpe que no pudimos contestar. Por favor llame de nuevo más tarde.", locale: "es-US" },
];

export default async function webhookRoutes(app) {
  /* Returns the provider when the request is genuinely from it, otherwise
     answers the request itself and returns null. */
  function authenticate(request, reply, kind) {
    const provider = getProvider();
    if (!provider.enabled) {
      request.log.warn({ kind }, "webhook received while text-back is not configured");
      reply.code(503).type("text/plain; charset=utf-8").send("Text-back is not configured.");
      return null;
    }
    const valid = provider.verifyWebhook({
      url: provider.requestUrl(request.raw.url),
      params: request.body ?? {},
      signature: request.headers["x-twilio-signature"],
    });
    if (!valid) {
      request.log.warn({ kind }, "webhook signature rejected");
      reply.code(403).type("text/plain; charset=utf-8").send("Forbidden");
      return null;
    }
    return provider;
  }

  async function overLimit(lineNumber) {
    return (await hit("webhook_line", lineNumber || "?", { windowSeconds: 60 })) > WEBHOOK_LIMIT_PER_MINUTE;
  }

  /* Raw payload kept for 30 days for support questions. A failure to keep it
     is logged and never allowed to fail the webhook. */
  async function remember(request, provider, { kind, sid, lineId = null, outcome }) {
    try {
      await query(
        `INSERT INTO provider_events (provider, kind, provider_sid, line_id, outcome, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [provider.name, kind, String(sid ?? "").slice(0, 64), lineId, outcome, JSON.stringify(request.body ?? {})]
      );
    } catch (err) {
      request.log.error({ err, kind }, "could not store provider event");
    }
  }

  app.post("/webhooks/twilio/voice", async (request, reply) => {
    const provider = authenticate(request, reply, "voice");
    if (!provider) return reply;
    const event = provider.parseInboundCall(request.body);

    if (await overLimit(event.to)) {
      request.log.warn({ kind: "voice" }, "line webhook rate limit exceeded");
      await remember(request, provider, { kind: "voice", sid: event.callSid, outcome: "rate_limited" });
      const response = provider.hangupResponse();
      return reply.type(response.contentType).send(response.body);
    }

    try {
      const result = await recordMissedCall(event);
      if (!result.line) {
        await remember(request, provider, { kind: "voice", sid: event.callSid, outcome: "unknown_line" });
        const response = provider.hangupResponse();
        return reply.type(response.contentType).send(response.body);
      }
      await remember(request, provider, {
        kind: "voice", sid: event.callSid, lineId: result.line.id,
        outcome: result.replay ? `replay:${result.decision}` : result.decision,
      });
      if (result.messageId) kickDispatcher();

      const response = provider.voiceResponse(
        composeGreeting(result.line, result.languages, { texted: greetingTexted(result.decision) })
      );
      return reply.type(response.contentType).send(response.body);
    } catch (err) {
      request.log.error({ err }, "missed call handling failed");
      const response = provider.voiceResponse(FALLBACK_GREETING);
      return reply.type(response.contentType).send(response.body);
    }
  });

  app.post("/webhooks/twilio/sms", async (request, reply) => {
    const provider = authenticate(request, reply, "sms");
    if (!provider) return reply;
    const event = provider.parseInboundMessage(request.body);

    if (await overLimit(event.to)) {
      request.log.warn({ kind: "sms" }, "line webhook rate limit exceeded");
      await remember(request, provider, { kind: "sms", sid: event.messageSid, outcome: "rate_limited" });
      const response = provider.messagingResponse();
      return reply.type(response.contentType).send(response.body);
    }

    /* Not caught: if the message cannot be stored, a 500 puts the failure in
       Twilio's debugger, where the message itself is still retrievable. An
       empty 200 would lose it without trace. */
    const result = await recordInboundMessage(event, {
      providerConfirmsOptOut: (keyword) => provider.handlesOptOutKeyword(keyword),
    });
    await remember(request, provider, {
      kind: "sms", sid: event.messageSid, lineId: result.line?.id ?? null, outcome: result.outcome,
    });
    if (result.alertId || result.confirmationId) kickDispatcher();

    const response = provider.messagingResponse();
    return reply.type(response.contentType).send(response.body);
  });

  app.post("/webhooks/twilio/message-status", async (request, reply) => {
    const provider = authenticate(request, reply, "message_status");
    if (!provider) return reply;
    const receipt = provider.parseMessageStatus(request.body);
    const messageId = Number.parseInt(String(request.query?.m ?? ""), 10);

    const result = await applyDeliveryStatus({
      messageId: Number.isInteger(messageId) && messageId > 0 ? messageId : null,
      messageSid: receipt.messageSid,
      status: receipt.status,
      errorCode: receipt.errorCode,
      errorMessage: receipt.errorMessage,
    });
    if (!result.found) {
      await remember(request, provider, {
        kind: "message_status", sid: receipt.messageSid,
        outcome: result.mismatch ? "sid_mismatch" : "unknown_message",
      });
    }
    return reply.code(204).send();
  });
}
