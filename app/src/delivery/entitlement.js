/* Whether a business is currently entitled to text-back.

   Worked out from the trials and clients tables at the moment it matters --
   when a call comes in, when a follow-up falls due -- the same way the dial
   claim expires at read time. There is no job that flips lines off when a
   trial ends, so there is no job whose failure could leave one on (or off).

     active client                         -> on
     active trial, before its end          -> on
     active trial, within 3 days after     -> on, in grace
     anything else                         -> off: calls are still recorded
                                              and greeted, nobody is texted

   Demo lines skip this entirely; see lineCanText. */

export const TRIAL_GRACE_DAYS = 3;
const GRACE_MS = TRIAL_GRACE_DAYS * 24 * 60 * 60 * 1000;

export async function entitlementFor(handle, companyId, now = new Date()) {
  const client = await handle.one(
    `SELECT id FROM clients WHERE company_id = $1 AND status = 'active' LIMIT 1`, [companyId]
  );
  if (client) return { active: true, basis: "client" };

  const trial = await handle.one(
    `SELECT id, status, started_at, ends_at FROM trials
      WHERE company_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [companyId]
  );
  if (!trial) return { active: false, basis: "none" };

  /* "Converted" can be ticked on the trial before the client record is
     entered. Until that record exists, the trial's own window still applies,
     so there is no gap in service between the two steps -- and no service
     past the trial if the second step is forgotten. A converted trial whose
     client has since churned is simply off. */
  let pending = false;
  if (trial.status === "converted") {
    const everClient = await handle.one(`SELECT id FROM clients WHERE company_id = $1 LIMIT 1`, [companyId]);
    if (everClient) return { active: false, basis: "client_churned", trial };
    pending = true;
  } else if (trial.status !== "active") {
    return { active: false, basis: `trial_${trial.status}`, trial };
  }

  const graceEnds = new Date(trial.ends_at.getTime() + GRACE_MS);
  if (now < trial.ends_at) return { active: true, basis: pending ? "converted_pending" : "trial", trial, graceEnds };
  if (now < graceEnds) return { active: true, basis: "grace", trial, graceEnds };
  return { active: false, basis: "trial_ended", trial, graceEnds };
}

/* The one rule for "may this line text a customer right now?" */
export function lineCanText(line, entitlement) {
  return line.status === "active" && (line.is_demo || entitlement.active);
}

export const ENTITLEMENT_LABELS = {
  client: "Paying client",
  trial: "Trial",
  grace: "Trial ended — in grace period",
  trial_ended: "Trial ended — texts paused",
  trial_expired: "Trial expired — texts paused",
  trial_cancelled: "Trial cancelled — texts paused",
  converted_pending: "Trial marked converted — add the client record to keep texting past the trial",
  client_churned: "Client churned — texts paused",
  none: "No trial or client — texts paused",
};
