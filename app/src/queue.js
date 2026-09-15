/* The dial queue and the soft claim.

   Two people work the same list at the same time, so handing them both the
   same prospect is the default failure mode. A claim is a 10-minute hold taken
   the moment a company is handed to someone. It is deliberately soft:

     - it expires on its own, evaluated at read time, so there is no sweeper
       job whose failure would silently freeze the queue
     - it never blocks anyone -- it only reorders who gets handed what, and is
       shown in the UI rather than enforced invisibly
     - re-reading your own queue re-claims the same company and extends the
       hold, so a refresh mid-call never loses your place */

export const CLAIM_MINUTES = 10;

/* Statuses still worth a cold dial. 'callback' lives in the callbacks list
   instead, and the rest are finished one way or another. */
const CALLABLE = ["new", "contacted"];

/* Claim and return the next company for this operator, atomically.

   The whole selection is one statement so two simultaneous requests cannot
   resolve to the same row: the inner SELECT takes a row lock and SKIP LOCKED
   makes a concurrent caller step over a row that is mid-claim rather than
   block on it. */
export async function claimNext(handle, operator, dayStart) {
  const rows = await handle.query(
    `WITH picked AS (
       UPDATE companies
          SET claimed_by = $1, claimed_at = now()
        WHERE id = (
          SELECT c.id
            FROM companies c
           WHERE c.status = ANY($2::text[])
             AND (
               c.claimed_by IS NULL
               OR c.claimed_by = $1
               OR c.claimed_at < now() - make_interval(mins => $3)
             )
             /* Never hand back a business already dialled today. Tier A
                outranks recency in the sort below, so without this the company
                you just logged a no-answer on is immediately the best
                candidate again and the queue spins on one row. */
             AND NOT EXISTS (
               SELECT 1 FROM calls
                WHERE company_id = c.id AND called_at >= $4
             )
           ORDER BY
             /* Whatever is already mine and still held, so a refresh mid-call
                is stable. COALESCE matters: an unclaimed row makes this
                expression NULL, and DESC sorts NULLS FIRST in Postgres, which
                would rank an untouched company above the one in my hand. */
             COALESCE(
               c.claimed_by = $1 AND c.claimed_at >= now() - make_interval(mins => $3),
               false
             ) DESC,
             c.tier ASC,
             (SELECT max(called_at) FROM calls WHERE company_id = c.id) ASC NULLS FIRST,
             c.created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *
     ),
     /* One operator holds one company at a time. Without this, every skip
        would strand a hold until it aged out and "who is on what" would drift
        away from the truth. Disjoint rows from picked, so the two updates in
        this statement never collide. */
     released AS (
       UPDATE companies
          SET claimed_by = NULL, claimed_at = NULL
        WHERE claimed_by = $1
          AND id <> (SELECT id FROM picked)
        RETURNING id
     )
     SELECT * FROM picked`,
    [operator, CALLABLE, CLAIM_MINUTES, dayStart]
  );
  return rows[0] ?? null;
}

/* Release a hold once the call is logged, so the other person can pick the
   company up immediately instead of waiting out the remaining minutes. */
export async function releaseClaim(handle, companyId) {
  await handle.query(
    `UPDATE companies SET claimed_by = NULL, claimed_at = NULL WHERE id = $1`,
    [companyId]
  );
}

/* What everyone else is holding right now -- surfaced on Today so a live claim
   is visible rather than silent. */
export async function claimsByOthers(handle, operator) {
  return handle.query(
    `SELECT id, name, claimed_by, claimed_at
       FROM companies
      WHERE claimed_by IS NOT NULL
        AND claimed_by <> $1
        AND claimed_at >= now() - make_interval(mins => $2)
      ORDER BY claimed_at DESC`,
    [operator, CLAIM_MINUTES]
  );
}

/* Is this specific company held by someone other than the viewer? */
export async function claimHolder(handle, companyId, operator) {
  const rows = await handle.query(
    `SELECT claimed_by, claimed_at
       FROM companies
      WHERE id = $1
        AND claimed_by IS NOT NULL
        AND claimed_by <> $2
        AND claimed_at >= now() - make_interval(mins => $3)`,
    [companyId, operator, CLAIM_MINUTES]
  );
  return rows[0] ?? null;
}

/* Callbacks whose time has arrived -- anything due from the start of today in
   New York through now, still unresolved. These are the real pipeline, so they
   sit above the cold queue on the Today screen. */
export async function callbacksDue(handle, { through }) {
  return handle.query(
    `SELECT c.id, c.name, c.phone, c.tier, c.status, c.niche,
            cb.callback_at, cb.called_by, cb.notes, cb.objection,
            cb.missed_calls_per_week
       FROM companies c
       JOIN LATERAL (
         SELECT * FROM calls
          WHERE company_id = c.id
          ORDER BY called_at DESC
          LIMIT 1
       ) cb ON true
      WHERE c.status = 'callback'
        AND cb.callback_at IS NOT NULL
        AND cb.callback_at <= $1
      ORDER BY cb.callback_at ASC`,
    [through]
  );
}

/* Callbacks still ahead of us today -- shown as "later today" so the queue
   does not look emptier than it is. */
export async function callbacksLater(handle, { from, until }) {
  return handle.query(
    `SELECT c.id, c.name, c.phone, c.tier, c.niche,
            cb.callback_at, cb.called_by, cb.missed_calls_per_week
       FROM companies c
       JOIN LATERAL (
         SELECT * FROM calls
          WHERE company_id = c.id
          ORDER BY called_at DESC
          LIMIT 1
       ) cb ON true
      WHERE c.status = 'callback'
        AND cb.callback_at > $1
        AND cb.callback_at <= $2
      ORDER BY cb.callback_at ASC`,
    [from, until]
  );
}

/* How much cold queue is left, so the Today screen can say so. */
export async function queueDepth(handle, dayStart) {
  const rows = await handle.query(
    `SELECT tier, count(*)::int AS n
       FROM companies c
      WHERE c.status = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM calls WHERE company_id = c.id AND called_at >= $2
        )
      GROUP BY tier`,
    [CALLABLE, dayStart]
  );
  const depth = { A: 0, B: 0, total: 0 };
  for (const row of rows) {
    depth[row.tier] = row.n;
    depth.total += row.n;
  }
  return depth;
}
