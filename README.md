# Hyperset

A self-hosted analytics portal that brings your tools together under one roof — one domain, one login, one clean interface.

It runs entirely in containers (Podman), requires no cloud services, and is designed to be extended without touching any shared code.

---

## 🚀 Quick Start (User-Friendly)

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
cp .env.example .env
# Edit .env with your settings
```

**2. Generate keys:**
```bash
# For AUTH_CRYPTO_KEY (32-byte hex)
openssl rand -hex 32

# For SESSION_SECRET (min 32 chars)
openssl rand -base64 32
```

**3. Set up DNS/hosts:**
```
# Add to /etc/hosts or Windows hosts file
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

**5. Create admin user:**
- Visit `https://auth.hyperset.internal`
- First user automatically gets admin rights

**6. Open portal:**
- Go to `https://hyperset.internal`
- Click **Chat** in sidebar to talk to your data

---

## 📦 Deploying a Superset Test Instance

Hyperset includes everything you need to deploy a **production-ready Superset instance** configured for Hyperset SSO.

### Using the included setup script

```bash
cd Superset-Instance
chmod +x superset_test_setup.sh
./superset_test_setup.sh
```

**What it does:**
1. Clones official Superset 6.0.0
2. Configures header-based auth (AUTH_REMOTE_USER)
3. Sets up Redis caching
4. Creates admin user automatically
5. Starts on port 8088

**Configuration:**
- Edit `superset_config_docker.py` for auth settings
- Edit `superset_config.py` for full customization
- Set environment variables before running:
  ```bash
  SUPERSET_PORT=8088 SUPERSET_SECRET_KEY=$(openssl rand -hex 32) ./superset_test_setup.sh
  ```

**Connect to Hyperset:**
```env
# In your Hyperset .env
SUPERSET_UPSTREAM=http://localhost:8088
```

---

## 🔧 Technical Architecture & Security

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   ┌─────────────┐    ┌─────────────┐    ┌───────────────────────┐   │
│   │             │    │             │    │                       │   │
│   │  Browser    │───▶│   Caddy     │───▶│    Portal (Next.js)    │   │
│   │             │    │             │    │  ┌───────────────────┐  │   │
│   └─────────────┘    └─────────────┘    │  │  Chat Panel       │  │   │
│           ▲              ▲              │  │  ┌─────────────┐  │  │   │
│           │              │              │  │  │  AI Chat    │  │  │   │
│           │              │              │  │  └─────────────┘  │  │   │
│           │              │              │  │  ┌─────────────┐  │  │   │
│           │              │              │  │  │  MCP Client │◀─┼──┘   │
│           │              │              │  └───────────────────┘  │   │
│           │              │              └───────────────────────┘   │   │
│           │              │                                      │   │
│   ┌─────────────┐    ┌─────────────┐    ┌───────────────────────┐   │   │
│   │             │    │             │    │                       │   │   │
│   │  Browser    │───▶│   Caddy     │───▶│   Superset iframe   │   │   │
│   │             │    │             │    │  ┌───────────────────┐  │   │   │
│   └─────────────┘    └─────────────┘    │  │  Bridge.js       │  │   │   │
│           ▲              ▲              │  │  (injected)       │  │   │   │
│           │              │              │  └───────────────────┘  │   │   │
│           │              │              └───────────────────────┘   │   │
│           │              │                                      │   │
│   ┌─────────────┐    ┌─────────────┐    ┌───────────────────────┐   │   │
│   │             │    │             │    │                       │   │   │
│   │  Browser    │───▶│   Caddy     │───▶│   Pages Service     │   │   │
│   │             │    │             │    │  (FastAPI)           │   │   │
│   └─────────────┘    └─────────────┘    └───────────────────────┘   │   │
│                                                                     │   │
│   ┌─────────────┐    ┌─────────────┐    ┌───────────────────────┐   │   │
│   │             │    │             │    │                       │   │   │
│   │  Browser    │───▶│   Caddy     │───▶│   Auth Portal       │   │   │
│   │             │    │             │    │  (login/registration)│   │   │
│   └─────────────┘    └─────────────┘    └───────────────────────┘   │   │
│                                                                     │   │
└─────────────────────────────────────────────────────────────────────┘   │   │
                                                                         │   │
