# Hyperset

A self-hosted analytics portal that brings your tools together under one roof — one domain, one login, one clean interface.

It runs entirely in containers (Podman), requires no cloud services, and is designed to be extended without touching any shared code.

---

## What's inside

| Component | Role |
|-----------|------|
| **Caddy** | Reverse proxy + authentication gateway. Handles HTTPS, login, and routes traffic to the right service. |
| **Portal** | The main page you land on. A Next.js app with a resizable multi-panel layout, built-in AI chat, and dynamic side panels for custom pages. |
| **Superset** | Data exploration and dashboarding — shown as the main panel. Runs anywhere; Caddy proxies to it, injects auth headers, and injects the Hyperset bridge script. |
| **Superset MCP** | A Model Context Protocol server that gives the AI chat programmatic access to Superset — query SQL, create/list dashboards and charts, explore datasets. |
| **Pages service** | A lightweight FastAPI server that auto-discovers custom pages you drop into the `Pages/` folder. |

---

## Architecture overview

```
Browser
  └─► Caddy (HTTPS + auth)
        ├─► hyperset.{domain}      → Portal (Next.js — chat + layout)
        ├─► superset.{domain}      → Superset + bridge.js injection
        ├─► pages.{domain}         → Pages service (FastAPI)
        └─► auth.{domain}          → Login portal

Portal (server-side)
  └─► Superset MCP (port 8000)    → Superset API (SQL, dashboards, charts…)

Superset iframe
  └─► bridge.js (injected by Caddy)
        ├─► Right-click chart → sends context to chat panel
        └─► Receives navigate commands from chat → routes within Superset
```

Everything sits on an internal Podman network (`hyperset-net`). Caddy is the only container that exposes ports to the outside world. Superset can live on the same machine, on a different server, or anywhere reachable by Caddy.

---

## Key features

