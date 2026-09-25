/* A text arrived on a line.

   Opt-out keywords (English and Spanish) mark the conversation opted out,
   cancel anything queued for that customer, and -- for keywords the provider
   does not confirm itself -- queue one confirmation. START (and friends)
   reverses it.

   Anything else is a reply: it is stored on the conversation, the pending
   follow-up is cancelled, the conversation is flagged for the owner, and the
   owner is alerted by text -- at most once per conversation every 15
   minutes, so a customer sending five short texts in a row costs one alert.

   Nothing here ever auto-replies to a customer's message. Two automated
   systems texting each other cannot loop through this code. */
import { tx } from "../db.js";
import { isE164 } from "../providers/common.js";
import { matchKeyword, detectLanguage } from "./language/index.js";
import { entitlementFor, lineCanText } from "./entitlement.js";
import { composeOwnerAlert, composeOptOutConfirm } from "./compose.js";
import { enqueueMessage, cancelQueuedForConversation, sentInLastDay } from "./outbox.js";

export const ALERT_THROTTLE_MINUTES = 15;
const ALERT_THROTTLE_MS = ALERT_THROTTLE_MINUTES * 60 * 1000;

/* `providerConfirmsOptOut(keyword)` -- whether the provider already replies to
   this opt-out keyword on its own (Twilio does for STOP and friends). */
export async function recordInboundMessage(event, { now = new Date(), providerConfirmsOptOut = () => false } = {}) {
  return tx(async (handle) => {
    const line = await handle.one(
      `SELECT * FROM lines WHERE number = $1 AND status <> 'released' FOR UPDATE`, [event.to]
    );
    if (!line) return { outcome: "unknown_line" };

    if (event.messageSid) {
      const seen = await handle.one(`SELECT id FROM messages WHERE provider_sid = $1`, [event.messageSid]);
      if (seen) return { line, outcome: "duplicate" };
    }
    if (!isE164(event.from)) return { line, outcome: "unusable_sender" };

    /* The owner texting their own line -- replying to an alert, usually.
       Relaying that to the customer is not built yet; recording it as a
       "lead" would alert the owner about themselves. */
    if (line.alert_phone && event.from === line.alert_phone) return { line, outcome: "owner_message" };

    const conversation = await handle.one(
      `INSERT INTO conversations (company_id, line_id, lead_phone, last_activity_at, created_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (line_id, lead_phone) DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at
       RETURNING *`,
      [line.company_id, line.id, event.from, now]
    );

    const keyword = matchKeyword(event.body);

    if (keyword?.type === "optout") {
      await storeInbound(handle, line, conversation, event, "optout", keyword.language, now);
      await handle.query(
        `UPDATE conversations SET opted_out_at = COALESCE(opted_out_at, $2), followup_due_at = NULL
          WHERE id = $1`,
        [conversation.id, now]
      );
      await cancelQueuedForConversation(handle, conversation.id, ["textback", "followup"], "Customer opted out.");
      let confirmation = null;
      if (!providerConfirmsOptOut(keyword.keyword)) {
        confirmation = await enqueueMessage(handle, {
          line, conversationId: conversation.id, kind: "optout_confirm", to: event.from,
          body: composeOptOutConfirm(line, keyword.language), language: keyword.language, now,
        });
      }
      return { line, conversation, outcome: "optout", confirmationId: confirmation?.id ?? null };
    }

    /* START only means something to someone who opted out. To anyone else
       "Yes" is an answer, and is handled as a reply below. */
    if (keyword?.type === "optin" && conversation.opted_out_at) {
      await storeInbound(handle, line, conversation, event, "optin", keyword.language, now);
      await handle.query(`UPDATE conversations SET opted_out_at = NULL WHERE id = $1`, [conversation.id]);
      return { line, conversation, outcome: "optin" };
    }

    const language = detectLanguage(event.body);
    const message = await storeInbound(handle, line, conversation, event, "reply", language, now);
    await handle.query(
      `UPDATE conversations
          SET status = 'replied', closed_at = NULL, closed_by = NULL,
              first_reply_at = COALESCE(first_reply_at, $2), last_inbound_at = $2,
              language = COALESCE($3, language), followup_due_at = NULL
        WHERE id = $1`,
      [conversation.id, now, language]
    );
    await cancelQueuedForConversation(handle, conversation.id, ["followup"], "Customer replied.");

    const alertId = await maybeAlertOwner(handle, line, conversation, event, now);
    return { line, conversation, outcome: "reply", messageId: message.id, alertId };
  });
}

async function storeInbound(handle, line, conversation, event, kind, language, now) {
  return handle.one(
    `INSERT INTO messages
       (company_id, line_id, conversation_id, direction, kind, from_number, to_number,
        body, language, media_count, provider_sid, status, created_at)
     VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8, $9, NULLIF($10, ''), 'received', $11)
     RETURNING *`,
    [line.company_id, line.id, conversation.id, kind, event.from, event.to,
     String(event.body ?? "").slice(0, 2000), language, event.mediaCount ?? 0, event.messageSid ?? "", now]
  );
}

async function maybeAlertOwner(handle, line, conversation, event, now) {
  if (!line.alert_phone) return null;
  if (conversation.last_alert_at && now - conversation.last_alert_at < ALERT_THROTTLE_MS) return null;
  const entitlement = await entitlementFor(handle, line.company_id, now);
  if (!lineCanText(line, entitlement)) return null;
  if (await sentInLastDay(handle, line.id, now) >= line.daily_send_cap) return null;

  const alert = await enqueueMessage(handle, {
    line, conversationId: conversation.id, kind: "owner_alert", to: line.alert_phone,
    body: composeOwnerAlert(line, { leadPhone: event.from, text: event.body, mediaCount: event.mediaCount }),
    language: line.alert_language, now,
  });
  await handle.query(`UPDATE conversations SET last_alert_at = $2 WHERE id = $1`, [conversation.id, now]);
  return alert.id;
}
