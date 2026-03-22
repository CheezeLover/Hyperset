#!/bin/bash
# init-portal-schema.sh
# Runs once on first PostgreSQL initialization (docker-entrypoint-initdb.d).
# Creates the portal role and the portal schema inside the superset database,
# and installs the pgvector extension (needed by the portal knowledge base).
#
# POSTGRES_USER / POSTGRES_DB are set by the official postgres/pgvector image.
# PORTAL_DATABASE_PASSWORD must be forwarded via the superset-db environment.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- pgvector extension (used by portal knowledge base)
    CREATE EXTENSION IF NOT EXISTS vector;

    -- portal role
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'portal') THEN
        CREATE ROLE portal WITH LOGIN PASSWORD '${PORTAL_DATABASE_PASSWORD}';
      END IF;
    END
    \$\$;

    -- portal schema, owned by portal role
    CREATE SCHEMA IF NOT EXISTS portal AUTHORIZATION portal;
    GRANT USAGE  ON SCHEMA portal TO portal;
    GRANT CREATE ON SCHEMA portal TO portal;

    -- make portal schema the default search path for the portal role so
    -- unqualified table names (hyperset_admin_settings, etc.) land there
    ALTER ROLE portal SET search_path = portal;
EOSQL
