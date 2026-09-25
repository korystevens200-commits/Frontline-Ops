/* Prospect import, shared by the command line (scripts/import-csv.js) and
   the phone upload (routes/import.js), so both accept exactly the same files
   and treat them exactly the same way.

   Idempotent on phone: re-importing a file updates the sourced columns and
   never creates a second row for a business already in the list.

   Expected header (order does not matter, extra columns are ignored):
     company_name,niche,phone,address,city,zip,google_rating,review_count,tier,notes */
import { parseCsvRecords } from "./csv.js";
import { normalizePhone, optionalRating } from "./validate.js";

export const REQUIRED_COLUMNS = ["company_name", "phone", "tier"];

/* Parse and validate. Writes nothing. */
export function checkProspects(text) {
  const { headers, records } = parseCsvRecords(text);
  const missing = REQUIRED_COLUMNS.filter((h) => !headers.includes(h));
  if (missing.length) {
    return { headers, missing, total: records.length, toImport: [], rejected: [], dupes: [] };
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

  return { headers, missing: [], total: records.length, toImport: [...byPhone.values()], rejected, dupes };
}

/* Write checked rows inside the caller's transaction. */
export async function importProspects(handle, rows, { source }) {
  let created = 0;
  let updated = 0;

  for (const row of rows) {
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

  return { created, updated };
}