┌─────────────────────────────────────────────────────────────────────┐   │   │
│                                                                     │   │   │
│   ┌───────────────────────────────────────────────────────────────┐  │   │   │
│   │                                                               │  │   │   │
│   │                        Superset MCP                         │  │   │   │
│   │                   (Model Context Protocol)                  │  │   │   │
│   │                                                               │  │   │   │
│   └───────────────────────────────────────────────────────────────┘  │   │   │
│                         ▲                                      ▲    │   │   │
└─────────────────────────┼──────────────────────────────────────┼────┘   │   │
                          │                                      │      │   │
                          │                                      │      │   │
                          ▼                                      ▼      │   │
                  ┌─────────────────────┐            ┌─────────────┐  │   │
                  │                     │            │             │  │   │
                  │   Superset Instance │◄───────────│  Caddy     │  │   │
                  │  (Docker/Podman)    │            │  (reverse   │  │   │
                  │                     │            │  proxy)     │  │   │
                  └─────────────────────┘            └─────────────┘  │   │
                                                                         │   │
└─────────────────────────────────────────────────────────────────────┘   │   │
                                                                         │   │
┌─────────────────────────────────────────────────────────────────────┐   │   │
│                                                                     │   │   │
│   Network: hyperset-net (internal Podman network)                  │   │   │
│   - Caddy is the ONLY container exposing ports to host            │   │   │
│   - All inter-service traffic stays on internal network            │   │   │
│   - Superset can be on same machine, different server, or cloud   │   │   │
│                                                                     │   │   │
└─────────────────────────────────────────────────────────────────────┘   │   │
                                                                         │   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Security Constraints & Best Practices

#### 🔒 Authentication Flow
```
User Browser → Caddy (HTTPS) → Header Injection → Superset (AUTH_REMOTE_USER)
                    ▲                                      ▲
                    │                                      │
               Auth Cookie                          Trusts Header
               (JWT signed)                          (No password check)
```

**Critical Security Rules:**
1. **Superset MUST NOT be directly internet-accessible**
   - Only Caddy should reach Superset
   - Bind Superset to `127.0.0.1` or use firewall rules
   - `AUTH_REMOTE_USER` trusts the header setter (Caddy)

2. **Header-based auth configuration:**
   ```python
   # In superset_config.py
   AUTH_TYPE = AUTH_REMOTE_USER
   REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"
   AUTH_ROLES_MAPPING = {
       "hyperset/admin": ["Admin"],
       "hyperset/user": ["Gamma"],
   }
   ```

3. **Role assignment:**
   - Roles set ONLY at user creation from `X-Webauth-Groups` header
   - After creation, manage roles in Superset UI
   - First user to register becomes admin

#### 🛡️ Network Security

**Container Networking:**
- `hyperset-net`: Internal Podman network (RFC1918 space)
- Caddy: Only container with host port bindings (80, 443)
- Superset: Accessible only via `hyperset-superset:8088` on internal network

**Firewall Rules (Recommended):**
```bash
# Allow only Caddy to talk to Superset
sudo ufw allow from 172.20.0.0/16 to any port 8088
sudo ufw deny 8088
```

#### 🔐 Data Security

**Session Storage:**
- Admin LLM settings: Encrypted in iron-session cookies (AES-256)
- User sessions: JWT signed with `AUTH_CRYPTO_KEY` (32+ byte)
- Session secret: `SESSION_SECRET` (32+ char base64)

**Database:**
- Superset uses PostgreSQL (included in docker compose)
- MCP server: Stateless (no database)
- Pages service: Ephemeral (no persistent storage)

---

## 🎛️ Advanced Configuration

### Model Parameters (JSON)

Admins can now pass additional model parameters via the settings modal:

```json
{
  "temperature": 0.7,
  "max_tokens": 1024,
  "top_p": 0.9,
  "frequency_penalty": 0.1,
  "presence_penalty": 0.1
}
```

**Supported parameters:** Any parameter accepted by your LLM provider's API
**Validation:** Admin responsibility to ensure compatibility with chosen model
**Storage:** Saved in encrypted session cookie (24h TTL)

