# Hyperset

A self-hosted analytics portal that brings your tools together under one roof — one domain, one login, one clean interface.

It runs entirely in containers (Podman), requires no cloud services, and is designed to be extended without touching any shared code.

---

## 🚀 Quick Start

### Get up and running in 5 minutes

**Prerequisites:**
- Debian 12+ machine (physical, VM, or LXC)
- Ports 80 and 443 open
- Domain name or local hostname (e.g., `hyperset.internal`)
- OpenAI-compatible LLM API endpoint and key

**1. Clone and configure:**
```bash
git clone https://github.com/CheezeLover/Hyperset.git
cd Hyperset
cp .env .env.bak
# Edit .env with your settings
```

**2. Generate required secrets:**
```bash
# AUTH_CRYPTO_KEY (32-byte hex)
openssl rand -hex 32

# SESSION_SECRET (min 32 chars)
openssl rand -base64 32

# MCP_SERVICE_SECRET (min 32 chars)
openssl rand -hex 32
```

**3. Set up DNS / hosts file:**
```
# Add to /etc/hosts or your DNS server
<server-ip>  hyperset.internal
<server-ip>  auth.hyperset.internal
<server-ip>  superset.hyperset.internal
<server-ip>  pages.hyperset.internal
```

**4. Deploy:**
```bash
chmod +x setup_podman.sh
./setup_podman.sh
```

**5. Create your admin user:**
- Visit `https://auth.hyperset.internal`
- Register — the first user is automatically granted the `authp/admin` role by Caddy

**6. Open the portal:**
- Go to `https://hyperset.internal`
- Click **Chat** in the sidebar to talk to your data

---

## 📦 Deploying a Superset Instance

Hyperset includes a script to deploy a production-ready Superset instance configured for header-based SSO.

### Using the included setup script

```bash
cd Superset-Instance
chmod +x superset_test_setup.sh
./superset_test_setup.sh
```

**What it does:**
1. Clones official Superset 6.0.0
2. Configures header-based auth (`AUTH_REMOTE_USER`)
3. Sets up Redis caching
4. Creates an admin user automatically
5. Starts on port 8088

**Optional environment variables before running:**
```bash
SUPERSET_PORT=8088 SUPERSET_SECRET_KEY=$(openssl rand -hex 32) ./superset_test_setup.sh
```

**Connect to Hyperset:**
```env
# In your Hyperset .env
SUPERSET_UPSTREAM=http://localhost:8088
SUPERSET_PUBLIC_URL=https://superset.hyperset.internal
```

---

## 🔧 Architecture

```
Browser → Caddy (HTTPS, port 80/443)
               │
               ├─► Portal (Next.js, port 3000)
               │       └─► Superset MCP Server (Python/FastAPI, port 8000)
               │
               ├─► Superset (proxied, header auth injected)
               │
               ├─► Pages Service (FastAPI, custom pages)
               │
               └─► Auth Portal (caddy-security, login/registration)

Network: hyperset-net (internal Podman bridge)
  - Caddy is the ONLY container with host port bindings (80, 443)
  - All inter-service traffic stays on the internal network
  - Superset can be on the same machine, a different server, or cloud
```

### Authentication Flow

```
User Browser → Caddy (HTTPS) → injects X-Token-User-* headers → Portal / Services
                                                              ↓
                            Caddy also injects X-Webauth-* headers → Superset (AUTH_REMOTE_USER)
```

**Critical security rule:** Superset must **not** be directly internet-accessible. Only Caddy should reach it — it trusts the `X-Webauth-User` header unconditionally.

### Header Injection

Caddy injects these headers into all upstream requests (signed JWT, verified by Caddy):

| Header | Content |
|--------|---------|
| `X-Token-User-Id` | User identifier |
| `X-Token-User-Email` | User email |
| `X-Token-User-Roles` | Space-separated role list |
| `X-Webauth-User` | Username forwarded to Superset |
| `X-Webauth-Email` | Email forwarded to Superset |
| `X-Webauth-Groups` | Roles forwarded to Superset |

Required Superset configuration:
```python
AUTH_TYPE = AUTH_REMOTE_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"
```

---

## ⚙️ Environment Variables

All variables live in the root `.env` file and are shared across containers via `podman-compose`. Variables marked **required** have no safe default and must be set before starting.

### Core / Infrastructure

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HYPERSET_DOMAIN` | ✅ | — | Base domain (e.g., `hyperset.internal`). All subdomains are derived from this. |
| `AUTH_CRYPTO_KEY` | ✅ | — | 32-byte hex key for JWT signing and auth cookie encryption. Generate: `openssl rand -hex 32` |
| `SESSION_SECRET` | ✅ | — | Min-32-char secret for iron-session cookie encryption (admin settings). Generate: `openssl rand -base64 32` |
| `MCP_SERVICE_SECRET` | ✅ | — | Min-32-char HMAC secret shared between the portal and the MCP server for token signing. Generate: `openssl rand -hex 32` |

### Superset Integration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPERSET_UPSTREAM` | ✅ | — | Internal address of your Superset instance as seen by Caddy and the MCP server (e.g., `http://hyperset-superset:8088` or `https://superset.mycompany.com`). |
| `SUPERSET_PUBLIC_URL` | ✅ | `https://superset.{HYPERSET_DOMAIN}` | Browser-accessible Superset URL. Must be reachable by the end-user's browser. Used for iframe embeds and links in chat. |
| `SUPERSET_MCP_USER` | — | `admin` | Superset username the portal impersonates when making MCP calls on behalf of users. In `AUTH_REMOTE_USER` mode no password is needed. |
| `SUPERSET_MCP_PASSWORD` | — | _(empty)_ | Superset password. Only required if Superset uses classic database authentication instead of `AUTH_REMOTE_USER`. |

