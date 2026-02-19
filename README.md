# Hyperset

A self-hosted analytics portal that brings your tools together under one roof — one domain, one login, one clean interface.

It runs entirely in containers (Podman), requires no cloud services, and is designed to be extended without touching any shared code.

---

## What's inside

| Component | Role |
|-----------|------|
| **Caddy** | Reverse proxy + authentication gateway. Handles HTTPS, login, and routes traffic to the right service. |
| **Portal** | The main page you land on. A resizable multi-panel layout where each tool opens as a side panel. |
| **Superset** | Data exploration and dashboarding — shown as the main panel. Runs anywhere; Caddy proxies to it and injects auth headers. |
| **Open-WebUI** | AI chat interface, reachable as a panel inside the portal. |
| **Pages service** | A lightweight FastAPI server that auto-discovers custom pages you drop into the `Pages/` folder. |

---

## Architecture overview

```
Browser
  └─► Caddy (HTTPS + auth)
        ├─► hyperset.{domain}          → Portal (static HTML)
        ├─► superset.{domain}          → Superset (anywhere — same network or external)
        ├─► openwebui.{domain}         → Open-WebUI container
        ├─► pages.{domain}             → Pages service (FastAPI)
        └─► auth.{domain}              → Login portal
```

Everything sits on an internal Podman network (`hyperset-net`). Caddy is the only container that exposes ports to the outside world. Superset can live on the same machine, on a different server, or anywhere reachable by Caddy.

---

## Getting started

### Prerequisites

- A fresh **Debian 12+** machine (physical, VM, or LXC)
- `git` installed
- Ports **80** and **443** open on your firewall
- A domain name or a local hostname (e.g. `hyperset.internal` works fine on a home network)

### 1. Clone and configure

```bash
git clone https://github.com/CheezeLover/Hyperset.git
cd Hyperset
```

Edit `.env` — the only line you *must* change is `HYPERSET_DOMAIN`:

```env
HYPERSET_DOMAIN=hyperset.internal           # ← your domain or hostname here
SUPERSET_UPSTREAM=http://my-server:8088     # ← how Caddy reaches your Superset instance
AUTH_CRYPTO_KEY=<generate with: openssl rand -hex 32>
WEBUI_SECRET_KEY=<generate with: openssl rand -hex 32>
```

> **Tip:** Run `openssl rand -hex 32` twice to generate fresh values for the two secret keys. Never reuse the placeholder values.

### 2. Add DNS / hosts entries

On every machine that will access the portal, add these lines to the hosts file — all pointing to the same server IP:

**Windows** → `C:\Windows\System32\drivers\etc\hosts` (open as Administrator)
**Linux/Mac** → `/etc/hosts`

```
<server-ip>  hyperset.internal
<server-ip>  auth.hyperset.internal
<server-ip>  openwebui.hyperset.internal
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

Go to `https://{HYPERSET_DOMAIN}` — you'll be redirected to login, then land on the portal. The **Chat** button in the sidebar opens Open-WebUI. Any custom pages you've added appear below it.

---

## Connecting Superset

Hyperset proxies `superset.{HYPERSET_DOMAIN}` to your existing Superset instance and injects the logged-in user's identity as HTTP headers. Superset reads those headers to log the user in automatically — no separate login required.

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

# Trust the header injected by Caddy
AUTH_TYPE = AUTH_REMOTE_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"

# Auto-register users on first login
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Gamma"   # default role for new users

# Optional: map Hyperset admin role to Superset Admin
AUTH_ROLES_MAPPING = {
    "hyperset/admin": ["Admin"],
    "hyperset/user":  ["Gamma"],
}
AUTH_ROLES_SYNC_AT_LOGIN = True
```

> **Note:** `AUTH_REMOTE_USER` trusts whoever sets the header, so it is only safe when Superset is **not** directly reachable from the internet — it must only accept connections from Caddy. Bind Superset to `127.0.0.1` or an internal network interface, or use a firewall rule to block external access to its port.

### Restart Superset

After updating `superset_config.py`, restart Superset:

```bash
# If running with docker-compose / podman-compose
podman-compose restart superset

# If running standalone
superset run  # or however you start it
```

From that point on, any user authenticated by Hyperset will be logged into Superset automatically when they open the main panel.

---

## Adding custom pages

This is where things get fun. You never need to touch any shared config — just drop folders into `Pages/`.

### Static page (docs, dashboards, embeds…)

```
Pages/
  my-docs/
    index.html
```

Within 10 seconds a **"My-docs"** button appears in the portal sidebar. Click it to open your page as a resizable panel alongside everything else.

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

Your backend is automatically mounted at `https://pages.{domain}/my-tool/api/`. Call it from your `index.html` using a relative path:

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
├── .env                  # Your secrets and domain config (never commit real values)
├── podman-compose.yml    # All services defined here
├── setup_podman.sh       # One-shot setup script
│
├── Caddy/
│   ├── Caddyfile         # Routing + auth rules
│   ├── Dockerfile        # Caddy + caddy-security plugin
│   └── users.json        # Local user database
│
├── Portal/
│   └── index.html        # The main portal UI
│
├── Pages/                # ← drop your custom pages here
│   ├── docs/             # Example: static documentation page
│   │   └── index.html
│   └── hello/            # Example: page with a FastAPI backend
│       ├── index.html
│       └── backend.py
│
├── Pages-Service/        # The auto-discovery FastAPI service (don't touch this)
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
│
└── Open-WebUI/
    └── Tools/            # Custom tools available in the AI chat
```

---

## Useful commands

```bash
# Start everything
podman-compose up -d

# View live logs for all services
podman-compose logs -f

# View logs for a specific service
podman logs hyperset-pages -f
podman logs hyperset-caddy -f

# Restart a single service after a config change
podman-compose restart caddy

# Rebuild and restart the pages service (after updating Pages-Service/main.py)
podman rm -f hyperset-pages && podman-compose up --build -d pages

# Stop everything
podman-compose down
```

---

## Troubleshooting

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
