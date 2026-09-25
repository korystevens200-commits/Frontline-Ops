/* Setting up and running a client's text-back line. Every route here is an
   operator action behind the session and a CSRF token; the ones that spend
   money or cannot be undone ask for an explicit confirmation in the form. */
import { one, query } from "../db.js";
import { getProvider } from "../providers/sms.js";
import { hit } from "../security/ratelimit.js";
import { errorRedirect } from "../flash.js";
import { requireId, ValidationError } from "../validate.js";
import { numberSearchPage } from "../views/line.js";
import {
  parseLineSettings, provisionLine, attachLine, updateLineSettings, saveLineTemplates,
  setLineStatus, pauseAllLines, releaseLine, sendTestMessage, providerFailureMessage,
} from "../delivery/lines.js";
import { composeTest } from "../delivery/compose.js";
import { kickDispatcher } from "../delivery/dispatcher.js";

/* Buying numbers costs money every month. Ten an hour is far beyond any real
   day's setup and still caps what a mistake -- or a stolen session -- can do. */
const PROVISIONS_PER_HOUR = 10;

async function companyForLine(lineId) {
  const row = await one(`SELECT company_id FROM lines WHERE id = $1`, [lineId]);
  return row ? `/company/${row.company_id}` : "/pipeline";
}

export default async function lineRoutes(app) {
  app.get("/company/:id/line/numbers", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const company = await one(`SELECT * FROM companies WHERE id = $1`, [companyId]);
    if (!company) {
      reply.redirect("/pipeline?err=not_found", 303);
      return;
    }
    const areaCode = String(request.query?.area_code ?? "").trim();
    if (!/^[2-9]\d{2}$/.test(areaCode)) {
      reply.redirect(errorRedirect(`/company/${companyId}`, "Enter a three-digit US area code.") + "#line", 303);
      return;
    }
    const contacts = await query(`SELECT * FROM contacts WHERE company_id = $1 ORDER BY created_at ASC`, [companyId]);

    let numbers = [];
    let error = null;
    try {
      numbers = await getProvider().searchNumbers({ areaCode, limit: 10 });
    } catch (err) {
      request.log.error({ err: { message: err.message, code: err.code } }, "number search failed");
      error = providerFailureMessage(err);
    }
    reply.type("text/html; charset=utf-8");
    return numberSearchPage({ operator: request.operator, company, contacts, areaCode, numbers, error }).value;
  });

  app.post("/company/:id/line/provision", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const back = `/company/${companyId}`;
    try {
      if (request.body?.confirm !== "yes") {
        throw new ValidationError("Tick the box to confirm buying the number.");
      }
      if ((await hit("provision", "*", { windowSeconds: 3600 })) > PROVISIONS_PER_HOUR) {
        throw new ValidationError("Too many numbers bought in the last hour. Try again later.");
      }
      const settings = parseLineSettings(request.body);
      await provisionLine({
        provider: getProvider(), companyId, number: String(request.body?.number ?? ""),
        settings, operator: request.operator, log: request.log,
      });
      reply.redirect(`${back}?ok=line_created#line`, 303);
    } catch (err) {
      request.log.error({ err: { message: err.message, code: err.code } }, "line provisioning failed");
      reply.redirect(errorRedirect(back, providerFailureMessage(err)) + "#line", 303);
    }
  });

  app.post("/company/:id/line/attach", async (request, reply) => {
    const companyId = requireId(request.params.id, "company");
    const back = `/company/${companyId}`;
    try {
      const settings = parseLineSettings(request.body);
      await attachLine({
        provider: getProvider(), companyId, number: String(request.body?.number ?? ""),
        settings, operator: request.operator,
      });
      reply.redirect(`${back}?ok=line_created#line`, 303);
    } catch (err) {
      request.log.error({ err: { message: err.message, code: err.code } }, "line attach failed");
      reply.redirect(errorRedirect(back, providerFailureMessage(err)) + "#line", 303);
    }
  });

  app.post("/line/:id/settings", async (request, reply) => {
    const lineId = requireId(request.params.id, "line");
    const back = await companyForLine(lineId);
    try {
      await updateLineSettings({ lineId, settings: parseLineSettings(request.body), operator: request.operator });
      reply.redirect(`${back}?ok=line_saved#line`, 303);
    } catch (err) {
      request.log.error({ err }, "line settings failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError ? err.message
        : "Save failed — nothing was written.") + "#line", 303);
    }
  });

  app.post("/line/:id/wording", async (request, reply) => {
    const lineId = requireId(request.params.id, "line");
    const back = await companyForLine(lineId);
    try {
      await saveLineTemplates({ lineId, body: request.body ?? {}, operator: request.operator });
      reply.redirect(`${back}?ok=wording_saved#line`, 303);
    } catch (err) {
      request.log.error({ err }, "line wording failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError ? err.message
        : "Save failed — nothing was written.") + "#line", 303);
    }
  });

  for (const [path, status, ok] of [["pause", "paused", "line_paused"], ["resume", "active", "line_resumed"]]) {
    app.post(`/line/:id/${path}`, async (request, reply) => {
      const lineId = requireId(request.params.id, "line");
      const back = await companyForLine(lineId);
      try {
        await setLineStatus({ lineId, status, operator: request.operator });
        reply.redirect(`${back}?ok=${ok}#line`, 303);
      } catch (err) {
        request.log.error({ err }, `line ${path} failed`);
        reply.redirect(errorRedirect(back, err instanceof ValidationError ? err.message
          : "Save failed — nothing was written.") + "#line", 303);
      }
    });
  }

  app.post("/line/:id/test", async (request, reply) => {
    const lineId = requireId(request.params.id, "line");
    const back = await companyForLine(lineId);
    try {
      await sendTestMessage({ lineId, operator: request.operator, compose: composeTest });
      kickDispatcher();
      reply.redirect(`${back}?ok=test_sent#line`, 303);
    } catch (err) {
      request.log.error({ err }, "line test failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError ? err.message
        : "Could not queue the test.") + "#line", 303);
    }
  });

  app.post("/line/:id/release", async (request, reply) => {
    const lineId = requireId(request.params.id, "line");
    const back = await companyForLine(lineId);
    try {
      await releaseLine({
        provider: getProvider(), lineId, typedNumber: String(request.body?.confirm_number ?? ""),
        operator: request.operator,
      });
      reply.redirect(`${back}?ok=line_released#line`, 303);
    } catch (err) {
      request.log.error({ err: { message: err.message, code: err.code } }, "line release failed");
      reply.redirect(errorRedirect(back, providerFailureMessage(err)) + "#line", 303);
    }
  });

  /* The kill switch, reachable from Numbers. */
  app.post("/lines/pause-all", async (request, reply) => {
    try {
      if (request.body?.confirm !== "yes") throw new ValidationError("Tick the box to confirm pausing every line.");
      const count = await pauseAllLines({ operator: request.operator });
      request.log.warn({ count, operator: request.operator }, "all lines paused");
      reply.redirect(`/numbers?ok=lines_paused_all`, 303);
    } catch (err) {
      request.log.error({ err }, "pause all failed");
      reply.redirect(errorRedirect("/numbers", err instanceof ValidationError ? err.message
        : "Pause failed — check each line."), 303);
    }
  });
}