### AI chat that controls Superset
The built-in chat panel (powered by [CopilotKit](https://copilotkit.ai)) has access to the full Superset API via MCP. You can ask it to:
- List, create, or modify dashboards and charts
- Run SQL queries against any connected database
- Navigate the Superset panel directly ("open dashboard Sales Overview")

Tool calls are shown as collapsible steps in the chat so you always see what's happening.

### Right-click → Inspect in chatbot
A lightweight bridge script is injected into the Superset iframe by Caddy. Right-clicking any chart gives you an **"Inspect in chatbot"** option that sends the chart title and datasource directly into the chat panel.

### Role-based LLM routing
Two LLM configurations can be set independently via environment variables — one for regular users, one for admins. Admins also get a runtime settings modal (gear icon in the chat header) to override the API URL, key, and model for their session without restarting anything.

### Drop-in custom pages
Drop a folder into `Pages/` and a button for it appears in the sidebar within seconds — no config changes required. Pages can be static HTML or include a FastAPI backend.

---

## Getting started

### Prerequisites

- A fresh **Debian 12+** machine (physical, VM, or LXC)
- `git` installed
- Ports **80** and **443** open on your firewall
- A domain name or a local hostname (e.g. `hyperset.internal` works fine on a home network)
- An OpenAI-compatible LLM API endpoint and key (for the chat)

### 1. Clone and configure

```bash
git clone https://github.com/CheezeLover/Hyperset.git
cd Hyperset
```

Edit `.env` — at minimum, set your domain, Superset address, secret keys, and LLM API details:

```env
# Domain
HYPERSET_DOMAIN=hyperset.internal

# Where Caddy can reach your Superset instance
SUPERSET_UPSTREAM=http://my-server:8088

# Auth key — generate with: openssl rand -hex 32
AUTH_CRYPTO_KEY=<32-byte hex>

# Session encryption for admin settings — generate with: openssl rand -base64 32
SESSION_SECRET=<min 32 chars>

# LLM for regular users
CHAT_API_URL=https://api.openai.com/v1
CHAT_API_KEY=sk-...
CHAT_MODEL=gpt-4o

# LLM for admins (can differ from the user one)
ADMIN_API_URL=https://api.openai.com/v1
ADMIN_API_KEY=sk-...
ADMIN_MODEL=gpt-4o

# Superset MCP service account (must be a Superset admin username)
SUPERSET_MCP_USER=admin
```

> **Tip:** Run `openssl rand -hex 32` to generate `AUTH_CRYPTO_KEY` and `openssl rand -base64 32` for `SESSION_SECRET`. Never reuse placeholder values.

### 2. Add DNS / hosts entries

On every machine that will access the portal, add these lines to the hosts file — all pointing to the same server IP:

**Windows** → `C:\Windows\System32\drivers\etc\hosts` (open as Administrator)
**Linux/Mac** → `/etc/hosts`

```
<server-ip>  hyperset.internal
<server-ip>  auth.hyperset.internal
<server-ip>  superset.hyperset.internal
<server-ip>  pages.hyperset.internal
```

Replace `hyperset.internal` with whatever you set as `HYPERSET_DOMAIN`.

### 3. Run the setup script

```bash
chmod +x setup_podman.sh
./setup_podman.sh
```

This installs Podman, creates the internal network, builds all images, and starts every service.

### 4. Create your first user

Navigate to `https://auth.{HYPERSET_DOMAIN}` and register an account. The first account automatically gets admin rights.

### 5. Open the portal

Go to `https://{HYPERSET_DOMAIN}` — you'll be redirected to login, then land on the portal. The **Chat** button in the sidebar opens the AI assistant. Any custom pages you've added appear below it.

---

## Connecting Superset

Hyperset proxies `superset.{HYPERSET_DOMAIN}` to your existing Superset instance, injects the logged-in user's identity as HTTP headers, and injects the bridge script into every Superset page.

### Where Superset runs

Set `SUPERSET_UPSTREAM` in `.env` to whatever address **Caddy** can reach:

| Scenario | Example value |
|----------|---------------|
| Same Podman network | `http://hyperset-superset:8088` |
| Different machine on the same LAN | `http://192.168.1.50:8088` |
| External HTTPS server | `https://superset.mycompany.com` |

### Configuring Superset for header-based auth

Superset needs to be told to trust the `X-Webauth-User` header that Caddy injects. Add (or merge) the following into your Superset `superset_config.py`:

```python
from flask_appbuilder.security.manager import AUTH_REMOTE_USER

AUTH_TYPE = AUTH_REMOTE_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"

AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Gamma"   # default role for new users

AUTH_ROLES_MAPPING = {
    "hyperset/admin": ["Admin"],
    "hyperset/user":  ["Gamma"],
}
AUTH_ROLES_SYNC_AT_LOGIN = True
```

> **Note:** `AUTH_REMOTE_USER` trusts whoever sets the header, so Superset must **not** be directly reachable from the internet — only from Caddy. Bind it to `127.0.0.1` or an internal interface, or use a firewall rule.

### Restart Superset

After updating `superset_config.py`, restart Superset:

```bash
podman-compose restart superset   # if on the same compose stack
```

From that point on, any user authenticated by Hyperset will be logged into Superset automatically when they open the main panel.

---

## AI chat and MCP

The chat panel calls the Superset MCP server on the backend to run queries, list and create dashboards/charts, and explore your data model.

### MCP service account

The MCP server authenticates to Superset using a service account. Set it in `.env`:

```env
SUPERSET_MCP_USER=admin        # a Superset admin username
SUPERSET_MCP_PASSWORD=         # leave empty if using AUTH_REMOTE_USER (recommended)
```

If Superset uses `AUTH_REMOTE_USER` (recommended), no password is needed — the MCP server sends the username in the same `X-Webauth-User` header that Caddy uses for browser sessions.

### Admin LLM override

Admins see a gear icon (⚙) in the chat panel header. Clicking it opens a settings modal where the API URL, key, and model can be changed at runtime. These overrides are stored in an encrypted session cookie and apply only to that session — they don't affect other users.

---

## Adding custom pages

Drop folders into `Pages/` and they appear in the portal sidebar within 10 seconds — no config changes, no restarts.

### Static page (docs, dashboards, embeds…)

```
Pages/
  my-docs/
    index.html
```

### Page with a Python backend

```
Pages/
  my-tool/
    index.html       ← your UI
    backend.py       ← your API
```

`backend.py` must expose a FastAPI `router` object:

```python
from fastapi import APIRouter

router = APIRouter()

@router.get("/hello")
async def hello():
    return {"message": "Hello from my-tool!"}
```

Your backend is automatically mounted at `https://pages.{domain}/my-tool/api/`. Call it from your `index.html`:

```javascript
const res = await fetch('/my-tool/api/hello');
const data = await res.json();
```

No restart needed. The file watcher picks up new pages and backend changes automatically.

### Removing a page

Delete the subfolder. It disappears from the registry immediately and vanishes from the portal sidebar within 10 seconds.

---

## Project structure

```
Hyperset/
├── .env                    # Your secrets and domain config (never commit real values)
├── podman-compose.yml      # All services defined here
├── setup_podman.sh         # One-shot setup script
│
├── Caddy/
│   ├── Caddyfile           # Routing, auth rules, bridge.js injection
│   ├── Dockerfile          # Caddy + caddy-security + replace-response plugins
│   ├── bridge.js           # Injected into Superset — enables chat↔Superset bridge
│   └── users.json          # Local user database
│
├── portal-app/             # Next.js portal app (chat + layout)
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx              # Main layout (server component)
│   │   │   ├── layout.tsx            # Root layout
│   │   │   └── api/
│   │   │       ├── chat/route.ts     # CopilotKit AG-UI endpoint
│   │   │       ├── config/route.ts   # Runtime config for client
│   │   │       └── admin/route.ts    # Admin LLM settings (session cookie)
│   │   ├── components/
│   │   │   ├── HypersetLayout.tsx    # Resizable multi-panel layout
│   │   │   ├── ChatPanel.tsx         # CopilotKit chat UI
│   │   │   ├── AdminModal.tsx        # Admin LLM settings modal
│   │   │   ├── ServiceColumn.tsx     # Icon strip sidebar
│   │   │   └── SupersetPanel.tsx     # Superset iframe wrapper
│   │   └── lib/
│   │       ├── mcp-client.ts         # Server-side Superset MCP client
│   │       ├── auth.ts               # Header-based user extraction
│   │       ├── session.ts            # iron-session config
│   │       └── superset-bridge.ts    # postMessage protocol types
│   └── Dockerfile
│
├── Pages/                  # ← drop your custom pages here
│   ├── docs/               # Example: static documentation page
│   │   └── index.html
│   └── hello/              # Example: page with a FastAPI backend
│       ├── index.html
│       └── backend.py
│
├── Pages-Service/          # Auto-discovery FastAPI service (don't touch this)
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
│
└── Superset-MCP/           # MCP server — gives the AI access to Superset
    ├── main.py
    ├── pyproject.toml
    └── Dockerfile
```

---

## Useful commands

```bash
# Start everything
podman-compose up -d

# View live logs for all services
podman-compose logs -f

# View logs for a specific service
podman logs hyperset-portal -f
podman logs hyperset-caddy -f
podman logs hyperset-superset-mcp -f

# Restart a single service after a config change
podman-compose restart caddy
podman-compose restart portal

# Rebuild and restart the portal (after updating portal-app/)
podman rm -f hyperset-portal && podman-compose up --build -d portal

# Rebuild and restart the pages service
podman rm -f hyperset-pages && podman-compose up --build -d pages

# Stop everything
podman-compose down
```

---

## Troubleshooting

**Chat panel shows no response / "placeholder" API key error**
- Set `CHAT_API_KEY` (and `ADMIN_API_KEY` for admins) in `.env` to a valid key for your LLM provider
- Check `CHAT_API_URL` matches your provider's base URL (e.g. `https://api.openai.com/v1`)

**Chat can't reach Superset (MCP errors)**
- Ensure `SUPERSET_MCP_USER` is a valid Superset admin username
- Check `podman logs hyperset-superset-mcp` for auth errors
- Verify `SUPERSET_UPSTREAM` is reachable from inside the `hyperset-net` network

**bridge.js not loading / right-click menu not appearing**
- Confirm the Caddy image was rebuilt after adding the `replace-response` module: `podman-compose up --build -d caddy`
- Open browser DevTools on the Superset page and look for `[Hyperset Bridge] Loaded` in the console
- Check that `Content-Security-Policy` isn't blocking inline scripts (Caddy should strip it)

**Page buttons don't appear in the portal**
- Check that `pages.{HYPERSET_DOMAIN}` is in your hosts file on the client machine
- Open browser DevTools (F12 → Console) and look for `[Hyperset]` warnings
- Run `podman logs hyperset-pages` to see which pages were discovered at startup

**Login loop / auth errors**
- Make sure `auth.{HYPERSET_DOMAIN}` resolves to the server IP
- Check that `AUTH_CRYPTO_KEY` is set and non-empty in `.env`

**TLS certificate warnings**
- Caddy issues internal self-signed certificates — expected on a local network. Accept the browser warning once, or add the Caddy root CA to your system trust store.

**Backend changes not picked up after renaming/removing routes**
- The file watcher reloads `backend.py` on modification, but FastAPI doesn't support removing old routes at runtime. Restart the pages container to get a clean slate:
  ```bash
  podman rm -f hyperset-pages && podman-compose up -d pages
  ```