### LLM / Chat

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_URL` | ✅ | — | OpenAI-compatible API base URL (e.g., `https://api.mistral.ai/v1`, `http://localhost:11434/v1`). |
| `LLM_API_KEY` | ✅ | — | API key for the LLM provider. |
| `LLM_MODEL` | — | `gpt-4o` | Default model name passed to the API. |
| `LLM_SYSTEM_PROMPT` | — | _(built-in)_ | Override the default system prompt for the AI chat assistant. If unset, the built-in Hyperset prompt is used. |
| `LLM_MAX_TURNS` | — | `40` | Maximum agentic turns (tool call round-trips) per chat message. Range: 1–200. |
| `LLM_MAX_TOOL_RESULT_CHARS` | — | `3000` | Maximum characters returned per tool call result. Reduce for low-context models. Range: 500–50000. |
| `LLM_MAX_HISTORY_MESSAGES` | — | `20` | Maximum conversation history messages sent to the LLM. Range: 4–200. |

> **Note:** All LLM settings can be overridden at runtime by admins via the settings gear icon in the chat. Runtime overrides take priority over environment variables.

### Pages Service

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAGES_PUBLIC_URL` | — | `https://pages.{HYPERSET_DOMAIN}` | Browser-accessible URL of the Pages service. Used by the portal to load custom pages. |

### AI Chart Cleanup

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HYPERSET_CLEANUP_DELAY_MINUTES` | — | `120` | How long (in minutes) to keep AI-generated temporary charts before automatic deletion. Range: 1–10080 (1 min to 1 week). Can also be set at runtime via the admin panel. |

### OAuth / OIDC (only needed with an external identity provider)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OAUTH_CLIENT_ID` | — | — | OAuth 2.0 client ID from your identity provider. |
| `OAUTH_CLIENT_SECRET` | — | — | OAuth 2.0 client secret. |
| `OIDC_METADATA_URL` | — | — | OIDC discovery endpoint (e.g., `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`). |
| `ENTRA_TENANT_ID` | — | `common` | Azure AD / Entra tenant ID. Set to a specific tenant GUID for single-tenant deployments. |

### MCP Server (advanced, Superset-MCP only)

These are only needed if you run the MCP server outside of podman-compose or need to change its defaults.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPERSET_MCP_URL` | — | `http://hyperset-superset-mcp:8000/mcp` | Full URL of the MCP server as seen by the portal. Override in local dev (e.g., `http://localhost:8000/mcp`). |
| `HYPERSET_PORTAL_URL` | — | `https://pages.{HYPERSET_DOMAIN}` | URL the MCP server uses to fetch runtime admin settings (cleanup delay). Override in local dev (e.g., `http://localhost:3000`). |
| `HYPERSET_CLEANUP_USER` | — | `admin@HYPERSET.local` | Superset username the cleanup job impersonates when deleting stale AI charts. Must be a valid Superset admin. |
| `HYPERSET_CLEANUP_EMAIL` | — | `admin@HYPERSET.local` | Superset email for the cleanup job identity. |
| `MCP_TRANSPORT` | — | `streamable-http` | MCP transport mode. Use `stdio` for Claude Desktop integration. |
| `MCP_HOST` | — | `0.0.0.0` | Bind address for the MCP HTTP server. |
| `MCP_PORT` | — | `8000` | Bind port for the MCP HTTP server. |

### Portal Internal (advanced)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_SETTINGS_PATH` | — | _(in-memory)_ | File path for persisting admin runtime settings across portal restarts. If unset, settings reset on restart. |

---

## 🤖 AI Chart Cleanup

When the AI chat creates charts, they are stamped with `[HYPERSET-AI-TEMPORARY]` and a UTC timestamp in their description. A background job in the MCP server automatically deletes these after the configured delay.

**Lifecycle of an AI chart:**
1. **Created** → stamped `[HYPERSET-AI-TEMPORARY] {ISO-datetime} | {user}`
2. **Added to a dashboard** → automatically promoted to `[HYPERSET-AI-PERMANENT]` (never deleted)
3. **"Keep permanently" clicked** → promoted to `[HYPERSET-AI-PERMANENT]` (never deleted)
4. **Ignored past the delay** → deleted by the cleanup job

**Cleanup job behavior:**
- Runs every 5 minutes
- Fetches the current delay from the portal's `/api/cleanup-config` endpoint (so admin-panel changes take effect without restarting)
- Falls back to `HYPERSET_CLEANUP_DELAY_MINUTES` env var if the portal is unreachable
- Logs all deletions at INFO level

