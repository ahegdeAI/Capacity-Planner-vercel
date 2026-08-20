// Postgres persistence layer — plain `pg` (node-postgres) driver against a
// connection pool. This replaced the old better-sqlite3 file-based DB so the
// app can run on Vercel's serverless functions, which have no persistent
// writable disk and no long-running process. `pg` works identically against
// local Postgres (for testing), Neon's standard postgres:// connection
// strings, and any other Postgres host — unlike @neondatabase/serverless's
// HTTP-based neon() helper, which only works through Neon's own proxy.
//
// Every call site in this app is now async — db.query(...) returns a
// Promise, so every route handler that touches the DB must be async and
// await it.
const { Pool } = require("pg");

// Vercel's Postgres/Neon integration injects the connection string as
// DATABASE_URL; some Vercel integrations instead (or additionally) name it
// POSTGRES_URL. Prefer DATABASE_URL if both are set.
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!CONNECTION_STRING) {
  console.warn("⚠ Neither DATABASE_URL nor POSTGRES_URL is set — the app will fail to connect to Postgres. See .env.example.");
}

// SSL: remote hosts (Neon, most managed Postgres) require SSL, but local
// dev/test Postgres instances typically don't have it configured at all —
// asking for SSL against a plain local instance fails the connection. We
// detect "sslmode=require" in the connection string (Neon connection
// strings include this), and also honor an explicit PGSSL=true/false
// override in case a host needs SSL without that query param.
function resolveSsl() {
  if (process.env.PGSSL === "true") return { rejectUnauthorized: false };
  if (process.env.PGSSL === "false") return false;
  if (CONNECTION_STRING && CONNECTION_STRING.includes("sslmode=require")) return { rejectUnauthorized: false };
  return false;
}

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: resolveSsl(),
});

