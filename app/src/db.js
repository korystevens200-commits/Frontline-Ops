/* Postgres access and the migration runner.
   One pool for the process; every mutating route uses tx() so that the write
   and its activity_log row commit or fail together. */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/* node-postgres hands back bigint (int8) as a string to avoid silent precision
   loss. Our ids and counts are far below 2^53, and template rendering wants
   numbers, so parse them. */
pg.types.setTypeParser(20, (value) => Number(value));
/* numeric(2,1) -- google_rating. Same reasoning, bounded 0..5. */
pg.types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

/* Arbitrary fixed key for the migration advisory lock. Any constant works so
   long as every instance of this app uses the same one. */
const MIGRATION_LOCK_ID = 4120250901;

let pool = null;

export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy app/.env.example to app/.env.");
  }
  pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    /* Fly Postgres over the internal 6PN network presents a self-signed cert.
       Enable TLS only when the URL asks for it. */
    ssl: /[?&]sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : false,
  });
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });
  return pool;
}

export async function query(text, params = []) {
  const result = await getPool().query(text, params);
  return result.rows;
}

export async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}

/* Run fn inside a transaction. fn receives a client with the same
   query/one shape as the module-level helpers. */
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const handle = {
      query: async (text, params = []) => (await client.query(text, params)).rows,
      one: async (text, params = []) => (await client.query(text, params)).rows[0] ?? null,
    };
    const result = await fn(handle);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/* Apply any migration files not yet recorded, in filename order.
   An advisory lock keeps two booting instances from racing each other. */
export async function migrate({ log = console.log } = {}) {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    let count = 0;
    for (const filename of files) {
      if (applied.has(filename)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      log(`[migrate] applying ${filename}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        count += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${filename} failed: ${err.message}`);
      }
    }
    log(count === 0 ? "[migrate] up to date" : `[migrate] applied ${count} migration(s)`);
    return count;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } catch { /* connection already gone; the lock dies with it */ }
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
