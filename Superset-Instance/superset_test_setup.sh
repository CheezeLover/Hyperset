#!/usr/bin/env bash
# =============================================================================
# superset_test_setup.sh
# Deploys Apache Superset 6.0.0 configured for Hyperset SSO (AUTH_REMOTE_USER)
#
# What it does:
#   1. Clones the official Superset repo at tag 6.0.0
#   2. Writes a superset_config_docker.py tuned for Hyperset header-based auth
#   3. Patches superset_config.py to surface import errors (not swallow them)
#   4. Writes a .env-local with sane defaults (override before running in prod)
#   5. Starts the stack with docker compose or podman-compose
#   6. Waits for Superset to become healthy
#
# Usage:
#   chmod +x superset_test_setup.sh
#   ./superset_test_setup.sh
#
# Override defaults via environment variables before running:
#   SUPERSET_DIR=/opt/superset \
#   SUPERSET_SECRET_KEY=$(openssl rand -hex 32) \
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
    sudo usermod -aG docker "$USER"
    COMPOSE_CMD="sudo docker compose"
    success "docker installed — NOTE: log out and back in after this session to use docker without sudo"
fi

# Verify compose works
if ! $COMPOSE_CMD version &>/dev/null; then
    if sudo docker compose version &>/dev/null 2>&1; then
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

# Image tag pinned to the version we cloned
TAG=${SUPERSET_VERSION}
EOF
success "docker/.env-local written"

# ---------------------------------------------------------------------------
# 3. Write superset_config_docker.py
# ---------------------------------------------------------------------------
info "Writing docker/pythonpath_dev/superset_config_docker.py..."
mkdir -p docker/pythonpath_dev
cat > docker/pythonpath_dev/superset_config_docker.py << 'PYEOF'
# =============================================================================
# superset_config_docker.py
# Hyperset-compatible Superset configuration
#
# Drop-in override loaded by the official Superset Docker Compose stack.
# The base config (superset_config.py) is still loaded first; this file
# only overrides what is needed for Hyperset header-based SSO.
#
# Includes workarounds for:
#   - https://github.com/apache/superset/issues/36117 (LocalProxy bug)
#   - Superset's SupersetAuthView shadowing FAB's authremoteuserview
#
# Strategy: instead of fighting view registration order, we use
# FLASK_APP_MUTATOR to install a before_request hook that auto-logs in
# the user from REMOTE_USER on every request — including /login/.
# =============================================================================

import os
import logging

from flask import redirect, request, g, session
from flask_appbuilder.security.manager import AUTH_REMOTE_USER
from flask_login import login_user, current_user
from superset.security import SupersetSecurityManager

# ---------------------------------------------------------------------------
# Authentication — trust the X-Webauth-User header set by Caddy/Hyperset
# ---------------------------------------------------------------------------
AUTH_TYPE = AUTH_REMOTE_USER

# Disable recaptcha (Superset 6.0 enables it by default)
RECAPTCHA_PUBLIC_KEY = ""
RECAPTCHA_PRIVATE_KEY = ""

REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"

AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Admin"

AUTH_ROLES_MAPPING = {
    os.getenv("HYPERSET_ADMIN_ROLE_HEADER", "hyperset/admin"): ["Admin"],
    os.getenv("HYPERSET_USER_ROLE_HEADER", "hyperset/user"):   ["Gamma"],
}
AUTH_ROLES_SYNC_AT_LOGIN = True

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------
SECRET_KEY = os.getenv("SECRET_KEY", os.getenv("SUPERSET_SECRET_KEY", "CHANGE_ME_IN_PRODUCTION"))

ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": [
        os.getenv("HYPERSET_ORIGIN", "*"),
    ],
}

HTTP_HEADERS = {
    "X-Frame-Options": os.getenv("SUPERSET_FRAME_OPTIONS", "ALLOWALL"),
    "Content-Security-Policy": (
        "frame-ancestors 'self' "
        + os.getenv("HYPERSET_ORIGIN", "*")
    ),
}

WTF_CSRF_ENABLED = False

# ---------------------------------------------------------------------------
# Embedded / guest token support
# ---------------------------------------------------------------------------
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
    "ALERT_REPORTS": True,
}

# ---------------------------------------------------------------------------
# Cache (Redis)
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
# Middleware — forward X-Webauth-User header to REMOTE_USER
# ---------------------------------------------------------------------------
class HypersetRemoteUserMiddleware:
    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        user = environ.get("HTTP_X_WEBAUTH_USER", "")
        if user:
            environ["REMOTE_USER"] = user
        return self.app(environ, start_response)

