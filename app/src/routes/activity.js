/* The append-only audit trail, readable. */
import { query } from "../db.js";
import { activityPage } from "../views/activity.js";
import { flashFrom } from "../flash.js";

const PAGE_SIZE = 60;
const ENTITY_TYPES = ["call", "company", "trial", "client", "import"];

export default async function activityRoutes(app) {
  app.get("/activity", async (request, reply) => {
    const actor = String(request.query?.actor ?? "").trim().slice(0, 80);
    const entity = ENTITY_TYPES.includes(String(request.query?.entity ?? "").trim())
      ? String(request.query.entity).trim() : "";
    const pageNumber = Number(request.query?.page);
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;

    const where = [];
    const params = [];
    const bind = (value) => `$${params.push(value)}`;
    if (actor)  where.push(`actor = ${bind(actor)}`);
    if (entity) where.push(`entity_type = ${bind(entity)}`);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = (await query(`SELECT count(*)::int AS n FROM activity_log ${clause}`, params))[0].n;
    const rows = await query(
      `SELECT * FROM activity_log ${clause} ORDER BY created_at DESC, id DESC
       LIMIT ${bind(PAGE_SIZE)} OFFSET ${bind((page - 1) * PAGE_SIZE)}`,
      params
    );
    const actors = (await query(`SELECT DISTINCT actor FROM activity_log ORDER BY actor`))
      .map((r) => r.actor);

    reply.type("text/html; charset=utf-8");
    return activityPage({
      operator: request.operator, rows, actors,
      filters: { actor, entity },
      page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      flash: flashFrom(request),
    }).value;
  });
}
