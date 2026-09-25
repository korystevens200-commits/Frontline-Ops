/* Delivery numbers for one line, one business, or everything.

   Counted from the rows on every read, like Phase 1's Numbers page: nothing
   cached, so nothing to drift from what actually happened.

     missed calls       calls that reached the line
     texted             ...that got a text-back
     texts sent         text-backs and follow-ups accepted by the carrier
     delivered          ...confirmed delivered to a handset
     replies            customer messages (keywords like STOP excluded)
     leads captured     conversations whose first reply fell in the window
     follow-ups         follow-ups sent, and how many got a reply after
     opt-outs           customers who texted STOP (or PARAR, ...)
     segments           billed SMS segments, all outbound -- the cost proxy */
import { ZONE, zonedParts, parseLocalDateTime } from "../time.js";

function scopeFor({ lineId = null, companyId = null }, params, alias = "") {
  const column = (name) => (alias ? `${alias}.${name}` : name);
  if (lineId) { params.push(lineId); return `${column("line_id")} = $${params.length}`; }
  if (companyId) { params.push(companyId); return `${column("company_id")} = $${params.length}`; }
  return "true";
}

export async function deliveryMetrics(handle, { lineId = null, companyId = null, from, to = new Date() }) {
  const run = (build) => {
    const params = [from, to];
    const text = build(params);
    return handle.one(text, params);
  };

  const [calls, messages, conversations, followups] = await Promise.all([
    run((p) => `
      SELECT count(*)::int                                          AS missed_calls,
             count(*) FILTER (WHERE decision = 'texted')::int       AS texted,
             count(*) FILTER (WHERE decision = 'no_caller_id')::int AS no_caller_id,
             count(*) FILTER (WHERE decision = 'spam_suspected')::int AS spam_suspected,
             count(*) FILTER (WHERE decision = 'not_entitled')::int AS not_entitled
        FROM missed_calls
       WHERE ${scopeFor({ lineId, companyId }, p)} AND received_at >= $1 AND received_at < $2`),
    run((p) => `
      SELECT count(*) FILTER (WHERE direction = 'outbound' AND kind IN ('textback','followup')
                                AND status IN ('sent','delivered'))::int                 AS texts_sent,
             count(*) FILTER (WHERE direction = 'outbound' AND kind IN ('textback','followup')
                                AND status = 'delivered')::int                          AS delivered,
             count(*) FILTER (WHERE direction = 'outbound' AND kind IN ('textback','followup')
                                AND status IN ('failed','undelivered'))::int            AS failed,
             count(*) FILTER (WHERE direction = 'outbound' AND kind = 'followup'
                                AND status IN ('sent','delivered'))::int                AS followups_sent,
             count(*) FILTER (WHERE direction = 'outbound' AND kind = 'owner_alert'
                                AND status IN ('sent','delivered'))::int                AS owner_alerts,
             count(*) FILTER (WHERE direction = 'inbound' AND kind = 'reply')::int      AS replies,
             COALESCE(sum(segments) FILTER (WHERE direction = 'outbound'
                                AND status IN ('sent','delivered','undelivered')), 0)::int AS segments
        FROM messages
       WHERE ${scopeFor({ lineId, companyId }, p)} AND created_at >= $1 AND created_at < $2`),
    run((p) => `
      SELECT count(*) FILTER (WHERE first_reply_at >= $1 AND first_reply_at < $2)::int AS leads_captured,
             count(*) FILTER (WHERE opted_out_at   >= $1 AND opted_out_at   < $2)::int AS opt_outs
        FROM conversations
       WHERE ${scopeFor({ lineId, companyId }, p)}`),
    run((p) => `
      SELECT count(DISTINCT f.conversation_id)::int AS replied_after_followup
        FROM messages f
       WHERE ${scopeFor({ lineId, companyId }, p, "f")}
         AND f.kind = 'followup' AND f.status IN ('sent','delivered')
         AND f.created_at >= $1 AND f.created_at < $2
         AND EXISTS (SELECT 1 FROM messages r
                      WHERE r.conversation_id = f.conversation_id AND r.direction = 'inbound'
                        AND r.kind = 'reply' AND r.created_at > f.created_at)`),
  ]);

  return { ...calls, ...messages, ...conversations, ...followups };
}

/* Distinct conversations with any message this calendar month (New York),
   against the plan's monthly allowance. */
export async function conversationsThisMonth(handle, lineId, now = new Date()) {
  const p = zonedParts(now, ZONE);
  const monthStart = parseLocalDateTime(`${p.year}-${String(p.month).padStart(2, "0")}-01T00:00`);
  const row = await handle.one(
    `SELECT count(DISTINCT conversation_id)::int AS n FROM messages
      WHERE line_id = $1 AND conversation_id IS NOT NULL AND created_at >= $2`,
    [lineId, monthStart]
  );
  return row.n;
}

export async function lineCounts(handle) {
  return handle.one(
    `SELECT count(*) FILTER (WHERE status = 'active' AND NOT is_demo)::int AS active,
            count(*) FILTER (WHERE status = 'paused')::int                 AS paused,
            count(*) FILTER (WHERE status = 'active' AND is_demo)::int     AS demo
       FROM lines WHERE status <> 'released'`
  );
}