pool.on("error", (err) => {
  // Errors on idle clients in the pool (e.g. connection dropped by the
  // server) shouldn't crash the whole process.
  console.error("Unexpected Postgres pool error:", err);
});

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT,
    area TEXT,
    cap TEXT NOT NULL,
    cap_notes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_name TEXT,
    -- "area" (displayed in the UI as "Area/Type") was removed as a
    -- project concept. Per this app's additive-only migration philosophy
    -- (see the "billable" migration note below), the column itself is
    -- intentionally left in place rather than dropped -- it is harmless,
    -- unused leftover schema. Nothing in the app reads or writes it
    -- anymore; do not resurrect it without adding a fresh column instead.
    area TEXT,
    status TEXT,
    priority TEXT,
    start_date TEXT,
    end_date TEXT,
    notes TEXT,
    roles TEXT NOT NULL,
    billable BOOLEAN NOT NULL DEFAULT true,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Safe-upgrade migration pattern: additive-only, idempotent DDL that runs
  -- on every cold start (see ensureInit() below). "billable" was added
  -- after this app already had projects in production, so a brand-new
  -- CREATE TABLE (above) already includes the column, but any
  -- already-existing projects table (from before this feature shipped)
  -- won't have it yet. ADD COLUMN IF NOT EXISTS ... DEFAULT true is a
  -- no-op against a table that already has the column (fresh installs),
  -- and against a table that doesn't, Postgres adds it and backfills the
  -- default into every existing row automatically -- no data is touched or
  -- lost, no manual DB intervention needed, and running this statement
  -- again on the next cold start (or every cold start, forever) is a safe
  -- no-op once the column exists. Future additive schema changes should
  -- follow this same pattern rather than hand-rolling information_schema
  -- checks.
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS billable BOOLEAN NOT NULL DEFAULT true;

  CREATE TABLE IF NOT EXISTS allocations (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    months TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    user_email TEXT,
    user_name TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    entity_name TEXT,
    field TEXT,
    old_value TEXT,
    new_value TEXT
  );

  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    user_email TEXT,
    user_name TEXT,
    label TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    snapshot TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_versions_ts ON versions(ts);
  CREATE INDEX IF NOT EXISTS idx_allocations_resource ON allocations(resource_id);
  CREATE INDEX IF NOT EXISTS idx_allocations_project ON allocations(project_id);

  -- Imported "Actual Hours" (from OpenAir Excel exports) — see
  -- server/routes/actuals.js. Additive, brand-new table (no pre-existing
  -- rows anywhere), so a plain CREATE TABLE IF NOT EXISTS is sufficient; no
  -- ALTER TABLE ADD COLUMN migration step is needed the way "billable" on
  -- projects needed one. "month" is an integer index 0-11 into the same 12
  -- FY months array as allocations.months (see meta.months / seed-data.json
  -- "months") -- NOT a calendar month number -- so it lines up exactly with
  -- how allocations already indexes months. "billable" is a snapshot of the
  -- linked project's billable flag *at import-confirm time*, for historical
  -- reporting accuracy even if the project's billable flag changes later;
  -- Project.billable (see projects table) remains the single current-state
  -- source of truth app-wide. resource_id/project_id are nullable at the
  -- column level (matches this app's existing FK-less TEXT id convention —
  -- see allocations.resource_id/project_id, which are also plain TEXT with
  -- no REFERENCES constraint), but the /api/actuals/confirm route only ever
  -- inserts rows where both matched, so in practice neither is ever null.
  CREATE TABLE IF NOT EXISTS actuals (
    id SERIAL PRIMARY KEY,
    resource_id TEXT,
    project_id TEXT,
    month INTEGER NOT NULL,
    hours NUMERIC NOT NULL,
    billable BOOLEAN NOT NULL DEFAULT true,
    source_file TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_actuals_resource ON actuals(resource_id);
  CREATE INDEX IF NOT EXISTS idx_actuals_project ON actuals(project_id);
  CREATE INDEX IF NOT EXISTS idx_actuals_month ON actuals(month);
`;

// Lazy, idempotent async init — there's no module-load-time synchronous DDL
// execution possible anymore (Postgres access is inherently async), and on
// Vercel each cold-started serverless instance needs to (re-)ensure the
// schema/seed exist before touching the DB. `initPromise` caches the first
// call's in-flight promise so every subsequent call (within the same warm
// instance) awaits the same promise instead of re-running the DDL/seed.
//
// NOTE: under concurrent cold starts (e.g. several serverless invocations
// racing on the very first request Vercel ever routes to this project),
// there's a small theoretical race where two instances both see an empty
// `resources` table and both run the seed insert, since there's no
// cross-instance lock coordinating them. `CREATE TABLE IF NOT EXISTS` makes
// concurrent schema creation safe, but the seed step isn't wrapped in a
// Postgres advisory lock. For an internal tool with a handful of users this
// is acceptable — worst case is duplicate seed rows on the very first
// deploy, trivially fixed by hand — and not worth the added complexity of
// pg_advisory_lock() here.
let initPromise = null;

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(SCHEMA_SQL);
      const { seedIfEmpty } = require("./seed");
      await seedIfEmpty();
    })().catch((err) => {
      // Let the next call retry instead of caching a permanent failure.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

// Thin convenience wrappers so call sites read almost like the old
// better-sqlite3 .prepare(sql).get()/.all()/.run() API, but async and using
// Postgres $1/$2/... placeholders instead of SQLite's `?`.
async function get(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}
async function all(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function run(sql, params = []) {
  return pool.query(sql, params);
}

// Transaction helper — replaces better-sqlite3's synchronous db.transaction().
// Checks out a dedicated client, wraps `fn` in BEGIN/COMMIT (ROLLBACK on
// error), and passes a query interface (get/all/run bound to that one
// client) into `fn` so all statements inside it run on the same connection.
async function withTransaction(fn) {
  const client = await pool.connect();
  const txDb = {
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    run: async (sql, params = []) => client.query(sql, params),
  };
  try {
    await client.query("BEGIN");
    const result = await fn(txDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, ensureInit, get, all, run, withTransaction };
