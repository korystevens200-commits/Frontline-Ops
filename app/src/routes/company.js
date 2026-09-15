/* One company: history, contacts, trial, client, payments.

   This is also where a callback gets closed out -- the Today list links
   straight here, so the call form accepts every outcome rather than the
   queue's fast subset. */
import { query, one, tx } from "../db.js";
import { logActivity, recentActivity } from "../activity.js";
import { logCall, OUTCOME_VALUES } from "../calls.js";
import { companyPage } from "../views/company.js";
import { flashFrom, errorRedirect } from "../flash.js";
import { parseLocalDateTime } from "../time.js";
import { COMPANY_STATUSES } from "../views/components.js";
import {
  requireId, requireString, optionalString, requireEnum, optionalInt,
  requireMoneyCents, normalizePhone, ValidationError,
} from "../validate.js";

async function loadCompany(companyId) {
  return one(`SELECT * FROM companies WHERE id = $1`, [companyId]);
}

/* Resolve where to send someone back to BEFORE any validation runs. Without
   this, a mistyped amount bounces to /pipeline and they lose the record they
   were working on. */
async function companyPathForClient(clientId) {
  const row = await one(`SELECT company_id FROM clients WHERE id = $1`, [clientId]);
  return row ? `/company/${row.company_id}` : "/pipeline";
}

async function companyPathForTrial(trialId) {
  const row = await one(`SELECT company_id FROM trials WHERE id = $1`, [trialId]);
  return row ? `/company/${row.company_id}` : "/pipeline";
}

