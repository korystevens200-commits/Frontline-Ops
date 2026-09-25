/* Import a prospect CSV.

   Idempotent on phone: re-running the same file updates the sourced columns
   and never creates a second row for a business you have already called.

   Expected header (order does not matter, extra columns are ignored):
     company_name,niche,phone,address,city,zip,google_rating,review_count,tier,notes

   The validation and the upsert live in src/importer.js, shared with the
   phone upload on the Import screen, so both treat a file identically.

   Usage:
     npm run import -- prospects.csv
     npm run import -- prospects.csv --dry-run
     npm run import -- prospects.csv --source="hialeah batch 1" --actor=Kory
*/
import { readFile } from "node:fs/promises";
import { tx, closePool, migrate } from "../src/env-bootstrap.js";
import { logActivity } from "../src/activity.js";
import { checkProspects, importProspects } from "../src/importer.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const source = (args.find((a) => a.startsWith("--source=")) || "").split("=")[1] || "csv_import";
const actor = (args.find((a) => a.startsWith("--actor=")) || "").split("=")[1] || "import";

if (!file) {
  console.error(`Usage: npm run import -- <file.csv> [--dry-run] [--source=label] [--actor=name]`);
  process.exit(1);
}

const text = await readFile(file, "utf8");
const { headers, missing, total, toImport, rejected, dupes } = checkProspects(text);

if (missing.length) {
  console.error(`Missing required column(s): ${missing.join(", ")}`);
  console.error(`Found: ${headers.join(", ")}`);
  process.exit(1);
}

console.log(`Parsed ${total} row(s): ${toImport.length} to import, ` +
            `${rejected.length} rejected, ${dupes.length} duplicate phone(s) within the file.`);

if (rejected.length) {
  console.log("\nRejected rows (not imported):");
  for (const r of rejected) console.log(`  line ${r.line}: ${r.why}`);
}
if (dupes.length) {
  console.log("\nDuplicate phones inside the file (last occurrence wins):");
  for (const d of dupes) console.log(`  ${d.kept.phone}  dropped "${d.dropped.name}", kept "${d.kept.name}"`);
}

if (dryRun) {
  console.log("\n--dry-run: nothing was written.");
  await closePool();
  process.exit(0);
}

try {
  await migrate({ log: () => {} });

  const result = await tx(async (handle) => {
    const counts = await importProspects(handle, toImport, { source });
    await logActivity(handle, {
      actor, entityType: "import", entityId: null, action: "csv_import",
      detail: `${file}: ${counts.created} created, ${counts.updated} updated, ${rejected.length} rejected`,
    });
    return counts;
  });

  console.log(`\nImported: ${result.created} created, ${result.updated} updated.`);
  await closePool();
  process.exit(0);
} catch (err) {
  console.error(`\nImport FAILED — nothing was written: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}