**Configure via admin panel:** The gear icon in chat → "Temporary chart lifetime" field (in minutes).

---

## 🛠️ Maintenance & Updates

### Updating Components

**Portal:**
```bash
podman rm -f hyperset-portal
podman-compose up --build -d portal
```

**MCP Server:**
```bash
podman rm -f hyperset-superset-mcp
podman-compose up --build -d superset-mcp
```

**Superset:**
```bash
cd Superset-Instance
./superset_test_setup.sh  # Uses pinned version 6.0.0
```

### Backup & Restore

**Superset Database:**
```bash
# Backup
podman exec superset_db pg_dump -U superset superset > superset_backup.sql

# Restore
cat superset_backup.sql | podman exec -i superset_db psql -U superset superset
```

**Caddy Users:**
```bash
# Backup
cp Caddy/users.json users_backup.json

# Restore
cp users_backup.json Caddy/users.json
podman-compose restart caddy
```

---

## 🚨 Troubleshooting

### Common Issues

**🔴 Chat not responding / API key error**
- Verify `LLM_API_KEY` and `LLM_API_URL` in `.env`
- Test connectivity: `curl $LLM_API_URL/models -H "Authorization: Bearer $LLM_API_KEY"`
- Check portal logs: `podman logs hyperset-portal -f`

**🔴 MCP connection errors / data tools disabled**
- Verify `MCP_SERVICE_SECRET` is the same in both `.env` and `Superset-MCP/.env`
- Check MCP logs: `podman logs hyperset-superset-mcp -f`
- Verify `SUPERSET_UPSTREAM` is reachable from the `hyperset-net` network
- Test: `curl http://localhost:8000/mcp`

**🔴 AI chart cleanup failing (400 errors)**
- Check MCP logs for `chart list query failed`
- Verify `HYPERSET_CLEANUP_USER` / `HYPERSET_CLEANUP_EMAIL` match a valid Superset admin account

**🔴 Embedded charts showing wrong domain / broken iframes**
- Verify `SUPERSET_PUBLIC_URL` is set to the browser-accessible Superset URL
- This must not be an internal hostname (e.g., `http://hyperset-superset:8088`) — it must resolve in the user's browser

**🔴 Login loop / auth issues**
- Verify `AUTH_CRYPTO_KEY` is set and is a 32-byte hex string
- Verify `auth.{HYPERSET_DOMAIN}` resolves correctly
- Test Superset header auth: `curl -H "X-Webauth-User: admin@HYPERSET.local" http://localhost:8088/api/v1/me/`

**🔴 Pages not appearing**
- Verify `pages.{HYPERSET_DOMAIN}` resolves correctly
- Check Pages service logs: `podman logs hyperset-pages -f`
- List discovered pages: `curl https://pages.{HYPERSET_DOMAIN}/__pages__`

### Service Health Checks

```bash
# Portal
curl -I http://localhost:3000/api/config

# MCP Server
curl -I http://localhost:8000/mcp

# Superset
curl -I http://localhost:8088/health
```

### View Logs

```bash
# All services (follow)
podman-compose logs -f

# Specific service
podman logs hyperset-portal -f
podman logs hyperset-superset-mcp -f
podman logs hyperset-caddy -f
```

---

## 📚 API Reference

### Portal API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config` | Public config: Superset URL, Pages URL, current user |
| `GET` | `/api/chat` | Health check / MCP connectivity probe |
| `POST` | `/api/chat` | Streaming chat completion |
| `GET` | `/api/admin` | Get current effective LLM settings (admin only) |
| `POST` | `/api/admin` | Save runtime LLM settings (admin only) |
| `DELETE` | `/api/admin` | Reset runtime settings to env defaults (admin only) |
| `PATCH` | `/api/admin` | Validate API credentials (admin only) |
| `GET` | `/api/cleanup-config` | Get current cleanup delay in minutes (used by MCP server) |
| `POST` | `/api/chart-promote` | Promote an AI chart from temporary to permanent |

### Pages Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/__pages__` | List all discovered pages |
| `GET` | `/{page_name}` | Serve a custom page |
| `*` | `/{page_name}/api/*` | Proxy to the page's backend |

### MCP Server

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/mcp` | MCP protocol endpoint (requires `Authorization: Bearer <token>`) |

---

## 🎯 Project Philosophy

**Self-hosted first:** No cloud lock-in, no telemetry, no external dependencies

**Container-native:** Everything runs in Podman/Docker with minimal host requirements

**Extensible:** Add features without modifying shared code (drop-in pages, custom backends)

**Secure by default:** Header-based auth, internal networking, TLS everywhere

**Developer-friendly:** Hot-reload for pages, clear logs, TypeScript throughout

---

## 📞 Support & Contributing

**Issues:** Report bugs and feature requests on GitHub

**Contributing:** Pull requests welcome — bug fixes, documentation, new page examples, MCP tool enhancements

**License:** MIT

---

*Built with ❤️ for data teams who value privacy and control*
