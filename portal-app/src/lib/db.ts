/**
 * PostgreSQL client shared across all server-side modules.
 *
 * Connection string is read from PORTAL_DATABASE_URL (set in compose).
 * The global singleton avoids creating a new pool on every Next.js hot-reload
 * in development.
 *
 * Schema migrations run once on first use — CREATE TABLE IF NOT EXISTS is
 * idempotent so multiple instances starting in parallel is safe.
 *
 * Privileged one-time setup (pgvector extension, portal role & schema) is
 * handled by _runSetup(), which opens a short-lived admin connection using
 * PORTAL_SETUP_DATABASE_URL.  When that variable is absent the step is
 * skipped — useful for cloud deployments where provisioning is done externally
 * (RDS, Cloud SQL, Supabase, etc.).  No shell script required.
 */

import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __pgSql: SqlClient | undefined;
}

export const sql: SqlClient =
  globalThis.__pgSql ??
  postgres(
    process.env.PORTAL_DATABASE_URL ??
      "postgresql://portal:portal@hyperset-superset-db:5432/superset",
    {
      max: 10,
      // Include public in the search_path so that objects installed there by the
      // superuser (e.g. the pgvector `vector` type from pgvector) are visible to
      // the portal role, which only owns the `portal` schema.
      connection: { search_path: '"$user", public' },
    },
  );

if (process.env.NODE_ENV !== "production") globalThis.__pgSql = sql;

// ── Schema migration ─────────────────────────────────────────────────────────
// Runs once per process; subsequent calls return the cached promise.
let _schemaInit: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (_schemaInit) return _schemaInit;
  _schemaInit = _runMigrations().catch((err) => {
    _schemaInit = null; // allow retry on transient failures
    throw err;
  });
  return _schemaInit;
}

/**
 * Privileged one-time setup: install pgvector, create the `portal` role and
 * schema, and grant the necessary permissions — all idempotently.
 *
 * Requires a DB admin connection string in PORTAL_SETUP_DATABASE_URL
 * (e.g. the superset superuser).  When the variable is absent the function
 * returns immediately, which is the right behaviour for cloud providers where
 * the DBA provisions these objects out-of-band.
 *
 * The connection is opened for this function only and closed before returning.
 */
async function _runSetup(): Promise<void> {
  const adminUrl = process.env.PORTAL_SETUP_DATABASE_URL;
  if (!adminUrl) {
    console.log("[db] PORTAL_SETUP_DATABASE_URL not set — skipping privileged setup");
    return;
  }

  // Derive the portal role password from PORTAL_DATABASE_URL so we don't need
  // a separate env var for it.
  const portalUrl =
    process.env.PORTAL_DATABASE_URL ??
    "postgresql://portal:portal@hyperset-superset-db:5432/superset";
  const portalPassword = new URL(portalUrl).password || "portal";

  const admin = postgres(adminUrl, { max: 1 });
  try {
    console.log("[db] Running privileged setup via PORTAL_SETUP_DATABASE_URL…");

    // ── pgvector extension ────────────────────────────────────────────────────
    await admin`CREATE EXTENSION IF NOT EXISTS vector`.catch(() => {
      /* already installed by a prior run or by the cloud provider */
    });

    // ── portal role ──────────────────────────────────────────────────────────
    // Check first so we can use a parameterised CREATE (DO blocks can't take
    // query parameters, which would force unsafe string interpolation).
    const [{ exists: roleExists }] = await admin<[{ exists: boolean }]>`
      SELECT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'portal'
      ) AS exists
    `;
    if (!roleExists) {
      await admin`CREATE ROLE portal WITH LOGIN PASSWORD ${portalPassword}`;
      console.log("[db] Created portal role");
    }

    // ── portal schema ─────────────────────────────────────────────────────────
    await admin`CREATE SCHEMA IF NOT EXISTS portal AUTHORIZATION portal`;
    await admin`GRANT USAGE  ON SCHEMA portal TO portal`;
    await admin`GRANT CREATE ON SCHEMA portal TO portal`;

    // Default search_path for the role: portal first (owns the tables), then
    // public (where pgvector registers its `vector` type).
    await admin`ALTER ROLE portal SET search_path = portal, public`;

    console.log("[db] Privileged setup complete");
  } finally {
    await admin.end();
  }
}

async function _runMigrations(): Promise<void> {
  // Privileged setup (extension + role + schema) — no-op when
  // PORTAL_SETUP_DATABASE_URL is absent.
  await _runSetup();

  await sql`
    CREATE TABLE IF NOT EXISTS hyperset_admin_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS hyperset_page_settings (
      name     TEXT PRIMARY KEY,
      settings JSONB NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS hyperset_kb_documents (
      id          TEXT        PRIMARY KEY,
      name        TEXT        NOT NULL,
      description TEXT        NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL,
      size        INT         NOT NULL DEFAULT 0,
      content     TEXT        NOT NULL DEFAULT ''
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS hyperset_kb_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

  // Dimensionless vector column — dimension is determined at runtime by the
  // embedding model and managed by knowledge-base.ts (ensureEmbeddingDimension).
  await sql`
    CREATE TABLE IF NOT EXISTS hyperset_kb_chunks (
      id          TEXT  PRIMARY KEY,
      doc_id      TEXT  NOT NULL REFERENCES hyperset_kb_documents(id) ON DELETE CASCADE,
      chunk_index INT   NOT NULL,
      content     TEXT  NOT NULL,
      embedding   vector
    )
  `;

  // Migrate any existing fixed-dimension column (e.g. vector(1536)) to dimensionless.
  // This is a no-op when the column is already dimensionless.
  await sql`
    ALTER TABLE hyperset_kb_chunks
      ALTER COLUMN embedding TYPE vector
      USING embedding::text::vector
  `.catch(() => {/* already dimensionless or table just created */});

  // GIN index for full-text search — avoids sequential tsvector recomputation on every query.
  await sql`
    CREATE INDEX IF NOT EXISTS hyperset_kb_chunks_content_fts_idx
      ON hyperset_kb_chunks USING GIN (to_tsvector('english', content))
  `;

  console.log("[db] Schema ready");
}
