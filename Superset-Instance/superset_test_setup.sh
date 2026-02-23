#!/usr/bin/env bash
# =============================================================================
# superset_test_setup.sh
# Deploys Apache Superset 6.0.0 configured for Hyperset SSO (AUTH_REMOTE_USER)
#
# What it does:
#   1. Clones the official Superset repo at tag 6.0.0
#   2. Copies superset_config_docker.py from the same directory as this script
#   3. Patches superset_config.py to surface import errors (not swallow them)
#   4. Writes a .env-local with sane defaults (override before running in prod)
#   5. Starts the stack with docker compose or podman-compose
#   6. Waits for Superset to become healthy and verifies auth
#
# Expected files in the same directory as this script:
#   superset_config_docker.py  — Hyperset SSO configuration
#   superset_config.py         — (optional) full override of the base config
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
# Resolve the directory where this script lives (for finding config files)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Configurable defaults (all can be overridden via env vars before running)
# ---------------------------------------------------------------------------
SUPERSET_VERSION="${SUPERSET_VERSION:-6.0.0}"
SUPERSET_DIR="${SUPERSET_DIR:-./superset}"
SUPERSET_PORT="${SUPERSET_PORT:-8088}"
SUPERSET_SECRET_KEY="${SUPERSET_SECRET_KEY:-$(openssl rand -hex 32)}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo -e "\033[0;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[0;32m[OK]\033[0m    $*"; }
warn()    { echo -e "\033[0;33m[WARN]\033[0m  $*"; }
error()   { echo -e "\033[0;31m[ERR]\033[0m   $*" >&2; exit 1; }

has_cmd() { command -v "$1" &>/dev/null; }

# ---------------------------------------------------------------------------
# Validate required config files exist alongside this script
# ---------------------------------------------------------------------------
if [[ ! -f "$SCRIPT_DIR/superset_config_docker.py" ]]; then
    error "Missing required file: $SCRIPT_DIR/superset_config_docker.py
       Place superset_config_docker.py in the same directory as this script."
fi
success "Found superset_config_docker.py"

if [[ -f "$SCRIPT_DIR/superset_config.py" ]]; then
    success "Found superset_config.py (will use as full override)"
    HAS_BASE_CONFIG=true
else
    info "No superset_config.py found — will patch the stock one"
    HAS_BASE_CONFIG=false
fi

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
# 3. Copy config files from script directory
# ---------------------------------------------------------------------------
mkdir -p docker/pythonpath_dev

info "Copying superset_config_docker.py..."
cp "$SCRIPT_DIR/superset_config_docker.py" docker/pythonpath_dev/superset_config_docker.py
success "superset_config_docker.py copied"

if [[ "$HAS_BASE_CONFIG" == "true" ]]; then
    info "Copying superset_config.py (full override)..."
    cp "$SCRIPT_DIR/superset_config.py" docker/pythonpath_dev/superset_config.py
    success "superset_config.py copied"
else
    # ---------------------------------------------------------------------------
    # 3b. Patch stock superset_config.py to surface import errors
    #     The stock file uses except ImportError which silently swallows errors.
    #     We change it to except Exception so real issues are visible in logs.
    # ---------------------------------------------------------------------------
    info "Patching superset_config.py to surface import errors..."
    SUPERSET_CONFIG="docker/pythonpath_dev/superset_config.py"

    if grep -q "except ImportError:" "$SUPERSET_CONFIG" 2>/dev/null; then
        sed -i 's/except ImportError:/except Exception as e:/' "$SUPERSET_CONFIG"
        sed -i 's/logger.info("Using default Docker config...")/logger.error(f"Failed to load superset_config_docker: {type(e).__name__}: {e}")\n    import traceback\n    traceback.print_exc()/' "$SUPERSET_CONFIG"
        success "superset_config.py patched for better error logging"
    else
        warn "superset_config.py already patched or has unexpected format — skipping"
    fi
fi

# ---------------------------------------------------------------------------
# 3c. Ensure Podman can resolve short image names (e.g. redis:7, postgres:16)
# ---------------------------------------------------------------------------
if has_cmd podman && [[ ! -f /etc/containers/registries.conf.d/docker.conf ]]; then
    info "Configuring Podman to use Docker Hub for short image names..."
    sudo mkdir -p /etc/containers/registries.conf.d
    echo 'unqualified-search-registries = ["docker.io"]' \
        | sudo tee /etc/containers/registries.conf.d/docker.conf > /dev/null
    success "Podman registry config written"
fi

# ---------------------------------------------------------------------------
# 4. Start the stack
#    podman-compose has issues with dependency ordering — it tries to start
#    all containers at once and fails when dependents can't find their deps.
#    Workaround: start infra first, wait, then start the rest.
# ---------------------------------------------------------------------------
COMPOSE_FILE="docker-compose-image-tag.yml"

info "Starting Superset with $COMPOSE_CMD (image tag: ${SUPERSET_VERSION})..."
info "This pulls images and may take a few minutes on the first run."

if [[ "$COMPOSE_CMD" == *"podman"* ]]; then
    # Podman-compose: start in stages to avoid dependency graph errors
    info "Using staged startup for podman-compose..."

    # Stage 1: infra (redis + postgres)
    info "Stage 1/3: Starting redis and postgres..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d db cache 2>/dev/null || \
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d superset_db superset_cache 2>/dev/null || true
    sleep 10
    success "Infra services started"

    # Stage 2: init (runs migrations, creates default roles/perms)
    info "Stage 2/3: Running Superset init..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d init 2>/dev/null || \
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d superset_init 2>/dev/null || true

    # Wait for init to finish
    RETRIES=30
    info "Waiting for init to complete..."
    while true; do
        # Check if init container exited (it's a one-shot)
        INIT_STATUS=$($COMPOSE_CMD -f "$COMPOSE_FILE" ps 2>/dev/null | grep -i init | grep -ci "exit\|exited\|done" || true)
        if [[ "$INIT_STATUS" -ge 1 ]]; then
            break
        fi
        RETRIES=$((RETRIES - 1))
        if [[ $RETRIES -le 0 ]]; then
            warn "Init may not have completed — continuing anyway"
            break
        fi
        echo -n "."
        sleep 5
    done
    echo ""
    success "Init completed"

    # Stage 3: app + workers
    info "Stage 3/3: Starting Superset app and workers..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    success "All services started"
else
    # Docker compose handles dependency ordering correctly
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    success "Docker Compose stack started"
fi

# ---------------------------------------------------------------------------
# 5. Wait for Superset to become healthy
# ---------------------------------------------------------------------------
info "Waiting for Superset to become healthy on port ${SUPERSET_PORT}..."
RETRIES=40
until curl -sf "http://localhost:${SUPERSET_PORT}/health" > /dev/null 2>&1; do
    RETRIES=$((RETRIES - 1))
    if [[ $RETRIES -le 0 ]]; then
        error "Superset did not become healthy in time. Check: $COMPOSE_CMD -f $COMPOSE_FILE logs"
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
    warn "Check logs: $COMPOSE_CMD -f $COMPOSE_FILE logs superset"
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

  Users are created automatically on first login via AUTH_REMOTE_USER.
  Roles are assigned from the X-Webauth-Groups header at creation time
  only — after that, manage roles in Superset.

  Verify auth is working:
    curl -H "X-Webauth-User: admin" http://localhost:${SUPERSET_PORT}/login/
    (should return 302 redirect, not 200)

  Next steps:
  1. Make sure Superset is NOT directly reachable from the internet —
     only Caddy/Hyperset should reach port ${SUPERSET_PORT}.
  2. Set HYPERSET_ORIGIN in docker/.env-local to your actual portal URL
     (e.g. https://hyperset.internal) before going to production.
  3. To stop:    $COMPOSE_CMD -f $COMPOSE_FILE down
  4. To view logs: $COMPOSE_CMD -f $COMPOSE_FILE logs -f

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF