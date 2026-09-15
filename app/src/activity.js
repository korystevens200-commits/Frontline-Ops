/* activity_log is append-only and every mutation writes to it.

   logActivity always takes a transaction handle rather than the module-level
   pool, so it is impossible to record an action that then rolls back, or to
   commit a change whose log entry failed. */

export async function logActivity(handle, { actor, entityType, entityId, action, detail = "" }) {
  await handle.query(
    `INSERT INTO activity_log (actor, entity_type, entity_id, action, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor, entityType, entityId ?? null, action, detail]
  );
}

export async function recentActivity(handle, { entityType, entityId, limit = 50 }) {
  return handle.query(
    `SELECT actor, action, detail, created_at
       FROM activity_log
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [entityType, entityId, limit]
  );
}
