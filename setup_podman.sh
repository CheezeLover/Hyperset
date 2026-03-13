#!/usr/bin/env bash
# Hyperset — one-shot setup script
# Run this once on a fresh Debian 12+ machine after cloning the repo.
set -euo pipefail

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ ERROR: .env file not found!"
    echo "   Copy .env.example to .env first: cp .env.example .env"
    exit 1
fi

# Load environment variables from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# ============================================================================
# Generate secure random secrets on first run (idempotent)
# ============================================================================
generate_secrets() {
  local env_file=".env"
  local secrets_changed=false
  
  # Helper function to update or add a secret in .env
  update_secret() {
    local key="$1"
    local value="$2"
    local old_value="$3"
    
    if grep -q "^${key}=" "$env_file"; then
      if grep -q "^${key}=CHANGE_ME" "$env_file" || grep -q "^${key}=${old_value}" "$env_file"; then
        # Recreate file line by line to handle special chars safely
        while IFS= read -r line || [ -n "$line" ]; do
          if [[ "$line" == "${key}="* ]]; then
            echo "${key}=${value}"
          else
            echo "$line"
          fi
        done < "$env_file" > "${env_file}.tmp" && mv "${env_file}.tmp" "$env_file"
        secrets_changed=true
      fi
    else
      echo "" >> "$env_file"
      echo "# Auto-generated on first run - do not change manually" >> "$env_file"
      echo "${key}=${value}" >> "$env_file"
      secrets_changed=true
    fi
  }

  # Generate AUTH_CRYPTO_KEY (32-byte hex) if not set or is placeholder
  if [ -z "${AUTH_CRYPTO_KEY:-}" ] || [ "$AUTH_CRYPTO_KEY" = "CHANGE_ME_run_openssl_rand_hex_32_and_paste_result_here_min_32_chars" ]; then
    local new_key
    new_key=$(openssl rand -hex 32)
    update_secret "AUTH_CRYPTO_KEY" "$new_key" "CHANGE_ME_run_openssl_rand_hex_32_and_paste_result_here_min_32_chars"
    echo "==> Generated AUTH_CRYPTO_KEY"
  fi

  # Generate SESSION_SECRET (base64) if not set or is placeholder
  if [ -z "${SESSION_SECRET:-}" ] || [ "$SESSION_SECRET" = "change-me-to-a-very-long-random-secret-key-min-32-chars" ]; then
    local new_secret
    new_secret=$(openssl rand -base64 32)
    update_secret "SESSION_SECRET" "$new_secret" "change-me-to-a-very-long-random-secret-key-min-32-chars"
    echo "==> Generated SESSION_SECRET"
  fi

  # Generate MCP_SERVICE_SECRET (32-byte hex) if not set or is placeholder
  if [ -z "${MCP_SERVICE_SECRET:-}" ] || [ "$MCP_SERVICE_SECRET" = "CHANGE_ME_run_openssl_rand_hex_32_and_paste_result_here_min_32_chars" ]; then
    local new_secret
    new_secret=$(openssl rand -hex 32)
    update_secret "MCP_SERVICE_SECRET" "$new_secret" "CHANGE_ME_run_openssl_rand_hex_32_and_paste_result_here_min_32_chars"
    echo "==> Generated MCP_SERVICE_SECRET"
  fi

  # Generate SUPERSET_SECRET_KEY (42-byte base64) if not set or is placeholder
  if [ -z "${SUPERSET_SECRET_KEY:-}" ] || [ "$SUPERSET_SECRET_KEY" = "CHANGE_ME_RUN_openssl_rand_base64_42" ]; then
    local new_key
    new_key=$(openssl rand -base64 42)
    update_secret "SUPERSET_SECRET_KEY" "$new_key" "CHANGE_ME_RUN_openssl_rand_base64_42"
    echo "==> Generated SUPERSET_SECRET_KEY"
  fi

  # Generate SUPERSET_ADMIN_PASSWORD (24-byte base64) if not set or is placeholder
  if [ -z "${SUPERSET_ADMIN_PASSWORD:-}" ] || [ "$SUPERSET_ADMIN_PASSWORD" = "CHANGE_ME_RUN_openssl_rand_base64_24" ]; then
    local new_pass
    new_pass=$(openssl rand -base64 24)
    update_secret "SUPERSET_ADMIN_PASSWORD" "$new_pass" "CHANGE_ME_RUN_openssl_rand_base64_24"
    echo "==> Generated SUPERSET_ADMIN_PASSWORD"
  fi

  # Generate DATABASE_PASSWORD (32-byte base64) if not set or is weak default
  if [ -z "${DATABASE_PASSWORD:-}" ] || [ "$DATABASE_PASSWORD" = "superset" ]; then
    local new_pass
    new_pass=$(openssl rand -base64 32)
    update_secret "DATABASE_PASSWORD" "$new_pass" "superset"
    echo "==> Generated DATABASE_PASSWORD"
  fi
  
  # Reload environment if secrets were changed
  if [ "$secrets_changed" = true ]; then
    export $(grep -v '^#' "$env_file" | xargs)
    echo "==> All secrets generated and saved to .env"
    echo ""
    echo "   IMPORTANT: Make a backup of your .env file!"
    echo "   If you lose these secrets, you'll need to reset them manually."
    echo ""
  fi
}

# Run secret generation
generate_secrets

echo "==> Installing Podman and podman-compose..."
sudo apt-get update -qq
sudo apt-get install -y podman podman-compose

echo "==> Checking versions..."
podman --version
podman-compose --version

echo "==> Creating internal network (hyperset-net)..."
podman network exists hyperset-net || podman network create hyperset-net

# Always deploy with integrated Superset stack
COMPOSE_FILES="-f podman-compose.yml"

echo "==> Deploying integrated Superset stack"

# Build custom Superset image with PostgreSQL support
echo "==> Building custom Superset image..."
cd Superset-Instance
podman build -t localhost/hyperset-superset:latest -f Dockerfile .
cd ..

echo "==> Building images and starting all services..."
cd "$(dirname "$0")"

# Check if containers already exist (e.g., after git pull with config changes)
if podman-compose $COMPOSE_FILES ps -q 2>/dev/null | grep -q .; then
  echo "   Existing containers found. Performing clean restart to reload config files..."
  podman-compose $COMPOSE_FILES down
fi

# Build and start with no-cache to ensure fresh images and config mounts
podman-compose $COMPOSE_FILES up --build --force-recreate -d

echo ""
echo "✓ Hyperset is starting up!"
echo ""
echo "  Next steps:"
echo "  1. Add DNS entries to your client machine's hosts file:"
echo "       <this-server-ip>  \${HYPERSET_DOMAIN:-hyperset.internal}"
echo "       <this-server-ip>  auth.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo "       <this-server-ip>  superset.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo "       <this-server-ip>  pages.\${HYPERSET_DOMAIN:-hyperset.internal}"

echo "  2. Superset is being initialized (this may take 1-2 minutes)..."
  echo "     You can monitor with: podman logs -f hyperset-superset-init"
  echo ""
  echo "  3. Once initialization completes, register your first account at:"
echo "       https://auth.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo ""
echo "  3. Open the portal at:"
echo "       https://\${HYPERSET_DOMAIN:-hyperset.internal}"
echo ""
echo "  Run 'podman-compose logs -f' to watch live logs."
podman-compose logs -f
