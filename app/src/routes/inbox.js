/* Inbox: every conversation on every line, newest activity first. */
import { query, one, tx } from "../db.js";
import { logActivity } from "../activity.js";
import { inboxPage, conversationPage, INBOX_VIEWS } from "../views/inbox.js";
import { flashFrom, errorRedirect } from "../flash.js";
import { requireId, requireEnum, ValidationError } from "../validate.js";

const PAGE_SIZE = 40;
const VIEW_VALUES = INBOX_VIEWS.map((v) => v.value);

/* Filter SQL by view, from a whitelist -- never interpolated from input. */
const VIEW_SQL = {
  "":          "true",
  needs_reply: "c.status = 'replied' AND c.opted_out_at IS NULL",
  waiting:     "c.status = 'open' AND c.opted_out_at IS NULL",
  closed:      "c.status = 'closed'",
  opted_out:   "c.opted_out_at IS NOT NULL",
};

export default async function inboxRoutes(app) {
  app.get("/inbox", async (request, reply) => {
    const requested = String(request.query?.view ?? "");
    const view = VIEW_VALUES.includes(requested) ? requested : "";
    const pageNumber = Number(request.query?.page);
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;

    let company = null;
    const params = [];
    const bind = (value) => `$${params.push(value)}`;
    const where = [VIEW_SQL[view]];
    if (request.query?.company) {
      const companyId = Number(request.query.company);
      if (Number.isInteger(companyId) && companyId > 0) {
        company = await one(`SELECT id, name FROM companies WHERE id = $1`, [companyId]);
        if (company) where.push(`c.company_id = ${bind(company.id)}`);
      }
    }
    const clause = where.join(" AND ");

    const total = (await query(`SELECT count(*)::int AS n FROM conversations c WHERE ${clause}`, params))[0].n;
    const rows = await query(
      `SELECT c.*, co.name AS company_name, l.number AS line_number, l.is_demo,
              m.body AS last_body, m.direction AS last_direction, m.error_code AS last_error
         FROM conversations c
         JOIN companies co ON co.id = c.company_id
         JOIN lines l ON l.id = c.line_id
         LEFT JOIN LATERAL (
           SELECT body, direction, error_code FROM messages
            WHERE conversation_id = c.id AND kind <> 'owner_alert'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         ) m ON true
        WHERE ${clause}
        ORDER BY c.last_activity_at DESC, c.id DESC
        LIMIT ${bind(PAGE_SIZE)} OFFSET ${bind((page - 1) * PAGE_SIZE)}`,
      params
    );
    const counts = await one(
      `SELECT count(*) FILTER (WHERE status = 'replied' AND opted_out_at IS NULL)::int AS needs_reply
         FROM conversations ${company ? "WHERE company_id = $1" : ""}`,
      company ? [company.id] : []
    );

    reply.type("text/html; charset=utf-8");
    return inboxPage({
      operator: request.operator, rows, view, company, page, counts,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), flash: flashFrom(request),
    }).value;
  });

  app.get("/conversation/:id", async (request, reply) => {
    const conversationId = requireId(request.params.id, "conversation");
    const conversation = await one(
      `SELECT c.*, co.name AS company_name, l.number AS line_number, l.is_demo
         FROM conversations c
         JOIN companies co ON co.id = c.company_id
         JOIN lines l ON l.id = c.line_id
        WHERE c.id = $1`,
      [conversationId]
    );
    if (!conversation) {
      reply.redirect("/inbox?err=not_found", 303);
      return;
    }

    const [messages, calls] = await Promise.all([
      query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`, [conversationId]),
      query(`SELECT * FROM missed_calls WHERE conversation_id = $1 ORDER BY received_at ASC, id ASC`, [conversationId]),
    ]);
    /* One timeline. A call sorts before the text-back it caused, which was
       queued in the same instant. */
    const events = [
      ...calls.map((call) => ({ type: "call", at: call.received_at, order: 0, decision: call.decision })),
      ...messages.map((message) => ({ type: "message", at: message.created_at, order: 1, message })),
    ].sort((a, b) => (a.at - b.at) || (a.order - b.order));

    reply.type("text/html; charset=utf-8");
    return conversationPage({
      operator: request.operator, conversation, events, flash: flashFrom(request),
    }).value;
  });

  app.post("/conversation/:id/status", async (request, reply) => {
    const conversationId = requireId(request.params.id, "conversation");
    const back = `/conversation/${conversationId}`;
    try {
      const status = requireEnum(request.body?.status, "Status", ["closed", "open"]);
      await tx(async (handle) => {
        const conversation = await handle.one(
          `SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]
        );
        if (!conversation) throw new ValidationError("That conversation no longer exists.");
        if (status === "closed") {
          if (conversation.status === "closed") return;
          await handle.query(
            `UPDATE conversations SET status = 'closed', closed_at = now(), closed_by = $2, followup_due_at = NULL
              WHERE id = $1`,
            [conversationId, request.operator]
          );
        } else {
          if (conversation.status !== "closed") return;
          await handle.query(
            `UPDATE conversations
                SET status = CASE WHEN first_reply_at IS NOT NULL THEN 'replied' ELSE 'open' END,
                    closed_at = NULL, closed_by = NULL
              WHERE id = $1`,
            [conversationId]
          );
        }
        await logActivity(handle, {
          actor: request.operator, entityType: "conversation", entityId: conversationId,
          action: status === "closed" ? "conversation_closed" : "conversation_reopened",
          detail: conversation.lead_phone,
        });
      });
      reply.redirect(`${back}?ok=${status === "closed" ? "conversation_closed" : "conversation_reopened"}`, 303);
    } catch (err) {
      request.log.error({ err }, "conversation status failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Save failed — nothing was written."), 303);
    }
  });
}
