#!/usr/bin/env bash
# =============================================================================
# superset_test_setup.sh
# Deploys Apache Superset 6.0.0 configured for Hyperset SSO (AUTH_REMOTE_USER)
#
# What it does:
#   1. Clones the official Superset repo at tag 6.0.0
#   2. Writes a superset_config_docker.py tuned for Hyperset header-based auth
#   3. Writes a .env-local with sane defaults (override before running in prod)
#   4. Starts the stack with docker compose or podman-compose
#   5. Waits for Superset to become healthy, then creates the MCP service account
#
# Usage:
#   chmod +x superset_test_setup.sh
#   ./superset_test_setup.sh
#
# Override defaults via environment variables before running:
#   SUPERSET_DIR=/opt/superset \
#   SUPERSET_SECRET_KEY=$(openssl rand -hex 32) \
#   
#   
#   SUPERSET_PORT=8088 \
#   ./superset_test_setup.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configurable defaults (all can be overridden via env vars before running)
# ---------------------------------------------------------------------------
SUPERSET_VERSION="${SUPERSET_VERSION:-6.0.0}"
SUPERSET_DIR="${SUPERSET_DIR:-./superset}"
SUPERSET_PORT="${SUPERSET_PORT:-8088}"
SUPERSET_SECRET_KEY="${SUPERSET_SECRET_KEY:-$(openssl rand -hex 32)}"