### Customizing Superset

**Environment variables for Superset container:**
```env
# In Superset-Instance/docker/.env-local
SUPERSET_PORT=8088
SECRET_KEY=your-32-byte-hex-key
TAG=6.0.0
HYPERSET_ORIGIN=https://hyperset.internal
```

**Role mapping:**
```env
# In superset_config_docker.py
HYPERSET_ADMIN_ROLE_HEADER="hyperset/admin"  # Maps to Superset Admin
HYPERSET_USER_ROLE_HEADER="hyperset/user"    # Maps to Superset Gamma
```

---

## 🔧 Deployment Scenarios

### Scenario 1: All-in-One (Recommended for testing)
```
┌───────────────────────────────────────────────────────┐
│  Single Machine                                         │
│  ┌───────────┐  ┌───────────┐  ┌─────────────────────┐  │
│  │  Caddy    │  │  Portal  │  │   Superset         │  │
│  └───────────┘  └───────────┘  │  (Docker)          │  │
│        ▲          ▲             └─────────────────────┘  │
│        │          │                                  │  │
│  ┌─────┴──────┐  │                                  │  │
│  │            │  │                                  │  │
│  │  Browser   │  └──────────────────────────────────┘  │
│  │            │                                          │
│  └────────────┘                                          │
└───────────────────────────────────────────────────────┘
```

**Setup:**
```bash
# In Hyperset directory
./setup_podman.sh

# In Superset-Instance directory  
./superset_test_setup.sh
```

### Scenario 2: Separate Superset Server
```
┌─────────────────┐       ┌─────────────────────────────────┐
│  Hyperset       │       │  Superset Server                │
│  ┌───────────┐  │       │  ┌───────────────────────────┐  │
│  │  Caddy    │◄───────▶│  │   Superset (AUTH_REMOTE) │  │
│  └───────────┘  │       │  └───────────────────────────┘  │
│  ┌───────────┐  │       │                                │
│  │  Portal   │  │       │                                │
│  └───────────┘  │       └─────────────────────────────────┘
│  ┌───────────┐  │
│  │  MCP      │◄─┘
│  └───────────┘  │
└─────────────────┘
```

**Configuration:**
```env
# In Hyperset .env
SUPERSET_UPSTREAM=https://superset.yourcompany.com

# On Superset server
AUTH_TYPE = AUTH_REMOTE_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"
```

### Scenario 3: Cloud LLM with Local Superset
```
┌───────────────────────────────────────────────────────┐
│  Your Infrastructure                                    │
│  ┌───────────┐  ┌───────────┐  ┌─────────────────────┐  │
│  │  Caddy    │  │  Portal  │  │   Superset         │  │
│  └───────────┘  └───────────┘  │  (Local Docker)     │  │
│        ▲          ▲             └─────────────────────┘  │
│        │          │                                  │  │
│  ┌─────┴──────┐  │                                  │  │
│  │            │  │                                  │  │
│  │  Browser   │  └──────────────────────────────────┘  │
│  │            │                                          │
│  └────────────┘                                          │
└───────────────────────────────────────────────────────┘
        ▲
        │  HTTPS
        │
┌───────────────────────────────────────────────────────┐
│  Cloud Provider                                        │
│  ┌─────────────────────────────────────────────────┐  │
│  │  LLM API (Mistral/Ollama/OpenAI)                │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

**Configuration:**
```env
# In Hyperset .env
LLM_API_URL=https://api.mistral.ai/v1
LLM_API_KEY=your-cloud-api-key
LLM_MODEL=ministral-3b-2512
```

---

## 🛠️ Maintenance & Updates

### Updating Components

**Portal:**
```bash
cd portal-app
podman rm -f hyperset-portal
podman-compose up --build -d portal
```

**MCP Server:**
```bash
cd Superset-MCP
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

## 🚨 Troubleshooting Guide

### Common Issues & Solutions

**🔴 Chat not responding / API key error**
- ✅ Verify `LLM_API_KEY` in `.env`
- ✅ Check `LLM_API_URL` matches your provider
- ✅ Test with: `curl $LLM_API_URL/v1/models -H "Authorization: Bearer $LLM_API_KEY"`

