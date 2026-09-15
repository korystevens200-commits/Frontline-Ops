/* Logging a call.

   Every outcome does several things at once: records the call, moves the
   company's status, releases the dial claim, and sometimes opens a trial. All
   of it happens in one transaction alongside the activity_log row, so the
   pipeline can never disagree with the call history. */
import { tx } from "./db.js";
import { logActivity } from "./activity.js";
import { releaseClaim } from "./queue.js";
import { ValidationError } from "./validate.js";

/* Outcome -> company status. Deterministic, no special cases at the call site. */
const STATUS_FOR_OUTCOME = {
  no_answer: "contacted",
  gatekeeper: "contacted",
  spoke_to_owner: "contacted",
  not_interested: "not_interested",
  callback: "callback",
  trial_agreed: "trial",
  dead: "dead",
};

export const OUTCOME_VALUES = Object.keys(STATUS_FOR_OUTCOME);

/* Outcomes that need more than one tap, because they carry data worth having. */
export const OUTCOMES_NEEDING_DETAIL = ["spoke_to_owner", "callback", "trial_agreed"];

export const TRIAL_DAYS = 14;

export async function logCall({
  companyId,
  operator,
  outcome,
  missedCallsPerWeek = null,
  objection = "",
  notes = "",
  callbackAt = null,
  contactId = null,
}) {
  if (!STATUS_FOR_OUTCOME[outcome]) {
    throw new ValidationError("Unknown outcome.", "outcome");
  }
  /* Mirrors the CHECK constraint in the schema. Enforced here too so the
     person gets a usable message instead of a 500 from Postgres. */
  if (outcome === "spoke_to_owner" && (missedCallsPerWeek === null || missedCallsPerWeek === undefined)) {
    throw new ValidationError("Missed calls per week is required when you spoke to the owner.",
                              "missed_calls_per_week");
  }
  if (outcome === "callback" && !callbackAt) {
    throw new ValidationError("A callback needs a date and time.", "callback_at");
  }

  return tx(async (handle) => {
    const company = await handle.one(`SELECT * FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
    if (!company) throw new ValidationError("That company no longer exists.", "company_id");

    const call = await handle.one(
      `INSERT INTO calls (company_id, contact_id, called_by, outcome,
                          missed_calls_per_week, objection, notes, callback_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyId, contactId, operator, outcome, missedCallsPerWeek, objection, notes, callbackAt]
    );

    const nextStatus = STATUS_FOR_OUTCOME[outcome];
    /* A company that already converted is not demoted by a later stray call. */
    const keepStatus = company.status === "client";
    if (!keepStatus && company.status !== nextStatus) {
      await handle.query(`UPDATE companies SET status = $1 WHERE id = $2`, [nextStatus, companyId]);
    }

    /* The hold is done the moment the call is logged -- the other person can
       pick this company up now rather than waiting out the remaining minutes. */
    await releaseClaim(handle, companyId);

    let trial = null;
    if (outcome === "trial_agreed") {
      /* Re-agreeing on a company that already has a live trial should not open
         a second one. */
      const existing = await handle.one(
        `SELECT id FROM trials WHERE company_id = $1 AND status = 'active'`, [companyId]
      );
      if (!existing) {
        trial = await handle.one(
          `INSERT INTO trials (company_id, started_at, ends_at, installed_by, status, notes)
           VALUES ($1, now(), now() + make_interval(days => $2), $3, 'active', $4)
           RETURNING *`,
          [companyId, TRIAL_DAYS, operator, notes]
        );
        await logActivity(handle, {
          actor: operator, entityType: "trial", entityId: trial.id, action: "trial_started",
          detail: `${company.name} — ${TRIAL_DAYS}-day trial`,
        });
      }
    }

    await logActivity(handle, {
      actor: operator,
      entityType: "call",
      entityId: call.id,
      action: `call_${outcome}`,
      detail: buildDetail(company, outcome, missedCallsPerWeek, objection),
    });

    return { call, company, trial };
  });
}

function buildDetail(company, outcome, missedCallsPerWeek, objection) {
  const bits = [company.name];
  if (missedCallsPerWeek !== null && missedCallsPerWeek !== undefined) {
    bits.push(`${missedCallsPerWeek} missed calls/wk`);
  }
  if (objection) bits.push(`objection: ${objection}`);
  return bits.join(" — ");
}