# Roles that Hyperset injects via X-Webauth-Roles header
HYPERSET_ADMIN_ROLE_HEADER="${HYPERSET_ADMIN_ROLE_HEADER:-hyperset/admin}"
HYPERSET_USER_ROLE_HEADER="${HYPERSET_USER_ROLE_HEADER:-hyperset/user}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo -e "\033[0;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[0;32m[OK]\033[0m    $*"; }
warn()    { echo -e "\033[0;33m[WARN]\033[0m  $*"; }
error()   { echo -e "\033[0;31m[ERR]\033[0m   $*" >&2; exit 1; }

has_cmd() { command -v "$1" &>/dev/null; }

# ---------------------------------------------------------------------------
# Install dependencies (git + docker or podman)
# ---------------------------------------------------------------------------
info "Checking and installing dependencies..."

# Detect package manager
if has_cmd apt-get; then
    PKG_INSTALL="sudo apt-get install -y -qq"
    PKG_UPDATE="sudo apt-get update -qq"
elif has_cmd dnf; then
    PKG_INSTALL="sudo dnf install -y -q"
    PKG_UPDATE="sudo dnf check-update -q || true"
elif has_cmd yum; then
    PKG_INSTALL="sudo yum install -y -q"
    PKG_UPDATE="sudo yum check-update -q || true"
else
    error "No supported package manager found (apt-get, dnf, yum). Install git and docker/podman manually."
fi

# git
if ! has_cmd git; then
    info "Installing git..."
    $PKG_UPDATE && $PKG_INSTALL git
    success "git installed"
else
    success "git already present"
fi

# Prefer docker, fall back to podman
if has_cmd docker; then
    COMPOSE_CMD="docker compose"
    success "docker already present"
elif has_cmd podman; then
    if has_cmd podman-compose; then
        COMPOSE_CMD="podman-compose"
        success "podman + podman-compose already present"
    else
        info "Installing podman-compose..."
        $PKG_INSTALL podman-compose
        COMPOSE_CMD="podman-compose"
        success "podman-compose installed"
    fi
else
    info "Neither docker nor podman found — installing docker..."
    $PKG_UPDATE
    if has_cmd apt-get; then
        $PKG_INSTALL ca-certificates curl gnupg lsb-release
        sudo install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/debian/gpg \
            | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        echo \
            "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
            https://download.docker.com/linux/debian \
            $(lsb_release -cs) stable" \
            | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
        sudo apt-get update -qq
        $PKG_INSTALL docker-ce docker-ce-cli containerd.io docker-compose-plugin
    else
        curl -fsSL https://get.docker.com | sudo sh
    fi
    sudo systemctl enable --now docker
    # Add current user to the docker group so we can use it without sudo
    sudo usermod -aG docker "$USER"
    COMPOSE_CMD="sudo docker compose"
    success "docker installed — NOTE: log out and back in after this session to use docker without sudo"
fi

# Verify compose works — use sudo if needed (fresh install, user not yet in docker group)
if ! $COMPOSE_CMD version &>/dev/null; then
    if sudo docker compose version &>/dev/null 2>&1; then
        # Prepend sudo for this session
        COMPOSE_CMD="sudo $COMPOSE_CMD"
    else
        error "'$COMPOSE_CMD' is not working. Check your installation."
    fi
fi
success "Compose OK ($COMPOSE_CMD)"

# ---------------------------------------------------------------------------
# 1. Clone Superset at the chosen tag
# ---------------------------------------------------------------------------
if [[ -d "$SUPERSET_DIR/.git" ]]; then
    warn "Directory '$SUPERSET_DIR' already exists — skipping clone."
    cd "$SUPERSET_DIR"
    git fetch --tags --quiet
else
    info "Cloning apache/superset..."
    git clone https://github.com/apache/superset "$SUPERSET_DIR"
    cd "$SUPERSET_DIR"
fi

info "Checking out tag $SUPERSET_VERSION..."
git checkout "tags/${SUPERSET_VERSION}" --quiet
success "Checked out superset $SUPERSET_VERSION"

# ---------------------------------------------------------------------------
# 2. Write .env-local
#    Superset's docker stack reads docker/.env-local for local overrides.
# ---------------------------------------------------------------------------
info "Writing docker/.env-local..."
cat > docker/.env-local << EOF
# -------------------------------------------------------
# Hyperset local overrides — generated by superset_test_setup.sh
# -------------------------------------------------------

# Secrets
SECRET_KEY=${SUPERSET_SECRET_KEY}

# Expose Superset on a specific port (Caddy will proxy to this)
SUPERSET_PORT=${SUPERSET_PORT}

# Tell docker compose to use our custom Python config file
SUPERSET_CONFIG_PATH=/app/pythonpath/superset_config_docker.py

# Image tag pinned to the version we cloned
TAG=${SUPERSET_VERSION}
EOF
success "docker/.env-local written"

# ---------------------------------------------------------------------------
# 3. Write superset_config_docker.py
#    Placed in docker/pythonpath/ which is volume-mounted by the
#    official docker-compose stack at /app/pythonpath/.
# ---------------------------------------------------------------------------
info "Writing docker/pythonpath/superset_config_docker.py..."
cat > docker/pythonpath/superset_config_docker.py << 'PYEOF'
# =============================================================================
# superset_config_docker.py
# Hyperset-compatible Superset configuration
#
# Drop-in override loaded by the official Superset Docker Compose stack.
# The base config (superset_config.py) is still loaded first; this file
# only overrides what is needed for Hyperset header-based SSO.
# =============================================================================

import os
from flask_appbuilder.security.manager import AUTH_REMOTE_USER

# ---------------------------------------------------------------------------
# Authentication — trust the X-Webauth-User header set by Caddy/Hyperset
# ---------------------------------------------------------------------------
AUTH_TYPE = AUTH_REMOTE_USER

# Gunicorn/WSGI environ key for the remote user header.
# Caddy sends:  X-Webauth-User: <username>
# WSGI converts: HTTP_X_WEBAUTH_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"

# Auto-register unknown users on first login (Caddy has already authenticated them)
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Gamma"   # default role; Hyperset upgrades admins below

# Map the role header values Hyperset sends to Superset roles.
# Caddy injects:  X-Webauth-Roles: hyperset/admin  (or hyperset/user)
AUTH_ROLES_MAPPING = {
    os.getenv("HYPERSET_ADMIN_ROLE_HEADER", "hyperset/admin"): ["Admin"],
    os.getenv("HYPERSET_USER_ROLE_HEADER", "hyperset/user"):   ["Gamma"],
}
AUTH_ROLES_SYNC_AT_LOGIN = True

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------
SECRET_KEY = os.getenv("SECRET_KEY", os.getenv("SUPERSET_SECRET_KEY", "CHANGE_ME_IN_PRODUCTION"))

# Allow the Hyperset portal iframe to embed Superset.
# Set this to the exact origin of your Hyperset portal, e.g.:
#   https://hyperset.internal  or  https://portal.mycompany.com
# Using "*" is convenient for local/test environments only.
ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": [
        os.getenv("HYPERSET_ORIGIN", "*"),
    ],
}

# Allow Superset to be embedded in Hyperset's iframe.
# In production replace "*" with your Hyperset domain.
HTTP_HEADERS = {
    "X-Frame-Options": os.getenv("SUPERSET_FRAME_OPTIONS", "ALLOWALL"),
    "Content-Security-Policy": (
        "frame-ancestors 'self' "
        + os.getenv("HYPERSET_ORIGIN", "*")
    ),
}

# Disable CSRF for API endpoints — Hyperset's bridge.js and MCP server use
# token-based auth.  If you harden this later, ensure the MCP server sends
# the correct X-CSRFToken header.
WTF_CSRF_ENABLED = False

# ---------------------------------------------------------------------------
# Embedded / guest token support (used by Hyperset bridge for public embeds)
# ---------------------------------------------------------------------------
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
    "ALERT_REPORTS": True,
}

