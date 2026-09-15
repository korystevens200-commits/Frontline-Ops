/* Smoke tests for the invariants that would hurt most if they broke.
   Uses node:test -- no test framework dependency.

   Requires a THROWAWAY database, named explicitly so this can never be
   pointed at the real one by accident:

     createdb frontline_test
     TEST_DATABASE_URL=postgres://frontline:frontline@localhost:5432/frontline_test \
       node --test tests/
*/
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is not set. Refusing to run against DATABASE_URL.");
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { query, one, tx, migrate, closePool } = await import("../src/db.js");
const { claimNext, claimsByOthers, CLAIM_MINUTES } = await import("../src/queue.js");
const { logCall } = await import("../src/calls.js");
const { parseLocalDateTime, toLocalInputValue, nyDayBounds } = await import("../src/time.js");
const { html, escapeHtml } = await import("../src/html.js");
const { hashPassword, verifyPassword } = await import("../src/auth.js");
const { requireMoneyCents, normalizePhone, ValidationError } = await import("../src/validate.js");
const { parseCsvRecords } = await import("../src/csv.js");

await migrate({ log: () => {} });

async function reset() {
  await query("TRUNCATE payments, clients, trials, calls, contacts, companies, activity_log RESTART IDENTITY CASCADE");
}

async function seed(rows) {
  for (const [name, phone, tier] of rows) {
    await query(`INSERT INTO companies (name, phone, tier) VALUES ($1,$2,$3)`, [name, phone, tier]);
  }
}

test("simultaneous claims never hand the same company to two people", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"], ["B", "+13050000002", "A"],
              ["C", "+13050000003", "A"], ["D", "+13050000004", "B"]]);
  const { start } = nyDayBounds();
  const h = { query, one };

  const claimed = await Promise.all(
    ["Kory", "Partner", "Third", "Fourth"].map((op) => claimNext(h, op, start))
  );
  const ids = claimed.filter(Boolean).map((c) => c.id);
  assert.equal(ids.length, 4, "everyone should get a company");
  assert.equal(new Set(ids).size, 4, "no two operators may hold the same company");
});

test("re-reading the queue returns the same company and never a second hold", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"], ["B", "+13050000002", "A"]]);
  const { start } = nyDayBounds();
  const h = { query, one };

  const first = await claimNext(h, "Kory", start);
  const again = await claimNext(h, "Kory", start);
  assert.equal(again.id, first.id, "a refresh mid-call must be stable");

  const held = await query(`SELECT count(*)::int AS n FROM companies WHERE claimed_by = 'Kory'`);
  assert.equal(held[0].n, 1, "one operator holds exactly one company");
});

test("a claim is visible to the other operator", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"], ["B", "+13050000002", "A"]]);
  const { start } = nyDayBounds();
  const h = { query, one };

  const mine = await claimNext(h, "Kory", start);
  const seen = await claimsByOthers(h, "Partner");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].claimed_by, "Kory");
  assert.equal(seen[0].name, mine.name);
});

test("an expired claim is released without any sweeper running", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"]]);
  const { start } = nyDayBounds();
  const h = { query, one };

  await claimNext(h, "Kory", start);
  await query(
    `UPDATE companies SET claimed_at = now() - make_interval(mins => $1)`,
    [CLAIM_MINUTES + 1]
  );
  const taken = await claimNext(h, "Partner", start);
  assert.ok(taken, "a stale hold must not keep a company out of the queue");
});

test("a company already called today is not offered again today", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"], ["B", "+13050000002", "B"]]);
  const { start } = nyDayBounds();
  const h = { query, one };

  const first = await claimNext(h, "Kory", start);
  await logCall({ companyId: first.id, operator: "Kory", outcome: "no_answer" });

  const next = await claimNext(h, "Kory", start);
  assert.notEqual(next?.id, first.id, "the company just dialled must not come straight back");
});

test("spoke_to_owner without missed calls per week is refused", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"]]);
  const company = await one(`SELECT id FROM companies LIMIT 1`);

  await assert.rejects(
    () => logCall({ companyId: company.id, operator: "Kory", outcome: "spoke_to_owner" }),
    (err) => err instanceof ValidationError
  );
  const calls = await query(`SELECT count(*)::int AS n FROM calls`);
  assert.equal(calls[0].n, 0, "a refused call must write nothing");
});

test("the database refuses it too, not only the application", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"]]);
  const company = await one(`SELECT id FROM companies LIMIT 1`);
  await assert.rejects(() =>
    query(`INSERT INTO calls (company_id, called_by, outcome) VALUES ($1,'Kory','spoke_to_owner')`,
          [company.id]));
});

test("trial_agreed opens exactly one 14-day trial, even if repeated", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"]]);
  const company = await one(`SELECT id FROM companies LIMIT 1`);

  await logCall({ companyId: company.id, operator: "Kory", outcome: "trial_agreed" });
  await logCall({ companyId: company.id, operator: "Kory", outcome: "trial_agreed" });

  const trials = await query(`SELECT * FROM trials WHERE company_id = $1`, [company.id]);
  assert.equal(trials.length, 1, "a second yes must not open a second trial");

  const days = Math.round((trials[0].ends_at - trials[0].started_at) / 86400000);
  assert.equal(days, 14);

  const updated = await one(`SELECT status FROM companies WHERE id = $1`, [company.id]);
  assert.equal(updated.status, "trial");
});