**🔴 MCP connection errors**
- ✅ Verify `SUPERSET_MCP_USER` is a Superset admin
- ✅ Check `podman logs hyperset-superset-mcp`
- ✅ Ensure `SUPERSET_UPSTREAM` is reachable from `hyperset-net`

**🔴 Bridge.js not loading**
- ✅ Rebuild Caddy: `podman-compose up --build -d caddy`
- ✅ Check browser console for `[Hyperset Bridge] Loaded`
- ✅ Verify Caddy strips CSP headers

**🔴 Login loop / auth issues**
- ✅ Check `AUTH_CRYPTO_KEY` is set (32+ bytes)
- ✅ Verify `auth.{domain}` resolves correctly
- ✅ Test auth: `curl -H "X-Webauth-User: test" http://localhost:8088/login/`

**🔴 Pages not appearing**
- ✅ Verify `pages.{domain}` in hosts file
- ✅ Check browser console for `[Hyperset]` errors
- ✅ See discovered pages: `curl https://pages.{domain}/__pages__`

### Debugging Commands

**Check service health:**
```bash
# Portal
curl -I http://localhost:3000/api/config

# MCP
curl -I http://localhost:8000/mcp

# Superset
curl -I http://localhost:8088/health
```

**View logs:**
```bash
# All services
podman-compose logs -f

# Specific service
podman logs hyperset-portal -f

# With timestamps
podman logs hyperset-caddy --format "{{.CreatedAt}} {{.Message}}"
```

**Test authentication:**
```bash
# Test Caddy auth
curl -v https://auth.hyperset.internal

# Test Superset header auth
curl -H "X-Webauth-User: admin" http://localhost:8088/api/v1/me/

# Test MCP auth
curl -H "Authorization: Bearer $(node -e "console.log(require('./portal-app/src/lib/mcp-auth').createMcpToken('admin', 'admin@example.com', ['hyperset/admin']))")" http://localhost:8000/mcp
```

---

## 📚 Technical Reference

### API Endpoints

**Portal API:**
- `GET /api/config` - Configuration
- `POST /api/chat` - Chat completion (streaming)
- `GET/PATCH/POST/DELETE /api/admin` - Admin settings

**Pages Service:**
- `GET /__pages__` - List discovered pages
- `GET /{page_name}` - Serve page HTML
- `GET /{page_name}/api/*` - Page backend routes

**MCP Server:**
- `POST /mcp` - MCP protocol endpoint
- Supports `tools/list` and `tools/call` methods

### Environment Variables

**Core:**
- `HYPERSET_DOMAIN` - Base domain
- `AUTH_CRYPTO_KEY` - Auth encryption (32-byte hex)
- `SESSION_SECRET` - Session encryption (32+ char base64)

**Superset:**
- `SUPERSET_UPSTREAM` - Superset instance URL
- `SUPERSET_MCP_USER` - Service account username
- `SUPERSET_MCP_PASSWORD` - Service account password (optional)

**LLM:**
- `LLM_API_URL` - API base URL
- `LLM_API_KEY` - API key
- `LLM_MODEL` - Default model

### Security Headers

Caddy injects these headers into Superset:
- `X-Webauth-User` - Username (email)
- `X-Webauth-Email` - Email address
- `X-Webauth-Groups` - Space-separated roles

Superset configuration required:
```python
AUTH_TYPE = AUTH_REMOTE_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"
```

---

## 🎯 Project Philosophy

**Self-hosted first:** No cloud lock-in, no telemetry, no external dependencies

**Container-native:** Everything runs in Podman/Docker with minimal host requirements

**Extensible:** Add features without modifying shared code (drop-in pages, custom backends)

**Secure by default:** Header-based auth, internal networking, TLS everywhere

**Developer-friendly:** Hot-reload for pages, clear logs, TypeScript throughout

---

## 📞 Support & Community

**Issues:** Report bugs and feature requests on GitHub

**Contributing:** Pull requests welcome! Focus on:
- Bug fixes
- Documentation improvements
- New page examples
- MCP tool enhancements

**License:** MIT

---

*Built with ❤️ for data teams who value privacy and control*