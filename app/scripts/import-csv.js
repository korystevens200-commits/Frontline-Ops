/* Import a prospect CSV.

   Idempotent on phone: re-running the same file updates the sourced columns
   and never creates a second row for a business you have already called.

   Expected header (order does not matter, extra columns are ignored):
     company_name,niche,phone,address,city,zip,google_rating,review_count,tier,notes

   Usage:
     npm run import -- prospects.csv
     npm run import -- prospects.csv --dry-run
     npm run import -- prospects.csv --source="hialeah batch 1" --actor=Kory
*/
import { readFile } from "node:fs/promises";
import { tx, closePool, migrate } from "../src/env-bootstrap.js";
import { parseCsvRecords } from "../src/csv.js";
import { logActivity } from "../src/activity.js";
import { normalizePhone, optionalRating } from "../src/validate.js";

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
const { headers, records } = parseCsvRecords(text);

const REQUIRED = ["company_name", "phone", "tier"];
const missing = REQUIRED.filter((h) => !headers.includes(h));
if (missing.length) {
  console.error(`Missing required column(s): ${missing.join(", ")}`);
  console.error(`Found: ${headers.join(", ")}`);
  process.exit(1);
}

const valid = [];
const rejected = [];

for (const record of records) {
  const name = (record.company_name || "").trim();
  const phone = normalizePhone(record.phone);
  const tier = (record.tier || "").trim().toUpperCase();

  if (!name)              { rejected.push({ line: record.__line, why: "no company_name", record }); continue; }
  if (!phone)             { rejected.push({ line: record.__line, why: `unusable phone "${record.phone}"`, record }); continue; }
  if (tier !== "A" && tier !== "B") {
    rejected.push({ line: record.__line, why: `tier must be A or B, got "${record.tier}"`, record });
    continue;
  }

  let rating = null;
  try { rating = optionalRating(record.google_rating); }
  catch { rejected.push({ line: record.__line, why: `bad google_rating "${record.google_rating}"`, record }); continue; }

  let reviews = null;
  const reviewText = (record.review_count || "").trim().replace(/,/g, "");
  if (reviewText) {
    const n = Number(reviewText);
    if (!Number.isInteger(n) || n < 0) {
      rejected.push({ line: record.__line, why: `bad review_count "${record.review_count}"`, record });
      continue;
    }
    reviews = n;
  }

  valid.push({
    name,
    phone,
    tier,
    niche:   (record.niche   || "").trim().slice(0, 120),
    address: (record.address || "").trim().slice(0, 300),
    city:    (record.city    || "").trim().slice(0, 120),
    zip:     (record.zip     || "").trim().slice(0, 20),
    notes:   (record.notes   || "").trim().slice(0, 4000),
    google_rating: rating,
    review_count: reviews,
  });
}

/* Two rows in the same file sharing a phone would make the upsert fail --
   "ON CONFLICT DO UPDATE command cannot affect row a second time" -- so the
   later one wins and the earlier is reported. */
const byPhone = new Map();
const dupes = [];
for (const row of valid) {
  /* Report the row being DISPLACED, not the one that wins -- the displaced
     name is what tells you which entry in your list is the stale one. */
  const previous = byPhone.get(row.phone);
  if (previous) dupes.push({ dropped: previous, kept: row });
  byPhone.set(row.phone, row);
}
const toImport = [...byPhone.values()];

console.log(`Parsed ${records.length} row(s): ${toImport.length} to import, ` +
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
    let created = 0;
    let updated = 0;

    for (const row of toImport) {
      /* Sourced columns are refreshed on re-import. Deliberately NOT touched:
           status, claimed_by/claimed_at, created_at  -- work state, not list data
           notes  -- only filled when empty, so an operator's own notes about a
                     call are never overwritten by a re-import of the list. */
      const out = await handle.one(
        `INSERT INTO companies
           (name, niche, address, city, zip, phone, google_rating, review_count, source, tier, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (phone) DO UPDATE SET
           name          = EXCLUDED.name,
           niche         = EXCLUDED.niche,
           address       = EXCLUDED.address,
           city          = EXCLUDED.city,
           zip           = EXCLUDED.zip,
           google_rating = EXCLUDED.google_rating,
           review_count  = EXCLUDED.review_count,
           tier          = EXCLUDED.tier,
           notes         = CASE WHEN companies.notes = '' THEN EXCLUDED.notes ELSE companies.notes END
         RETURNING id, (xmax = 0) AS inserted`,
        [row.name, row.niche, row.address, row.city, row.zip, row.phone,
         row.google_rating, row.review_count, source, row.tier, row.notes]
      );
      if (out.inserted) created += 1; else updated += 1;
    }

    await logActivity(handle, {
      actor, entityType: "import", entityId: null, action: "csv_import",
      detail: `${file}: ${created} created, ${updated} updated, ${rejected.length} rejected`,
    });

    return { created, updated };
  });

  console.log(`\nImported: ${result.created} created, ${result.updated} updated.`);
  await closePool();
  process.exit(0);
} catch (err) {
  console.error(`\nImport FAILED — nothing was written: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}
