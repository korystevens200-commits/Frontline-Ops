/* Fixed-window rate limits, counted in Postgres.

   In the database rather than in memory because Fly can run more than one
   machine, and a limit each machine counts separately is a limit multiplied
   by however many are up. One row per bucket, key and window; the maintenance
   pass clears windows older than a day. */
import { query } from "../db.js";

const WINDOW_START = `to_timestamp(floor(extract(epoch FROM now()) / $3) * $3)`;

/* Record one hit and return the count for the current window. */
export async function hit(bucket, key, { windowSeconds }) {
  const rows = await query(
    `INSERT INTO rate_limits (bucket, key, window_start, hits)
     VALUES ($1, $2, ${WINDOW_START}, 1)
     ON CONFLICT (bucket, key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
     RETURNING hits`,
    [bucket, String(key).slice(0, 200), windowSeconds]
  );
  return rows[0].hits;
}

/* The count so far in the current window, without adding to it. */
export async function hits(bucket, key, { windowSeconds }) {
  const rows = await query(
    `SELECT hits FROM rate_limits
      WHERE bucket = $1 AND key = $2 AND window_start = ${WINDOW_START}`,
    [bucket, String(key).slice(0, 200), windowSeconds]
  );
  return rows[0]?.hits ?? 0;
}

export async function purgeRateLimits() {
  const rows = await query(
    `DELETE FROM rate_limits WHERE window_start < now() - interval '1 day' RETURNING 1`
  );
  return rows.length;
}

/* Fly's edge sets Fly-Client-IP to the address it actually saw. The
   X-Forwarded-For chain that request.ip trusts starts with whatever the
   client chose to send, so it is only the fallback for running locally. */
export function clientIp(request) {
  const fly = request.headers["fly-client-ip"];
  return typeof fly === "string" && fly ? fly : request.ip;
}