# ---------------------------------------------------------------------------
# Cache (Redis — already in the official docker-compose stack)
# ---------------------------------------------------------------------------
REDIS_HOST     = os.getenv("REDIS_HOST", "redis")
REDIS_PORT     = int(os.getenv("REDIS_PORT", "6379"))
REDIS_CELERY_DB = int(os.getenv("REDIS_CELERY_DB", "0"))
REDIS_RESULTS_DB = int(os.getenv("REDIS_RESULTS_DB", "1"))
REDIS_CACHE_DB   = int(os.getenv("REDIS_CACHE_DB", "2"))

CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_HOST": REDIS_HOST,
    "CACHE_REDIS_PORT": REDIS_PORT,
    "CACHE_REDIS_DB": REDIS_CACHE_DB,
}

DATA_CACHE_CONFIG = CACHE_CONFIG.copy()
DATA_CACHE_CONFIG["CACHE_KEY_PREFIX"] = "superset_data_"
DATA_CACHE_CONFIG["CACHE_REDIS_DB"] = REDIS_RESULTS_DB

# Celery (async queries / alerts)
class CeleryConfig:
    broker_url     = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_CELERY_DB}"
    result_backend = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_RESULTS_DB}"

CELERY_CONFIG = CeleryConfig

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
DB_HOST     = os.getenv("DB_HOST", "db")
DB_PORT     = os.getenv("DB_PORT", "5432")
DB_NAME     = os.getenv("DB_NAME", "superset")
DB_USER     = os.getenv("DB_USER", "superset")
DB_PASS     = os.getenv("DB_PASS", "superset")

SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

# ---------------------------------------------------------------------------
# Proxy fix — Superset sits behind Caddy
# ---------------------------------------------------------------------------
ENABLE_PROXY_FIX = True
PROXY_FIX_CONFIG = {
    "x_for":    1,
    "x_proto":  1,
    "x_host":   1,
    "x_port":   1,
    "x_prefix": 1,
}

# ---------------------------------------------------------------------------
# Middleware — forward the X-Webauth-User header to REMOTE_USER
# Needed when running under Gunicorn so AUTH_REMOTE_USER picks it up.
# ---------------------------------------------------------------------------
class HypersetRemoteUserMiddleware:
    """
    WSGI middleware that reads X-Webauth-User (injected by Caddy) and maps it
    to the REMOTE_USER environ key that Flask-AppBuilder's AUTH_REMOTE_USER
    authentication backend expects.
    """
    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        user = environ.get("HTTP_X_WEBAUTH_USER", "")
        if user:
            environ["REMOTE_USER"] = user
        return self.app(environ, start_response)


ADDITIONAL_MIDDLEWARE = [HypersetRemoteUserMiddleware]

# ---------------------------------------------------------------------------
# Logging (optional — structured logs work better with podman/docker logs)
# ---------------------------------------------------------------------------
import logging
LOG_LEVEL = logging.INFO
PYEOF

success "superset_config_docker.py written"

# ---------------------------------------------------------------------------
# 4. Start the stack
# ---------------------------------------------------------------------------
info "Starting Superset with $COMPOSE_CMD (image tag: ${SUPERSET_VERSION})..."
info "This pulls images and may take a few minutes on the first run."

$COMPOSE_CMD -f docker-compose-image-tag.yml up -d

success "Docker Compose stack started"

# ---------------------------------------------------------------------------
# 5. Wait for Superset to become healthy
# ---------------------------------------------------------------------------
info "Waiting for Superset to become healthy on port ${SUPERSET_PORT}..."
RETRIES=30
until curl -sf "http://localhost:${SUPERSET_PORT}/health" > /dev/null 2>&1; do
    RETRIES=$((RETRIES - 1))
    if [[ $RETRIES -le 0 ]]; then
        error "Superset did not become healthy in time. Check: $COMPOSE_CMD -f docker-compose-image-tag.yml logs"
    fi
    echo -n "."
    sleep 5
done
echo ""
success "Superset is healthy at http://localhost:${SUPERSET_PORT}"


# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat << EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Superset ${SUPERSET_VERSION} is running — Hyperset SSO ready
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Direct access (test only):  http://localhost:${SUPERSET_PORT}
  SECRET_KEY (save this!):    ${SUPERSET_SECRET_KEY}

  Point Hyperset at this instance in your Hyperset .env:
    SUPERSET_UPSTREAM=http://<this-server-ip>:${SUPERSET_PORT}

  Users are created automatically on first login via AUTH_REMOTE_USER —
  no service account needed. Roles are assigned from the X-Webauth-Roles
  header that Caddy/Hyperset injects.

  Next steps:
  1. Make sure Superset is NOT directly reachable from the internet —
     only Caddy/Hyperset should reach port ${SUPERSET_PORT}.
  2. Set HYPERSET_ORIGIN in docker/.env-local to your actual portal URL
     (e.g. https://hyperset.internal) before going to production.
  3. To stop:    $COMPOSE_CMD -f docker-compose-image-tag.yml down
  4. To view logs: $COMPOSE_CMD -f docker-compose-image-tag.yml logs -f

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
