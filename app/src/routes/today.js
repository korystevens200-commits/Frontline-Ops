/* Today: the dial queue, the outcome buttons, and the callbacks that are due. */
import { query, one } from "../db.js";
import { claimNext, claimsByOthers, callbacksDue, callbacksLater, queueDepth } from "../queue.js";
import { todayCounters, todayByOperator } from "../stats.js";
import { nyDayBounds, parseLocalDateTime, toLocalInputValue } from "../time.js";
import { logCall, OUTCOMES_NEEDING_DETAIL } from "../calls.js";
import { todayPage, logDetailPage } from "../views/today.js";
import { flashFrom, errorRedirect } from "../flash.js";
import {
  requireId, requireEnum, optionalString, optionalInt, requireInt, ValidationError,
} from "../validate.js";

const SIMPLE_OUTCOMES = ["no_answer", "gatekeeper", "not_interested", "dead"];
const DETAIL_OUTCOMES = OUTCOMES_NEEDING_DETAIL;

export default async function todayRoutes(app) {
  app.get("/today", async (request, reply) => {
    const operator = request.operator;
    const { start, end } = nyDayBounds();
    const handle = { query, one };

    /* Claiming is a write on a GET. It is the one place that trade is worth
       making: any confirm step between opening the screen and being handed a
       number is a tap in the way of the next call, and the claim is
       self-expiring, idempotent for the same operator, and visible to both
       people. */
    const company = await claimNext(handle, operator, start);

    const [counters, byOperator, due, later, others, depth] = await Promise.all([
      todayCounters({ start, end }),
      todayByOperator({ start, end }),
      callbacksDue(handle, { through: new Date() }),
      callbacksLater(handle, { from: new Date(), until: end }),
      claimsByOthers(handle, operator),
      queueDepth(handle, start),
    ]);

    let enriched = company;
    if (company) {
      const history = await one(
        `SELECT max(called_at) AS last_called_at, count(*)::int AS call_count
           FROM calls WHERE company_id = $1`,
        [company.id]
      );
      enriched = { ...company, ...history };
    }

    reply.type("text/html; charset=utf-8");
    return todayPage({
      operator, company: enriched, counters, callbacksDue: due, callbacksLater: later,
      othersClaims: others, depth, byOperator, flash: flashFrom(request),
    }).value;
  });

  /* One-tap outcomes: no extra data to collect, so log and go straight back
     to a fresh queue. */
  app.post("/today/outcome", async (request, reply) => {
    const operator = request.operator;
    try {
      const companyId = requireId(request.body?.company_id, "company");
      const outcome = requireEnum(request.body?.outcome, "outcome", SIMPLE_OUTCOMES);
      await logCall({ companyId, operator, outcome });
      reply.redirect("/today?ok=logged", 303);
    } catch (err) {
      request.log.error({ err }, "outcome log failed");
      reply.redirect(
        err instanceof ValidationError
          ? errorRedirect("/today", err.message)
          : "/today?err=save_failed",
        303
      );
    }
  });

  /* Second screen for the outcomes that carry data. */
  app.get("/today/log", async (request, reply) => {
    const operator = request.operator;
    let companyId, outcome;
    try {
      companyId = requireId(request.query?.company, "company");
      outcome = requireEnum(request.query?.outcome, "outcome", DETAIL_OUTCOMES);
    } catch {
      reply.redirect("/today?err=bad_outcome", 303);
      return;
    }

    const company = await one(`SELECT * FROM companies WHERE id = $1`, [companyId]);
    if (!company) {
      reply.redirect("/today?err=not_found", 303);
      return;
    }

    /* Default a callback to the same time tomorrow -- the most common case,
       and it means the picker opens somewhere useful. */
    const values = {};
    if (outcome === "callback") {
      values.callback_at = toLocalInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
    }

    reply.type("text/html; charset=utf-8");
    return logDetailPage({
      operator, company, outcome, values,
      error: request.query?.msg ? String(request.query.msg).slice(0, 300) : null,
    }).value;
  });

  app.post("/today/log", async (request, reply) => {
    const operator = request.operator;
    const body = request.body ?? {};
    let companyId = null;
    let outcome = null;

    try {
      companyId = requireId(body.company_id, "company");
      outcome = requireEnum(body.outcome, "outcome", DETAIL_OUTCOMES);

      const notes = optionalString(body.notes, "Notes", { max: 4000 });
      const objection = optionalString(body.objection, "Objection", { max: 300 });

      /* The qualifying number. Required on spoke_to_owner, optional on a trial
         (the answer sometimes never comes up once they have said yes). */
      const missed = outcome === "spoke_to_owner"
        ? requireInt(body.missed_calls_per_week, "Missed calls per week", { min: 0, max: 500 })
        : optionalInt(body.missed_calls_per_week, "Missed calls per week", { min: 0, max: 500 });

      let callbackAt = null;
      if (outcome === "callback") {
        callbackAt = parseLocalDateTime(body.callback_at);
        if (!callbackAt) throw new ValidationError("Enter a valid callback date and time.", "callback_at");
      }

      const result = await logCall({
        companyId, operator, outcome,
        missedCallsPerWeek: missed, objection, notes, callbackAt,
      });

      reply.redirect(result.trial ? "/today?ok=trial_started" : "/today?ok=logged", 303);
    } catch (err) {
      request.log.error({ err }, "detail log failed");
      const back = `/today/log?company=${companyId ?? ""}&outcome=${outcome ?? ""}`;
      reply.redirect(
        err instanceof ValidationError
          ? errorRedirect(back, err.message)
          : errorRedirect(back, "Save failed — nothing was written. Try again."),
        303
      );
    }
  });
}
