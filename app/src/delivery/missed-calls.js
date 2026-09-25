/* A call reached a line -- which, with forwarding set to "no answer / busy /
   unreachable", means the business did not pick up.

   One transaction records the call, finds or opens the caller's conversation,
   decides whether to text, and queues the text if so. The webhook then plays
   a short greeting and hangs up; the dispatcher sends the text a moment later,
   usually while the greeting is still playing.

   Whether to text, in order:
     line paused                          -> no ('paused')
     no usable caller ID                  -> no ('no_caller_id')
     carrier says the caller ID is forged -> no ('spam_suspected')
     trial over and not a client          -> no ('not_entitled')
     caller opted out                     -> no ('opted_out')
     texted them in the last 12 hours     -> no ('duplicate')
     line at its 24-hour cap              -> no ('cap_reached')
     otherwise                            -> text ('texted')
   The owner is not alerted about missed calls -- only when a customer writes
   back. */
import { tx } from "../db.js";
import { isTextableUsNumber } from "../providers/common.js";
import { entitlementFor } from "./entitlement.js";
import { contactLanguages, composeTextback } from "./compose.js";
import { enqueueMessage, sentInLastDay } from "./outbox.js";
import { lineTemplates } from "./lines.js";

export const TEXTBACK_COOLDOWN_HOURS = 12;
const COOLDOWN_MS = TEXTBACK_COOLDOWN_HOURS * 60 * 60 * 1000;

export async function recordMissedCall(event, { now = new Date() } = {}) {
  return tx(async (handle) => {
    /* FOR UPDATE: two calls to one line at the same instant are decided one
       after the other, so the 24-hour cap and the cooldown hold exactly. */
    const line = await handle.one(
      `SELECT * FROM lines WHERE number = $1 AND status <> 'released' FOR UPDATE`, [event.to]
    );
    if (!line) return { line: null };

    /* Twilio retries a webhook it did not get an answer to in time. The call
       id makes the retry a replay, not a second text. */
    const replay = await handle.one(
      `SELECT mc.*, c.language AS conversation_language
         FROM missed_calls mc LEFT JOIN conversations c ON c.id = mc.conversation_id
        WHERE mc.provider_call_sid = $1`,
      [event.callSid]
    );
    if (replay) {
      return {
        line, replay: true, decision: replay.decision, messageId: replay.message_id,
        languages: contactLanguages(line, { language: replay.conversation_language }),
      };
    }

    const textable = isTextableUsNumber(event.from);
    let conversation = null;
    let previous = null;
    if (textable) {
      previous = await handle.one(
        `SELECT * FROM conversations WHERE line_id = $1 AND lead_phone = $2 FOR UPDATE`,
        [line.id, event.from]
      );
      /* A closed conversation reopens when the customer calls again: it is a
         new request, and it should not sit hidden under "closed". */
      conversation = await handle.one(
        `INSERT INTO conversations
           (company_id, line_id, lead_phone, first_call_at, last_call_at, call_count, last_activity_at, created_at)
         VALUES ($1, $2, $3, $4, $4, 1, $4, $4)
         ON CONFLICT (line_id, lead_phone) DO UPDATE SET
           last_call_at     = EXCLUDED.last_call_at,
           call_count       = conversations.call_count + 1,
           last_activity_at = EXCLUDED.last_activity_at,
           status           = CASE WHEN conversations.status = 'closed' THEN 'open' ELSE conversations.status END,
           closed_at        = CASE WHEN conversations.status = 'closed' THEN NULL ELSE conversations.closed_at END,
           closed_by        = CASE WHEN conversations.status = 'closed' THEN NULL ELSE conversations.closed_by END
         RETURNING *`,
        [line.company_id, line.id, event.from, now]
      );
    }

    const entitlement = await entitlementFor(handle, line.company_id, now);
    let decision;
    if (line.status !== "active") decision = "paused";
    else if (!textable) decision = "no_caller_id";
    else if (/^TN-Validation-Failed/i.test(event.verification ?? "")) decision = "spam_suspected";
    else if (!line.is_demo && !entitlement.active) decision = "not_entitled";
    else if (conversation.opted_out_at) decision = "opted_out";
    else if (previous?.last_textback_at && now - previous.last_textback_at < COOLDOWN_MS) decision = "duplicate";
    else if (await sentInLastDay(handle, line.id, now) >= line.daily_send_cap) decision = "cap_reached";
    else decision = "texted";

    const languages = contactLanguages(line, conversation);
    let message = null;
    if (decision === "texted") {
      const overrides = await lineTemplates(handle, line.id);
      message = await enqueueMessage(handle, {
        line, conversationId: conversation.id, kind: "textback", to: event.from,
        body: composeTextback(line, languages, overrides),
        language: languages.length === 1 ? languages[0] : null,
        now,
      });
      /* Each text-back earns at most one follow-up, due only if the customer
         has not written back by then. */
      await handle.query(
        `UPDATE conversations
            SET last_textback_at = $2, followups_sent = 0,
                followup_due_at = CASE WHEN $3 THEN $2::timestamptz + make_interval(mins => $4) ELSE NULL END
          WHERE id = $1`,
        [conversation.id, now, line.followup_enabled, line.followup_delay_minutes]
      );
    }

    const missedCall = await handle.one(
      `INSERT INTO missed_calls
         (company_id, line_id, conversation_id, provider_call_sid, from_number, forwarded_from,
          caller_verification, decision, message_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [line.company_id, line.id, conversation?.id ?? null, event.callSid,
       String(event.from).slice(0, 40), String(event.forwardedFrom ?? "").slice(0, 40),
       String(event.verification ?? "").slice(0, 60), decision, message?.id ?? null, now]
    );

    /* Any call arriving proves the number and the forwarding in front of it
       work end to end. */
    await handle.query(
      `UPDATE lines SET last_call_at = $2, forwarding_verified_at = COALESCE(forwarding_verified_at, $2)
        WHERE id = $1`,
      [line.id, now]
    );

    return { line, replay: false, decision, missedCall, conversation, messageId: message?.id ?? null, languages };
  });
}

/* What the caller hears. Only promise a text when one is on its way or went
   out in the last few hours. */
export function greetingTexted(decision) {
  return decision === "texted" || decision === "duplicate";
}
