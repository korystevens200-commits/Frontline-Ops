/* Importing prospects from a phone -- the gap that meant the call queue could
   only be filled from a laptop with a database connection.

   Two steps, like `npm run import -- --dry-run` then the real run:
     POST /import              read the file (or pasted text), check it,
                               keep it as a pending batch, show the report
     POST /import/:id/commit   re-check the stored text and write it

   The same checkProspects/importProspects as the command line, so a file is
   treated identically whichever way it arrives. No upload library: Node's
   own fetch implementation parses multipart/form-data (see server.js). */
import { one, tx } from "../db.js";
import { logActivity } from "../activity.js";
import { checkProspects, importProspects } from "../importer.js";
import { importPage, importReviewPage } from "../views/import.js";
import { flashFrom, errorRedirect } from "../flash.js";
import { requireId, optionalString, ValidationError } from "../validate.js";

export const IMPORT_BODY_LIMIT = 2 * 1024 * 1024;

export default async function importRoutes(app) {
  app.get("/import", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return importPage({
      operator: request.operator, flash: flashFrom(request),
      error: request.query?.msg ? String(request.query.msg).slice(0, 300) : null,
    }).value;
  });

  app.post("/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    try {
      const body = request.body ?? {};
      const upload = body.file && typeof body.file === "object" ? body.file : null;
      const pasted = typeof body.csv_text === "string" ? body.csv_text : "";
      const text = upload?.text?.trim() ? upload.text : pasted;
      if (!text.trim()) throw new ValidationError("Choose a CSV file or paste the list.");
      const source = optionalString(body.source, "Source label", { max: 80 }) || "csv_import";
      const filename = (upload?.filename || (pasted ? "pasted list" : "")).slice(0, 200);

      const check = checkProspects(text);
      if (check.missing.length) {
        throw new ValidationError(
          `Missing required column(s): ${check.missing.join(", ")}. Found: ${check.headers.join(", ") || "nothing"}.`
        );
      }

      const batch = await one(
        `INSERT INTO import_batches (created_by, filename, source, csv_text, total_rows, valid_rows, rejected_rows)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [request.operator, filename, source, text, check.total, check.toImport.length, check.rejected.length]
      );
      reply.redirect(`/import/${batch.id}`, 303);
    } catch (err) {
      request.log.error({ err: { message: err.message } }, "import check failed");
      reply.redirect(errorRedirect("/import", err instanceof ValidationError
        ? err.message : "Could not read that file. Save it as CSV and try again."), 303);
    }
  });

  app.get("/import/:id", async (request, reply) => {
    const batchId = requireId(request.params.id, "import");
    const batch = await one(`SELECT * FROM import_batches WHERE id = $1`, [batchId]);
    if (!batch) {
      reply.redirect(errorRedirect("/import", "That import has expired. Upload the file again."), 303);
      return;
    }
    /* Re-checked from the stored text, so the report is always what a
       commit would actually do. */
    const check = checkProspects(batch.csv_text);
    reply.type("text/html; charset=utf-8");
    return importReviewPage({
      operator: request.operator, batch, check, flash: flashFrom(request),
      error: request.query?.msg ? String(request.query.msg).slice(0, 300) : null,
    }).value;
  });

  app.post("/import/:id/commit", async (request, reply) => {
    const batchId = requireId(request.params.id, "import");
    const back = `/import/${batchId}`;
    try {
      await tx(async (handle) => {
        const batch = await handle.one(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`, [batchId]);
        if (!batch) throw new ValidationError("That import has expired. Upload the file again.");
        if (batch.status !== "pending") throw new ValidationError("This import has already been finished.");

        const check = checkProspects(batch.csv_text);
        if (check.missing.length) throw new ValidationError("This file is missing required columns.");
        const counts = await importProspects(handle, check.toImport, { source: batch.source });
        await handle.query(
          `UPDATE import_batches
              SET status = 'imported', created_count = $2, updated_count = $3, finished_at = now()
            WHERE id = $1`,
          [batchId, counts.created, counts.updated]
        );
        await logActivity(handle, {
          actor: request.operator, entityType: "import", entityId: batchId, action: "csv_import",
          detail: `${batch.filename || "upload"}: ${counts.created} created, ${counts.updated} updated, ` +
                  `${check.rejected.length} rejected`,
        });
      });
      reply.redirect(`${back}?ok=imported`, 303);
    } catch (err) {
      request.log.error({ err }, "import commit failed");
      reply.redirect(errorRedirect(back, err instanceof ValidationError
        ? err.message : "Import failed — nothing was written. Try again."), 303);
    }
  });

  app.post("/import/:id/discard", async (request, reply) => {
    const batchId = requireId(request.params.id, "import");
    await one(
      `UPDATE import_batches SET status = 'discarded', finished_at = now(), csv_text = ''
        WHERE id = $1 AND status = 'pending' RETURNING id`,
      [batchId]
    );
    reply.redirect("/import?ok=import_discarded", 303);
  });
}
