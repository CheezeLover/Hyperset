# Superset MCP Server (Hyperset Edition)

A Model Context Protocol (MCP) server that connects the Hyperset AI chat to an Apache Superset instance. It allows the AI assistant to query data, create charts and dashboards, and manage the Superset instance programmatically on behalf of authenticated users.

> **Note:** This is Hyperset's custom fork. It uses header-based SSO authentication (no username/password), HMAC-signed tokens for security, and includes the AI chart provenance and cleanup system. It is **not** compatible with the upstream `@aptro/superset-mcp` configuration.

---

## How It Works

The portal generates a short-lived HMAC-signed token for each chat session. The MCP server verifies this token, extracts the user's identity, and proxies all Superset API calls using `X-Webauth-User` / `X-Webauth-Email` headers — impersonating the requesting user in Superset.

A separate background task runs every 5 minutes to delete stale AI-generated charts (those stamped `[HYPERSET-AI-TEMPORARY]` that have not been promoted to permanent or added to a dashboard).

---

## Setup (within Hyperset stack)

The MCP server is managed by `podman-compose` from the root `Hyperset` directory. No separate configuration is needed beyond the root `.env` file.

```bash
# From the Hyperset root
podman-compose up -d superset-mcp

# View logs
podman logs hyperset-superset-mcp -f
```

## Setup (standalone / local dev)

```bash
cd Superset-MCP

# Install dependencies
pip install -r requirements.txt
# or with uv:
uv pip install .

# Create .env
cp .env.example .env
# Edit .env — set SUPERSET_UPSTREAM and MCP_SERVICE_SECRET at minimum

# Run
python main.py
```

---

## Environment Variables

All variables can be set in `Superset-MCP/.env` or passed as environment variables.

### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVICE_SECRET` | _(none)_ | **Required.** Min-32-char HMAC secret for verifying tokens from the portal. Must match `MCP_SERVICE_SECRET` in the root `.env`. Generate: `openssl rand -hex 32` |

### Superset Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERSET_UPSTREAM` | `http://localhost:8088` | Internal URL of the Superset instance. Also accepted as `SUPERSET_BASE_URL` (legacy alias). |
| `SUPERSET_PUBLIC_URL` | _(same as `SUPERSET_UPSTREAM`)_ | Browser-accessible Superset URL. Used to build iframe embed links and chart/dashboard links returned to the chat. Must be reachable by the end-user's browser — set this explicitly if `SUPERSET_UPSTREAM` is an internal hostname. |

### Portal Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `HYPERSET_DOMAIN` | _(empty)_ | Base domain (e.g., `hyperset.internal`). Used to derive the portal URL as `https://pages.{HYPERSET_DOMAIN}`. |
| `HYPERSET_PORTAL_URL` | `https://pages.{HYPERSET_DOMAIN}` | Full URL of the portal's Pages service. The cleanup job fetches the configured cleanup delay from `{HYPERSET_PORTAL_URL}/api/cleanup-config` on every cycle. Override in local dev (e.g., `http://localhost:3000`). If neither `HYPERSET_DOMAIN` nor `HYPERSET_PORTAL_URL` is set, the cleanup job falls back to `HYPERSET_CLEANUP_DELAY_MINUTES`. |

### AI Chart Cleanup

| Variable | Default | Description |
|----------|---------|-------------|
| `HYPERSET_CLEANUP_DELAY_MINUTES` | `120` | Fallback lifetime (in minutes) for temporary AI charts when the portal is unreachable. Range: 1–10080. The live value is fetched from the portal at runtime and takes priority. |
| `HYPERSET_CLEANUP_USER` | `admin@HYPERSET.local` | Superset username the cleanup job uses when deleting charts. Must be a valid Superset admin account. |
| `HYPERSET_CLEANUP_EMAIL` | `admin@HYPERSET.local` | Superset email for the cleanup job identity. |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `streamable-http` | Transport mode. Use `streamable-http` for Hyperset portal integration. Use `stdio` for Claude Desktop or other local MCP clients. |
| `MCP_HOST` | `0.0.0.0` | Bind address (streamable-http mode only). |
| `MCP_PORT` | `8000` | Bind port (streamable-http mode only). |

