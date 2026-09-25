/* The follow-up: one nudge after a text-back that got no answer.

   Queued by the dispatcher when a conversation's followup_due_at passes, and
   only if nothing changed the picture in the meantime: no reply since the
   text-back, not opted out, not closed, line active, business still
   entitled, under the daily cap.

   Only sent between 8am and 8pm on the line's clock. A follow-up falling due
   at 10pm waits for 8am rather than landing on someone's phone at night --
   deliberately stricter than it strictly needs to be, since Florida's
   telemarketing law (FTSA) draws its line at 8am-8pm. The text-back itself
   is not held: it answers a call the customer just made. */
import { tx } from "../db.js";
import { zonedParts, parseLocalDateTime } from "../time.js";
import { entitlementFor, lineCanText } from "./entitlement.js";
import { contactLanguages, composeFollowup } from "./compose.js";
import { enqueueMessage, sentInLastDay } from "./outbox.js";
import { lineTemplates } from "./lines.js";

export const MAX_FOLLOWUPS = 1;
export const SENDING_HOURS = { start: 8, end: 20 };

export function withinSendingHours(now, zone) {
  const { hour } = zonedParts(now, zone);
  return hour >= SENDING_HOURS.start && hour < SENDING_HOURS.end;
}

/* The next 8am on the line's clock, as an instant. */
export function nextSendingStart(now, zone) {
  const p = zonedParts(now, zone);
  let day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour >= SENDING_HOURS.start) day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  const date = day.toISOString().slice(0, 10);
  return parseLocalDateTime(`${date}T${String(SENDING_HOURS.start).padStart(2, "0")}:00`, zone);
}

/* Queue whatever follow-ups are due. Returns counts. SKIP LOCKED so two
   dispatchers never queue the same one. */
export async function enqueueDueFollowups({ now = new Date(), limit = 25 } = {}) {
  return tx(async (handle) => {
    const due = await handle.query(
      `SELECT c.*
         FROM conversations c
        WHERE c.followup_due_at <= $1
        ORDER BY c.followup_due_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit]
    );
    const summary = { queued: 0, deferred: 0, dropped: 0 };

    for (const conversation of due) {
      const line = await handle.one(`SELECT * FROM lines WHERE id = $1`, [conversation.line_id]);
      const drop = async () => {
        await handle.query(`UPDATE conversations SET followup_due_at = NULL WHERE id = $1`, [conversation.id]);
        summary.dropped += 1;
      };

      const repliedSince = conversation.last_inbound_at &&
        (!conversation.last_textback_at || conversation.last_inbound_at >= conversation.last_textback_at);
      if (!line || !line.followup_enabled || conversation.opted_out_at || conversation.status === "closed" ||
          repliedSince || conversation.followups_sent >= MAX_FOLLOWUPS) {
        await drop();
        continue;
      }
      const entitlement = await entitlementFor(handle, line.company_id, now);
      if (!lineCanText(line, entitlement)) {
        await drop();
        continue;
      }
      if (!withinSendingHours(now, line.timezone)) {
        await handle.query(
          `UPDATE conversations SET followup_due_at = $2 WHERE id = $1`,
          [conversation.id, nextSendingStart(now, line.timezone)]
        );
        summary.deferred += 1;
        continue;
      }
      if (await sentInLastDay(handle, line.id, now) >= line.daily_send_cap) {
        await drop();
        continue;
      }

      const languages = contactLanguages(line, conversation);
      const overrides = await lineTemplates(handle, line.id);
      await enqueueMessage(handle, {
        line, conversationId: conversation.id, kind: "followup", to: conversation.lead_phone,
        body: composeFollowup(line, languages, overrides),
        language: languages.length === 1 ? languages[0] : null,
        now,
      });
      await handle.query(
        `UPDATE conversations SET followups_sent = followups_sent + 1, followup_due_at = NULL WHERE id = $1`,
        [conversation.id]
      );
      summary.queued += 1;
    }
    return summary;
  });
}
