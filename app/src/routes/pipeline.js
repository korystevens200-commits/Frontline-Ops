/* Pipeline: every company, filtered, sorted, searched.

   Filter values are bound as parameters; the sort is chosen from a whitelist
   and never interpolated from user input, so there is no path from the query
   string into the SQL text. */
import { query } from "../db.js";
import { pipelinePage, SORTS, CALLED_WINDOWS } from "../views/pipeline.js";
import { COMPANY_STATUSES } from "../views/components.js";
import { flashFrom } from "../flash.js";
import { nyDayBounds } from "../time.js";

const PAGE_SIZE = 50;

const SORT_SQL = {
  tier:         "c.tier ASC, last_called_at ASC NULLS FIRST, c.created_at ASC",
  name:         "c.name ASC",
  last_called:  "last_called_at ASC NULLS FIRST, c.name ASC",
  recent_call:  "last_called_at DESC NULLS LAST, c.name ASC",
  missed_calls: "best_missed_calls DESC NULLS LAST, c.name ASC",
  rating:       "c.google_rating DESC NULLS LAST, c.review_count DESC NULLS LAST",
  reviews:      "c.review_count DESC NULLS LAST, c.google_rating DESC NULLS LAST",
  created:      "c.created_at DESC",
};

const SORT_VALUES = SORTS.map((s) => s.value);
const CALLED_VALUES = CALLED_WINDOWS.map((w) => w.value);

function pick(value, allowed, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return allowed.includes(text) ? text : fallback;
}

export default async function pipelineRoutes(app) {
  app.get("/pipeline", async (request, reply) => {
    const q = String(request.query?.q ?? "").trim().slice(0, 120);
    const filters = {
      q,
      status: pick(request.query?.status, COMPANY_STATUSES),
      tier:   pick(request.query?.tier, ["A", "B"]),
      niche:  String(request.query?.niche ?? "").trim().slice(0, 80),
      called: pick(request.query?.called, CALLED_VALUES),
      sort:   pick(request.query?.sort, SORT_VALUES, "tier"),
    };

    const pageNumber = Number(request.query?.page);
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;

    const where = [];
    const params = [];
    const bind = (value) => `$${params.push(value)}`;

    if (filters.status) where.push(`c.status = ${bind(filters.status)}`);
    if (filters.tier)   where.push(`c.tier = ${bind(filters.tier)}`);
    if (filters.niche)  where.push(`c.niche = ${bind(filters.niche)}`);

    if (q) {
      /* Name match is fuzzy; phone match strips formatting from both sides so
         "305 555" finds +13055551234. */
      const digits = q.replace(/\D/g, "");
      const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      if (digits.length >= 3) {
        where.push(`(c.name ILIKE ${bind(like)} ESCAPE '\\' OR c.phone LIKE ${bind(`%${digits}%`)})`);
      } else {
        where.push(`c.name ILIKE ${bind(like)} ESCAPE '\\'`);
      }
    }

    const { start: todayStart } = nyDayBounds();
    if (filters.called === "never") {
      where.push(`last_called_at IS NULL`);
    } else if (filters.called === "today") {
      where.push(`last_called_at >= ${bind(todayStart)}`);
    } else if (filters.called === "7d") {
      where.push(`last_called_at >= now() - interval '7 days'`);
    } else if (filters.called === "30d") {
      where.push(`last_called_at >= now() - interval '30 days'`);
    } else if (filters.called === "stale") {
      where.push(`(last_called_at IS NULL OR last_called_at < now() - interval '30 days')`);
    }

    /* The call aggregate is computed once in a CTE so the filters, the sort and
       the count all see the same derived columns. */
    const base = `
      WITH enriched AS (
        SELECT c.*,
               agg.last_called_at,
               agg.call_count,
               agg.best_missed_calls
          FROM companies c
          LEFT JOIN LATERAL (
            SELECT max(called_at)                  AS last_called_at,
                   count(*)::int                   AS call_count,
                   max(missed_calls_per_week)      AS best_missed_calls
              FROM calls WHERE company_id = c.id
          ) agg ON true
      )
      SELECT * FROM enriched c
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

    const countRows = await query(`SELECT count(*)::int AS n FROM (${base}) t`, params);
    const total = countRows[0]?.n ?? 0;

    const offset = (page - 1) * PAGE_SIZE;
    const rows = await query(
      `${base} ORDER BY ${SORT_SQL[filters.sort]} LIMIT ${bind(PAGE_SIZE)} OFFSET ${bind(offset)}`,
      params
    );

    const niches = (await query(
      `SELECT DISTINCT niche FROM companies WHERE niche <> '' ORDER BY niche`
    )).map((r) => r.niche);

    reply.type("text/html; charset=utf-8");
    return pipelinePage({
      operator: request.operator, rows, total, filters, niches,
      page, pageSize: PAGE_SIZE, flash: flashFrom(request),
    }).value;
  });
}