test("every write lands in activity_log", async () => {
  await reset();
  await seed([["A", "+13050000001", "A"]]);
  const company = await one(`SELECT id FROM companies LIMIT 1`);
  await logCall({ companyId: company.id, operator: "Kory", outcome: "no_answer" });

  const log = await query(`SELECT * FROM activity_log ORDER BY id`);
  assert.equal(log.length, 1);
  assert.equal(log[0].actor, "Kory");
  assert.equal(log[0].action, "call_no_answer");
});

test("a failed write rolls back its activity_log row with it", async () => {
  await reset();
  await assert.rejects(() => tx(async (handle) => {
    await handle.query(
      `INSERT INTO companies (name, phone, tier) VALUES ('Rollback','+13050000009','A')`);
    await handle.query(
      `INSERT INTO activity_log (actor, entity_type, action) VALUES ('Kory','company','created')`);
    throw new Error("boom");
  }));

  const companies = await query(`SELECT count(*)::int AS n FROM companies`);
  const log = await query(`SELECT count(*)::int AS n FROM activity_log`);
  assert.equal(companies[0].n, 0);
  assert.equal(log[0].n, 0, "the log must not survive a rolled-back write");
});

test("money is stored as integer cents and never as a float", () => {
  assert.equal(requireMoneyCents("297", "rate"), 29700);
  assert.equal(requireMoneyCents("$297.50", "rate"), 29750);
  assert.equal(requireMoneyCents("1,234.05", "rate"), 123405);
  assert.throws(() => requireMoneyCents("297.999", "rate"), ValidationError);
  assert.throws(() => requireMoneyCents("abc", "rate"), ValidationError);
});

test("New York wall-clock input survives both sides of a DST boundary", () => {
  assert.equal(parseLocalDateTime("2026-09-15T14:30").toISOString(), "2026-09-15T18:30:00.000Z");
  assert.equal(parseLocalDateTime("2026-01-15T14:30").toISOString(), "2026-01-15T19:30:00.000Z");
  assert.equal(toLocalInputValue(new Date("2026-09-15T18:30:00Z")), "2026-09-15T14:30");
  assert.equal(parseLocalDateTime("garbage"), null);
});

test("a late-evening call belongs to the New York day it was made", () => {
  /* 02:00 UTC on the 15th is 22:00 on the 14th in New York. */
  const { start, end } = nyDayBounds(new Date("2026-09-15T02:00:00Z"));
  assert.equal(start.toISOString(), "2026-09-14T04:00:00.000Z");
  assert.equal(end.toISOString(), "2026-09-15T04:00:00.000Z");
});

test("templating escapes interpolated values by default", () => {
  const nasty = '<script>alert(1)</script>';
  const out = html`<div>${nasty}</div>`.value;
  assert.ok(!out.includes("<script>"), "a script tag must never reach the page");
  assert.ok(out.includes("&lt;script&gt;"));
  assert.equal(escapeHtml(`" & '`), "&quot; &amp; &#39;");
});

test("nested templates are not double-escaped", () => {
  const inner = html`<b>bold</b>`;
  const out = html`<p>${inner}</p>`.value;
  assert.equal(out, "<p><b>bold</b></p>");
});

test("passwords verify and wrong ones do not", async () => {
  const stored = await hashPassword("a long enough password");
  assert.ok(await verifyPassword("a long enough password", stored));
  assert.equal(await verifyPassword("wrong", stored), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
});

test("phone normalisation accepts the formats a list actually contains", () => {
  assert.equal(normalizePhone("+13055551234"), "+13055551234");
  assert.equal(normalizePhone("(305) 555-1234"), "+13055551234");
  assert.equal(normalizePhone("3055551234"), "+13055551234");
  assert.equal(normalizePhone("13055551234"), "+13055551234");
  assert.equal(normalizePhone("555"), null);
});

test("CSV parsing handles quotes, commas and empty cells", () => {
  const { records } = parseCsvRecords(
    'company_name,niche,notes\n"Smith, Jones & Co",AC,"He said ""later"""\nPlain,,\n'
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].company_name, "Smith, Jones & Co");
  assert.equal(records[0].notes, 'He said "later"');
  assert.equal(records[1].niche, "");
});

test("importing the same phone twice updates rather than duplicating", async () => {
  await reset();
  const upsert = (name, tier) => query(
    `INSERT INTO companies (name, phone, tier) VALUES ($1,'+13050000001',$2)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier`,
    [name, tier]
  );
  await upsert("First Name", "A");
  await upsert("Corrected Name", "B");

  const rows = await query(`SELECT name, tier FROM companies`);
  assert.equal(rows.length, 1, "phone is the identity; there must be one row");
  assert.equal(rows[0].name, "Corrected Name");
});

test.after(async () => { await closePool(); });
