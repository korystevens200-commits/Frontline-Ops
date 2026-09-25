/* What about text-back needs a person, for the Today screen.

   Trials that are about to stop texting are the one thing here that loses
   money if nobody looks: a business that loved its trial finds out it ended
   when a customer does not get a text. Flagged two days ahead, through the
   grace period, and for two weeks after, so nothing falls off silently. */
import { TRIAL_GRACE_DAYS } from "./entitlement.js";
import { outboxHealth } from "./outbox.js";

const WARN_DAYS_AHEAD = 2;
const STOP_NAGGING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function trialsNeedingAttention(handle, now = new Date()) {
  const rows = await handle.query(
    `SELECT l.id AS line_id, l.company_id, co.name AS company_name, t.ends_at
       FROM lines l
       JOIN companies co ON co.id = l.company_id
       JOIN LATERAL (
         SELECT status, ends_at FROM trials
          WHERE company_id = l.company_id
          ORDER BY started_at DESC, id DESC
          LIMIT 1
       ) t ON true
      WHERE l.status <> 'released' AND NOT l.is_demo
        AND NOT EXISTS (SELECT 1 FROM clients WHERE company_id = l.company_id AND status = 'active')
        AND (t.status = 'active' OR
             (t.status = 'converted' AND NOT EXISTS (SELECT 1 FROM clients WHERE company_id = l.company_id)))
        AND t.ends_at < $1::timestamptz + make_interval(days => $2)
        AND t.ends_at > $1::timestamptz - make_interval(days => $3)
      ORDER BY t.ends_at`,
    [now, WARN_DAYS_AHEAD, STOP_NAGGING_DAYS]
  );
  return rows.map((row) => {
    const graceEnds = new Date(row.ends_at.getTime() + TRIAL_GRACE_DAYS * DAY_MS);
    const state = now < row.ends_at ? "ending" : now < graceEnds ? "grace" : "stopped";
    return { ...row, graceEnds, state };
  });
}

/* Everything Today needs about delivery, in one call. */
export async function deliveryAttention(handle, provider, now = new Date()) {
  const [trials, health, live] = await Promise.all([
    trialsNeedingAttention(handle, now),
    outboxHealth({ now }),
    handle.one(`SELECT count(*)::int AS n FROM lines WHERE status = 'active'`),
  ]);
  return {
    trials,
    health,
    /* Only worth shouting about once there is a line depending on it. */
    providerDown: !provider.enabled && live.n > 0,
    providerReason: provider.reason,
  };
}