---

## Available MCP Tools

### Data Discovery
- `superset_analyze_data` — Full schema discovery: databases, datasets, and typed columns in one call. Start here before building charts.

### Dashboards
- `superset_dashboard_list` — List all dashboards (id, title, status)
- `superset_dashboard_get_by_id` — Full dashboard details including layout
- `superset_dashboard_create` — Create a new dashboard
- `superset_dashboard_update` — Update an existing dashboard
- `superset_dashboard_delete` — Delete a dashboard

### Charts
- `superset_chart_types` — Full catalog of supported chart types with required/optional parameters. Call before `superset_chart_create`.
- `superset_chart_list` — List all charts (id, name, viz_type, datasource_id)
- `superset_chart_get_by_id` — Full chart details
- `superset_chart_create` — Create a new chart (validates params and column names before creating)
- `superset_chart_update` — Update an existing chart
- `superset_chart_delete` — Delete a chart

### Datasets & Databases
- `superset_dataset_list` — List all datasets (id, table_name, schema, database_id)
- `superset_dataset_get_by_id` — Get exact column names and types for a dataset. Call before `superset_chart_create`.
- `superset_database_list` — List all databases (id, name, backend)
- `superset_database_get_by_id` — Full database connection details
- `superset_database_create` — Create a new database connection

### SQL
- `superset_sqllab_execute_query` — Execute a SQL query against a database

### Embedding & Links
- `superset_get_chart_embed` — Get an iframe embed markdown string for a chart (renders inline in chat)
- `superset_get_dashboard_embed` — Get an iframe embed markdown string for a dashboard
- `superset_get_chart_link` — Get a clickable markdown link to open a chart in the Superset panel
- `superset_get_dashboard_link` — Get a clickable markdown link to open a dashboard in the Superset panel

### User & System
- `superset_user_get_current` — Get the current authenticated user's info
- `superset_user_get_roles` — Get the current user's roles
- `superset_config_get_base_url` — Get the Superset instance URL

---

## AI Chart Provenance

Every chart created by the AI is stamped with a machine-readable tag in its description:

```
[HYPERSET-AI-TEMPORARY] 2025-01-15T10:30:00Z | user@example.com
```

**Lifecycle:**
- `[HYPERSET-AI-TEMPORARY]` → eligible for deletion after the configured delay
- `[HYPERSET-AI-PERMANENT]` → never deleted (added to a dashboard, or user clicked "Keep permanently")

Promotion from temporary to permanent happens automatically when a dashboard containing the chart is created or updated.

---

## Security

- All MCP tool calls require a valid HMAC-signed `Authorization: Bearer <token>` header
- Tokens are generated by the portal using the shared `MCP_SERVICE_SECRET` and expire after a short TTL
- The cleanup job uses its own dedicated HTTP client and session, so its credentials never interfere with user sessions
- CSRF tokens are fetched and included for all non-GET Superset API calls

---

## Troubleshooting

**`MCP_SERVICE_SECRET must be set and >= 32 chars`**
- The server will refuse to start if this variable is missing or too short. Set it in `.env`.

**`chart list query failed: Superset 400`**
- The Superset API filter format requires `"value"` (not `"val"`). This is already correct in the current code. Check your Superset version compatibility.

**`Failed to delete chart: Superset 403`**
- `HYPERSET_CLEANUP_USER` / `HYPERSET_CLEANUP_EMAIL` do not match a valid Superset admin account. Update them to match an existing admin user in your Superset instance.

**Embed links resolving to an internal hostname**
- Set `SUPERSET_PUBLIC_URL` explicitly to the browser-accessible Superset URL. Do not rely on the fallback to `SUPERSET_UPSTREAM` in production.

---

## License

MIT
