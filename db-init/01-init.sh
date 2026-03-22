#!/bin/bash
# Runs once on first start (docker-entrypoint-initdb.d).
# Creates the two isolated schemas and their dedicated users inside
# the single 'hyperset' database.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
-- pgvector extension (database-level; only the superuser can create it)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Schemas ──────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS portal;
CREATE SCHEMA IF NOT EXISTS superset;

-- ── Portal user ──────────────────────────────────────────────────────────────
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'portal') THEN
        CREATE USER portal WITH PASSWORD '${PORTAL_DATABASE_PASSWORD}';
    ELSE
        ALTER USER portal WITH PASSWORD '${PORTAL_DATABASE_PASSWORD}';
    END IF;
END
\$\$;

GRANT USAGE, CREATE ON SCHEMA portal TO portal;
ALTER DEFAULT PRIVILEGES IN SCHEMA portal GRANT ALL ON TABLES    TO portal;
ALTER DEFAULT PRIVILEGES IN SCHEMA portal GRANT ALL ON SEQUENCES TO portal;
-- Default search_path so the app never needs to qualify table names
ALTER USER portal SET search_path = portal;

-- ── Superset user ─────────────────────────────────────────────────────────────
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'superset') THEN
        CREATE USER superset WITH PASSWORD '${DATABASE_PASSWORD}';
    ELSE
        ALTER USER superset WITH PASSWORD '${DATABASE_PASSWORD}';
    END IF;
END
\$\$;

GRANT USAGE, CREATE ON SCHEMA superset TO superset;
ALTER DEFAULT PRIVILEGES IN SCHEMA superset GRANT ALL ON TABLES    TO superset;
ALTER DEFAULT PRIVILEGES IN SCHEMA superset GRANT ALL ON SEQUENCES TO superset;
ALTER USER superset SET search_path = superset;
SQL
