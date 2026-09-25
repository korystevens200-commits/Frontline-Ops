/* The outbox: how every text leaves.

   Nothing sends inline. A webhook handler writes the message as 'queued' in
   the same transaction as whatever caused it, answers Twilio, and kicks the
   dispatcher, which sends it a moment later -- typically within a second or
   two of the call. If that send fails, the row is still there to retry.

   Claiming uses FOR UPDATE SKIP LOCKED, the same technique as the dial queue,
   so two machines running the dispatcher never send the same text.

   Retry policy, from the provider's classification of the failure:
     retryable  (never reached Twilio, 429, 5xx)  -> back off and try again,
                                                     up to MAX_ATTEMPTS
     ambiguous  (timed out after sending)         -> 'unknown', never retried:
                                                     one missing text is better
                                                     than two identical ones
     permanent  (bad number, opted out)           -> 'failed'

   Health is visible rather than assumed: outboxHealth() feeds Today and
   Numbers, so a stalled sender shows up on a screen instead of in a
   complaint. */
import { query, one, tx } from "../db.js";
import { countSegments } from "./segments.js";
import { ProviderError, statusAdvances } from "../providers/common.js";
import { purgeRateLimits } from "../security/ratelimit.js";

export const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_SECONDS = [15, 60, 300, 900];
export const STUCK_AFTER_SECONDS = 120;
export const STALLED_AFTER_SECONDS = 120;

/* Messages to the customer. They stop for an opt-out; alerts and tests go to
   the owner, and an opt-out confirmation must go regardless. */
const TO_LEAD = new Set(["textback", "followup"]);
const UPDATES_CONVERSATION = new Set(["textback", "followup", "optout_confirm"]);

export async function enqueueMessage(handle, {
  line, conversationId = null, kind, to, body, language = null, now = new Date(),
}) {
  const { encoding, segments } = countSegments(body);
  return handle.one(
    `INSERT INTO messages
       (company_id, line_id, conversation_id, direction, kind, from_number, to_number,
        body, language, encoding, segments, status, next_attempt_at, created_at)
     VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $11)
     RETURNING *`,
    [line.company_id, line.id, conversationId, kind, line.number, to,
     body, language, encoding, segments, now]
  );
}

/* Outbound texts from this line in the last 24 hours, for the per-line cap. */
export async function sentInLastDay(handle, lineId, now = new Date()) {
  const row = await handle.one(
    `SELECT count(*)::int AS n FROM messages
      WHERE line_id = $1 AND direction = 'outbound' AND status <> 'cancelled'
        AND created_at > $2::timestamptz - interval '24 hours'`,
    [lineId, now]
  );
  return row.n;
}

/* Cancel anything still waiting to go to this conversation's customer. */
export async function cancelQueuedForConversation(handle, conversationId, kinds, reason) {
  await handle.query(
    `UPDATE messages SET status = 'cancelled', error_message = $3, next_attempt_at = NULL
      WHERE conversation_id = $1 AND status = 'queued' AND kind = ANY($2::text[])`,
    [conversationId, kinds, reason]
  );
}

