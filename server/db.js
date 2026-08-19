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
    area TEXT,
    status TEXT,
    priority TEXT,
    start_date TEXT,
    end_date TEXT,
    notes TEXT,
    roles TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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
