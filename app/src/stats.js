/* Counters for Today and the whole of the Numbers page.

   Day bucketing is done in New York, not UTC -- a 9pm dial belongs to the day
   it was actually made, and grouping on raw timestamptz would push every
   evening call into tomorrow. */
import { query } from "./db.js";
import { ZONE } from "./time.js";

export async function todayCounters({ start, end }) {
  const rows = await query(
    `SELECT
       count(*) FILTER (WHERE true)                              AS dials,
       count(*) FILTER (WHERE outcome = 'spoke_to_owner')        AS conversations,
       count(*) FILTER (WHERE outcome = 'trial_agreed')          AS trials_agreed
     FROM calls
     WHERE called_at >= $1 AND called_at < $2`,
    [start, end]
  );
  const trials = await query(
    `SELECT count(*)::int AS n FROM trials WHERE started_at >= $1 AND started_at < $2`,
    [start, end]
  );
  const row = rows[0] ?? {};
  return {
    dials: Number(row.dials ?? 0),
    conversations: Number(row.conversations ?? 0),
    trialsInstalled: Number(trials[0]?.n ?? 0),
  };
}

/* Per-operator split for today, so two people can see their own numbers
   without arguing about who made which call. */
export async function todayByOperator({ start, end }) {
  return query(
    `SELECT called_by,
            count(*)::int                                            AS dials,
            count(*) FILTER (WHERE outcome = 'spoke_to_owner')::int   AS conversations
       FROM calls
      WHERE called_at >= $1 AND called_at < $2
      GROUP BY called_by
      ORDER BY dials DESC`,
    [start, end]
  );
}

export async function funnel() {
  const rows = await query(
    `SELECT
       (SELECT count(*)::int FROM companies)                                          AS companies,
       (SELECT count(*)::int FROM calls)                                              AS dials,
       (SELECT count(DISTINCT company_id)::int FROM calls)                            AS companies_called,
       (SELECT count(*)::int FROM calls WHERE outcome = 'spoke_to_owner')             AS conversations,
       (SELECT count(DISTINCT company_id)::int FROM calls
         WHERE outcome = 'spoke_to_owner')                                            AS companies_reached,
       (SELECT count(*)::int FROM trials)                                             AS trials,
       (SELECT count(*)::int FROM trials WHERE status = 'active')                     AS trials_active,
       (SELECT count(*)::int FROM trials WHERE status = 'converted')                  AS trials_converted,
       (SELECT count(*)::int FROM clients)                                            AS clients_ever,
       (SELECT count(*)::int FROM clients WHERE status = 'active')                    AS clients_active,
       (SELECT count(*)::int FROM clients WHERE status = 'churned')                   AS clients_churned,
       (SELECT COALESCE(sum(monthly_rate), 0)::int FROM clients WHERE status='active') AS mrr_cents,
       (SELECT COALESCE(sum(amount), 0)::int FROM payments WHERE kind = 'setup')      AS setup_cents,
       (SELECT COALESCE(sum(amount), 0)::int FROM payments WHERE kind = 'monthly')    AS monthly_collected_cents,
       (SELECT COALESCE(sum(amount), 0)::int FROM payments)                           AS collected_cents`
  );
  return rows[0];
}

/* Dials per day for the last `days` days, gaps filled with zero so the chart
   shows the days nobody dialled rather than quietly closing the gap. */
export async function dialsPerDay(days = 30) {
  return query(
    `WITH span AS (
       SELECT generate_series(
         (date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1))::date,
         (date_trunc('day', now() AT TIME ZONE $1))::date,
         '1 day'
       )::date AS day
     ),
     counted AS (
       SELECT (called_at AT TIME ZONE $1)::date AS day,
              count(*)::int                     AS n,
              count(*) FILTER (WHERE outcome = 'spoke_to_owner')::int AS conversations
         FROM calls
        WHERE called_at >= (now() - make_interval(days => $2))
        GROUP BY 1
     )
     SELECT span.day,
            COALESCE(counted.n, 0)             AS dials,
            COALESCE(counted.conversations, 0) AS conversations
       FROM span
       LEFT JOIN counted ON counted.day = span.day
      ORDER BY span.day ASC`,
    [ZONE, days]
  );
}

/* Outcome mix -- what actually happens when we dial. */
export async function outcomeBreakdown() {
  return query(
    `SELECT outcome, count(*)::int AS n
       FROM calls
      GROUP BY outcome
      ORDER BY n DESC`
  );
}

/* The qualifying number in aggregate: how many businesses we have reached
   clear the "4 missed calls a week" bar. */
export async function missedCallsProfile() {
  const rows = await query(
    `SELECT
       count(*)::int                                          AS answered,
       count(*) FILTER (WHERE missed_calls_per_week >= 4)::int AS qualified,
       COALESCE(round(avg(missed_calls_per_week)::numeric, 1), 0) AS avg_missed
     FROM calls
     WHERE outcome = 'spoke_to_owner' AND missed_calls_per_week IS NOT NULL`
  );
  return rows[0];
}