/* Claim and send whatever is due. Returns counts by outcome. */
export async function dispatchOnce({ provider, now = new Date(), limit = 20, log = null }) {
  const summary = { claimed: 0, sent: 0, retried: 0, failed: 0, unknown: 0, cancelled: 0 };
  if (!provider?.enabled) return summary;

  const claimed = await tx((handle) => handle.query(
    `UPDATE messages
        SET status = 'sending', attempts = attempts + 1, last_attempt_at = $2
      WHERE id IN (
        SELECT id FROM messages
         WHERE status = 'queued' AND next_attempt_at <= $2
         ORDER BY next_attempt_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit, now]
  ));
  summary.claimed = claimed.length;

  for (const message of claimed) {
    const outcome = await deliver(message, provider, now, log);
    summary[outcome] += 1;
  }
  return summary;
}

async function deliver(message, provider, now, log) {
  /* Last look before a text leaves: the customer may have opted out, or the
     line been paused, since this was queued. */
  const context = await one(
    `SELECT l.status AS line_status, l.messaging_service_sid, c.opted_out_at
       FROM lines l LEFT JOIN conversations c ON c.id = $2
      WHERE l.id = $1`,
    [message.line_id, message.conversation_id]
  );
  const blocked =
    !context ? "Line no longer exists." :
    message.kind !== "optout_confirm" && context.line_status !== "active" ? `Line is ${context.line_status}.` :
    TO_LEAD.has(message.kind) && context.opted_out_at ? "Customer opted out." :
    null;
  if (blocked) {
    await query(
      `UPDATE messages SET status = 'cancelled', error_message = $2, next_attempt_at = NULL
        WHERE id = $1 AND status = 'sending'`,
      [message.id, blocked]
    );
    return "cancelled";
  }

  try {
    const result = await provider.sendMessage({
      from: message.from_number,
      to: message.to_number,
      body: message.body,
      messagingServiceSid: context.messaging_service_sid,
      /* Our own id rides on the callback URL, so a receipt that beats the
         UPDATE below to the database still finds its row. */
      statusCallback: provider.webhookUrl("message-status", `?m=${message.id}`),
    });
    await tx(async (handle) => {
      await handle.query(
        `UPDATE messages
            SET provider_sid = COALESCE(provider_sid, $2),
                status = CASE WHEN status = 'sending' THEN 'sent' ELSE status END,
                sent_at = COALESCE(sent_at, $3), error_code = '', error_message = '',
                next_attempt_at = NULL
          WHERE id = $1`,
        [message.id, result.sid, now]
      );
      if (message.conversation_id && UPDATES_CONVERSATION.has(message.kind)) {
        await handle.query(
          `UPDATE conversations SET last_outbound_at = $2 WHERE id = $1`,
          [message.conversation_id, now]
        );
      }
    });
    return "sent";
  } catch (err) {
    const failure = err instanceof ProviderError
      ? err
      : new ProviderError(err?.message ?? String(err), { code: "internal", retryable: true });
    /* Never the body or the phone numbers: the id is enough to look it up. */
    log?.warn({ messageId: message.id, kind: message.kind, code: failure.code, attempt: message.attempts },
              "text send failed");

    if (failure.ambiguous) {
      await markOutcome(message.id, "unknown", failure);
      return "unknown";
    }
    if (failure.retryable && message.attempts < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_SECONDS[Math.min(message.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
      await query(
        `UPDATE messages SET status = 'queued', error_code = $2, error_message = $3,
                next_attempt_at = $4::timestamptz + make_interval(secs => $5)
          WHERE id = $1 AND status = 'sending'`,
        [message.id, failure.code, failure.message.slice(0, 300), now, delay]
      );
      return "retried";
    }
    await tx(async (handle) => {
      await handle.query(
        `UPDATE messages SET status = 'failed', error_code = $2, error_message = $3, next_attempt_at = NULL
          WHERE id = $1 AND status = 'sending'`,
        [message.id, failure.code, failure.message.slice(0, 300)]
      );
      await applyPermanentError(handle, message, failure.code, now);
    });
    return "failed";
  }
}

async function markOutcome(id, status, failure) {
  await query(
    `UPDATE messages SET status = $2, error_code = $3, error_message = $4, next_attempt_at = NULL
      WHERE id = $1 AND status = 'sending'`,
    [id, status, failure.code, failure.message.slice(0, 300)]
  );
}

/* Some refusals say something about the customer, not the message. */
async function applyPermanentError(handle, message, code, now) {
  /* 21610: they replied STOP to this number at some point. Honour it here
     too, so no follow-up is even queued. */
  if (code === "21610" && message.conversation_id && TO_LEAD.has(message.kind)) {
    await handle.query(
      `UPDATE conversations SET opted_out_at = COALESCE(opted_out_at, $2), followup_due_at = NULL
        WHERE id = $1`,
      [message.conversation_id, now]
    );
  }
}

/* A delivery receipt. `messageId` comes from our own callback URL; the sid
   from Twilio. Either is enough to find the row, and when both are present
   they must agree. Moves the status forward only. */
export async function applyDeliveryStatus({ messageId = null, messageSid = "", status, errorCode = "", errorMessage = "", now = new Date() }) {
  return tx(async (handle) => {
    const message = messageId
      ? await handle.one(`SELECT * FROM messages WHERE id = $1 FOR UPDATE`, [messageId])
      : await handle.one(`SELECT * FROM messages WHERE provider_sid = $1 FOR UPDATE`, [messageSid]);
    if (!message || message.direction !== "outbound") return { found: false };
    if (messageSid && message.provider_sid && message.provider_sid !== messageSid) {
      return { found: false, mismatch: true };
    }
    if (!status || !statusAdvances(message.status, status)) {
      if (messageSid && !message.provider_sid) {
        await handle.query(`UPDATE messages SET provider_sid = $2 WHERE id = $1`, [message.id, messageSid]);
      }
      return { found: true, changed: false, message };
    }
    await handle.query(
      `UPDATE messages
          SET status = $2,
              provider_sid = COALESCE(provider_sid, NULLIF($3, '')),
              error_code = CASE WHEN $4 <> '' THEN $4 ELSE error_code END,
              error_message = CASE WHEN $5 <> '' THEN $5 ELSE error_message END,
              delivered_at = CASE WHEN $2 = 'delivered' THEN $6::timestamptz ELSE delivered_at END,
              sent_at = COALESCE(sent_at, $6::timestamptz),
              next_attempt_at = NULL
        WHERE id = $1`,
      [message.id, status, messageSid, errorCode, errorMessage, now]
    );
    if (status === "failed" || status === "undelivered") {
      await applyPermanentError(handle, message, errorCode, now);
    }
    return { found: true, changed: true, message };
  });
}

/* Housekeeping, run every few minutes by the dispatcher. */
export async function runMaintenance({ now = new Date() } = {}) {
  /* A process that died between claiming a text and recording the result
     leaves it 'sending'. Whether it went out is unknowable, so it is marked
     that way and left for a person to judge -- never re-sent automatically. */
  const stuck = await query(
    `UPDATE messages
        SET status = 'unknown',
            error_message = 'The send was interrupted; it may or may not have gone out.'
      WHERE status = 'sending'
        AND last_attempt_at < $1::timestamptz - make_interval(secs => $2)
      RETURNING id`,
    [now, STUCK_AFTER_SECONDS]
  );
  /* Raw payloads carry customer text: 30 days, then gone. */
  await query(`DELETE FROM provider_events WHERE received_at < $1::timestamptz - interval '30 days'`, [now]);
  await query(`DELETE FROM import_batches WHERE created_at < $1::timestamptz - interval '7 days'`, [now]);
  await purgeRateLimits();
  return { stuck: stuck.length };
}

export async function outboxHealth({ now = new Date() } = {}) {
  const row = await one(
    `SELECT
       count(*) FILTER (WHERE status = 'queued')::int                                  AS queued,
       COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - min(next_attempt_at) FILTER (WHERE status = 'queued'))), 0)::int
                                                                                       AS oldest_due_seconds,
       count(*) FILTER (WHERE status IN ('failed','undelivered')
                          AND created_at > $1::timestamptz - interval '24 hours')::int  AS failed_24h,
       count(*) FILTER (WHERE status = 'unknown')::int                                 AS unknown_7d,
       count(*) FILTER (WHERE error_code = '30007')::int                               AS carrier_filtered_7d
     FROM messages
     WHERE direction = 'outbound'
       AND (status = 'queued' OR created_at > $1::timestamptz - interval '7 days')`,
    [now]
  );
  return { ...row, stalled: row.queued > 0 && row.oldest_due_seconds > STALLED_AFTER_SECONDS };
}
