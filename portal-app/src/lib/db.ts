/**
 * PostgreSQL client shared across all server-side modules.
 *
 * Connection string is read from PORTAL_DATABASE_URL (set in compose).
 * The global singleton avoids creating a new pool on every Next.js hot-reload
 * in development.
 *
 * Schema migrations run once on first use — CREATE TABLE IF NOT EXISTS is
 * idempotent so multiple instances starting in parallel is safe.
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
      "postgresql://portal:portal@hyperset-portal-db:5432/portal",
    { max: 10 },
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

async function _runMigrations(): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

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

  console.log("[db] Schema ready");
}