ADDITIONAL_MIDDLEWARE = [HypersetRemoteUserMiddleware]

# ---------------------------------------------------------------------------
# Custom Security Manager — patches auth_user_remote_user to avoid
# the LocalProxy bug in Superset 6.0 (issue #36117)
# ---------------------------------------------------------------------------
class HypersetSecurityManager(SupersetSecurityManager):

    def auth_user_remote_user(self, username):
        """
        Override that avoids passing g.user (a LocalProxy) to session.add().
        """
        user = self.find_user(username=username)

        if user is None and self.auth_user_registration:
            user = self.add_user(
                username=username,
                first_name=username,
                last_name="",
                email=f"{username}@hyperset.local",
                role=self.find_role(self.auth_user_registration_role),
            )

        if user:
            login_user(user)
            g.user = user
        return user

CUSTOM_SECURITY_MANAGER = HypersetSecurityManager

# ---------------------------------------------------------------------------
# FLASK_APP_MUTATOR — runs after the app is fully created, including all
# view registrations. Installs a before_request hook that:
#   1. Reads REMOTE_USER (set by the WSGI middleware above)
#   2. Logs the user in via our patched auth_user_remote_user
#   3. Redirects /login/ to the index if already authenticated
#
# This bypasses the SupersetAuthView vs AuthRemoteUserView conflict
# entirely — auth happens before any view runs.
# ---------------------------------------------------------------------------
def FLASK_APP_MUTATOR(app):

    @app.before_request
    def hyperset_auto_login():
        # Skip static files
        if request.path.startswith("/static"):
            return None

        remote_user = request.environ.get("REMOTE_USER", "")
        if not remote_user:
            return None

        # Already logged in as the correct user — nothing to do
        if current_user and current_user.is_authenticated:
            if current_user.username == remote_user:
                # If they're hitting /login/ while already authenticated, redirect
                if request.path.rstrip("/") == "/login":
                    return redirect("/superset/welcome/")
                return None

        # Log the user in
        sm = app.appbuilder.sm
        user = sm.auth_user_remote_user(remote_user)
        if user:
            login_user(user)
            g.user = user

            # Redirect away from login page
            if request.path.rstrip("/") == "/login":
                next_url = request.args.get("next", "/superset/welcome/")
                return redirect(next_url)

        return None

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_LEVEL = logging.INFO
PYEOF

success "superset_config_docker.py written"

# ---------------------------------------------------------------------------
# 3b. Patch superset_config.py to surface import errors
#     The stock file uses except ImportError which silently swallows errors.
#     We change it to except Exception so real issues are visible in logs.
# ---------------------------------------------------------------------------
info "Patching superset_config.py to surface import errors..."
SUPERSET_CONFIG="docker/pythonpath_dev/superset_config.py"

if grep -q "except ImportError:" "$SUPERSET_CONFIG" 2>/dev/null; then
    sed -i 's/except ImportError:/except Exception as e:/' "$SUPERSET_CONFIG"
    # Replace the generic "Using default Docker config..." message with error logging
    sed -i 's/logger.info("Using default Docker config...")/logger.error(f"Failed to load superset_config_docker: {type(e).__name__}: {e}")\n    import traceback\n    traceback.print_exc()/' "$SUPERSET_CONFIG"
    success "superset_config.py patched for better error logging"
else
    warn "superset_config.py already patched or has unexpected format — skipping"
fi

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
# 6. Verify AUTH_REMOTE_USER is working
# ---------------------------------------------------------------------------
info "Verifying header-based auth..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-Webauth-User: admin" \
    "http://localhost:${SUPERSET_PORT}/login/")

if [[ "$HTTP_CODE" == "302" ]]; then
    success "AUTH_REMOTE_USER is working — /login/ returns 302 redirect"
else
    warn "AUTH_REMOTE_USER check returned HTTP $HTTP_CODE (expected 302)"
    warn "Check logs: $COMPOSE_CMD -f docker-compose-image-tag.yml logs superset"
fi

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

  Verify auth is working:
    curl -H "X-Webauth-User: admin" http://localhost:${SUPERSET_PORT}/login/
    (should return 302 redirect, not 200)

  Next steps:
  1. Make sure Superset is NOT directly reachable from the internet —
     only Caddy/Hyperset should reach port ${SUPERSET_PORT}.
  2. Set HYPERSET_ORIGIN in docker/.env-local to your actual portal URL
     (e.g. https://hyperset.internal) before going to production.
  3. To stop:    $COMPOSE_CMD -f docker-compose-image-tag.yml down
  4. To view logs: $COMPOSE_CMD -f docker-compose-image-tag.yml logs -f

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