export default async function companyRoutes(app) {
  app.get("/company/:id", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const company = await loadCompany(companyId);
    if (!company) {
      reply.code(404).type("text/html; charset=utf-8");
      reply.redirect("/pipeline?err=not_found", 303);
      return;
    }

    const [contacts, calls, trials, client, activity] = await Promise.all([
      query(`SELECT * FROM contacts WHERE company_id = $1 ORDER BY created_at ASC`, [companyId]),
      query(`SELECT * FROM calls WHERE company_id = $1 ORDER BY called_at DESC`, [companyId]),
      query(`SELECT * FROM trials WHERE company_id = $1 ORDER BY started_at DESC`, [companyId]),
      one(`SELECT * FROM clients WHERE company_id = $1 ORDER BY started_at DESC LIMIT 1`, [companyId]),
      recentActivity({ query, one }, { entityType: "company", entityId: companyId, limit: 30 }),
    ]);

    const payments = client
      ? await query(`SELECT * FROM payments WHERE client_id = $1 ORDER BY paid_at DESC`, [client.id])
      : [];

    reply.type("text/html; charset=utf-8");
    return companyPage({
      operator: request.operator, company, contacts, calls, trials, client, payments,
      activity, flash: flashFrom(request),
      error: request.query?.msg ? String(request.query.msg).slice(0, 300) : null,
    }).value;
  });

  /* Log a call from the record -- the path a returned callback takes. */
  app.post("/company/:id/call", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const back = `/company/${companyId}`;
    try {
      const body = request.body ?? {};
      const outcome = requireEnum(body.outcome, "outcome", OUTCOME_VALUES);
      const missed = optionalInt(body.missed_calls_per_week, "Missed calls per week", { min: 0, max: 500 });
      const objection = optionalString(body.objection, "Objection", { max: 300 });
      const notes = optionalString(body.notes, "Notes", { max: 4000 });

      let callbackAt = null;
      if (body.callback_at) {
        callbackAt = parseLocalDateTime(body.callback_at);
        if (!callbackAt) throw new ValidationError("Enter a valid callback date and time.", "callback_at");
      }
      if (outcome === "callback" && !callbackAt) {
        throw new ValidationError("A callback needs a date and time.", "callback_at");
      }
      if (outcome === "spoke_to_owner" && missed === null) {
        throw new ValidationError("Missed calls per week is required when you spoke to the owner.",
                                  "missed_calls_per_week");
      }

      await logCall({
        companyId, operator: request.operator, outcome,
        missedCallsPerWeek: missed, objection, notes, callbackAt,
      });
      reply.redirect(`${back}?ok=logged`, 303);
    } catch (err) {
      request.log.error({ err }, "company call log failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed — nothing was written."), 303);
    }
  });

  app.post("/company/:id/notes", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const back = `/company/${companyId}`;
    try {
      const notes = optionalString(request.body?.notes, "Notes", { max: 4000 });
      const status = requireEnum(request.body?.status, "Status", COMPANY_STATUSES);

      await tx(async (handle) => {
        const before = await handle.one(`SELECT status FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
        if (!before) throw new ValidationError("That company no longer exists.");
        await handle.query(`UPDATE companies SET notes = $1, status = $2 WHERE id = $3`,
                           [notes, status, companyId]);
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: companyId,
          action: "company_updated",
          detail: before.status === status ? "notes updated" : `status ${before.status} → ${status}`,
        });
      });
      reply.redirect(`${back}?ok=note_saved`, 303);
    } catch (err) {
      request.log.error({ err }, "company notes save failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed — nothing was written."), 303);
    }
  });

  app.post("/company/:id/contact", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const back = `/company/${companyId}`;
    try {
      const body = request.body ?? {};
      const name = requireString(body.name, "Name", { max: 120 });
      const role = optionalString(body.role, "Role", { max: 80 });
      const notes = optionalString(body.notes, "Notes", { max: 500 });
      const language = requireEnum(body.preferred_language || "es", "Language", ["es", "en"]);

      /* A contact phone is optional, but a typo should not be stored as one. */
      let phone = "";
      if (String(body.phone ?? "").trim()) {
        phone = normalizePhone(body.phone) ?? "";
        if (!phone) throw new ValidationError("That phone number is not valid.", "phone");
      }

      await tx(async (handle) => {
        const contact = await handle.one(
          `INSERT INTO contacts (company_id, name, role, phone, preferred_language, notes)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [companyId, name, role, phone, language, notes]
        );
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: companyId,
          action: "contact_added", detail: `${name}${role ? ` (${role})` : ""}`,
        });
        return contact;
      });
      reply.redirect(`${back}?ok=contact_saved`, 303);
    } catch (err) {
      request.log.error({ err }, "contact add failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed — nothing was written."), 303);
    }
  });

  app.post("/company/:id/contact/:contactId/delete", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const contactId = requireId(request.params.contactId, "contact");
    const back = `/company/${companyId}`;
    try {
      await tx(async (handle) => {
        const removed = await handle.one(
          `DELETE FROM contacts WHERE id = $1 AND company_id = $2 RETURNING name`,
          [contactId, companyId]
        );
        if (!removed) throw new ValidationError("That contact no longer exists.");
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: companyId,
          action: "contact_removed", detail: removed.name,
        });
      });
      reply.redirect(`${back}?ok=contact_deleted`, 303);
    } catch (err) {
      request.log.error({ err }, "contact delete failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Delete failed."), 303);
    }
  });

  /* Trial -> client. Converting a trial does not itself create the client
     record; the rate is a decision, so it is entered explicitly. */
  app.post("/company/:id/client", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const back = `/company/${companyId}`;
    try {
      const monthly = requireMoneyCents(request.body?.monthly_rate, "Monthly rate");
      const setup = requireMoneyCents(request.body?.setup_fee ?? "0", "Setup fee", { min: 0 });
      const plan = optionalString(request.body?.plan, "Plan", { max: 80 }) || "missed_call_textback";

      await tx(async (handle) => {
        const company = await handle.one(`SELECT * FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
        if (!company) throw new ValidationError("That company no longer exists.");

        const existing = await handle.one(
          `SELECT id FROM clients WHERE company_id = $1 AND status = 'active'`, [companyId]
        );
        if (existing) throw new ValidationError("This company is already an active client.");

        const client = await handle.one(
          `INSERT INTO clients (company_id, plan, monthly_rate, setup_fee, started_at, status)
           VALUES ($1, $2, $3, $4, now(), 'active') RETURNING id`,
          [companyId, plan, monthly, setup]
        );
        await handle.query(`UPDATE companies SET status = 'client' WHERE id = $1`, [companyId]);
        await handle.query(
          `UPDATE trials SET status = 'converted' WHERE company_id = $1 AND status = 'active'`,
          [companyId]
        );
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: companyId,
          action: "client_started",
          detail: `${company.name} — $${(monthly / 100).toFixed(2)}/mo`,
        });
        await logActivity(handle, {
          actor: request.operator, entityType: "client", entityId: client.id,
          action: "client_started", detail: company.name,
        });
      });
      reply.redirect(`${back}?ok=client_saved`, 303);
    } catch (err) {
      request.log.error({ err }, "client create failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed — nothing was written."), 303);
    }
  });

  app.post("/trial/:id/status", async (request, reply) => {
    const trialId = requireId(request.params.id, "trial");
    const back = await companyPathForTrial(trialId);
    try {
      const status = requireEnum(request.body?.status, "Status",
                                 ["active", "converted", "expired", "cancelled"]);
      const companyId = await tx(async (handle) => {
        const trial = await handle.one(`SELECT * FROM trials WHERE id = $1 FOR UPDATE`, [trialId]);
        if (!trial) throw new ValidationError("That trial no longer exists.");
        await handle.query(`UPDATE trials SET status = $1 WHERE id = $2`, [status, trialId]);

        /* A trial that ends without converting sends the company back into the
           worked list rather than leaving it parked on 'trial' forever. */
        if (status === "expired" || status === "cancelled") {
          await handle.query(
            `UPDATE companies SET status = 'contacted' WHERE id = $1 AND status = 'trial'`,
            [trial.company_id]
          );
        }
        await logActivity(handle, {
          actor: request.operator, entityType: "trial", entityId: trialId,
          action: `trial_${status}`, detail: "",
        });
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: trial.company_id,
          action: `trial_${status}`, detail: "",
        });
        return trial.company_id;
      });
      reply.redirect(`/company/${companyId}?ok=trial_saved`, 303);
    } catch (err) {
      request.log.error({ err }, "trial status failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed."), 303);
    }
  });

  app.post("/client/:id/payment", async (request, reply) => {
    const clientId = requireId(request.params.id, "client");
    const back = await companyPathForClient(clientId);
    try {
      const amount = requireMoneyCents(request.body?.amount, "Amount", { min: 1 });
      const kind = requireEnum(request.body?.kind, "Kind", ["setup", "monthly"]);
      const notes = optionalString(request.body?.notes, "Notes", { max: 300 });

      const companyId = await tx(async (handle) => {
        const client = await handle.one(`SELECT * FROM clients WHERE id = $1 FOR UPDATE`, [clientId]);
        if (!client) throw new ValidationError("That client no longer exists.");

        await handle.query(
          `INSERT INTO payments (client_id, amount, kind, paid_at, notes)
           VALUES ($1, $2, $3, now(), $4)`,
          [clientId, amount, kind, notes]
        );
        if (kind === "setup") {
          await handle.query(`UPDATE clients SET setup_paid = true WHERE id = $1`, [clientId]);
        }
        await logActivity(handle, {
          actor: request.operator, entityType: "client", entityId: clientId,
          action: "payment_recorded", detail: `$${(amount / 100).toFixed(2)} ${kind}`,
        });
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: client.company_id,
          action: "payment_recorded", detail: `$${(amount / 100).toFixed(2)} ${kind}`,
        });
        return client.company_id;
      });
      reply.redirect(`/company/${companyId}?ok=payment_saved`, 303);
    } catch (err) {
      request.log.error({ err }, "payment failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed — nothing was written."), 303);
    }
  });

  app.post("/client/:id/churn", async (request, reply) => {
    const clientId = requireId(request.params.id, "client");
    const back = await companyPathForClient(clientId);
    try {
      const reason = requireString(request.body?.churn_reason, "Reason", { max: 300 });
      const companyId = await tx(async (handle) => {
        const client = await handle.one(`SELECT * FROM clients WHERE id = $1 FOR UPDATE`, [clientId]);
        if (!client) throw new ValidationError("That client no longer exists.");
        await handle.query(
          `UPDATE clients SET status = 'churned', churned_at = now(), churn_reason = $1 WHERE id = $2`,
          [reason, clientId]
        );
        await logActivity(handle, {
          actor: request.operator, entityType: "client", entityId: clientId,
          action: "client_churned", detail: reason,
        });
        await logActivity(handle, {
          actor: request.operator, entityType: "company", entityId: client.company_id,
          action: "client_churned", detail: reason,
        });
        return client.company_id;
      });
      reply.redirect(`/company/${companyId}?ok=client_saved`, 303);
    } catch (err) {
      request.log.error({ err }, "churn failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed."), 303);
    }
  });
}
