#!/usr/bin/env bash
# Hyperset — one-shot setup script
# Run this once on a fresh Debian 12+ machine after cloning the repo.
set -euo pipefail

# Load environment variables from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# ============================================================================
# Generate secure random passwords on first run (idempotent)
# ============================================================================
generate_passwords() {
  local env_file=".env"
  local password_changed=false
  
  # Generate SuperSET_ADMIN_PASSWORD if not set or is placeholder
  if [ -z "${SUPERSET_ADMIN_PASSWORD:-}" ] || [ "$SUPERSET_ADMIN_PASSWORD" = "CHANGE_ME_RUN_openssl_rand_hex_24" ]; then
    local new_admin_pass
    new_admin_pass=$(openssl rand -hex 24)
    
    if [ -f "$env_file" ]; then
      # Check if already exists in file (not just environment)
      if grep -q "^SUPERSET_ADMIN_PASSWORD=" "$env_file" && ! grep -q "^SUPERSET_ADMIN_PASSWORD=CHANGE_ME" "$env_file"; then
        echo "==> Using existing SUPERSET_ADMIN_PASSWORD from $env_file"
      else
        # Update or add the password
        if grep -q "^SUPERSET_ADMIN_PASSWORD=" "$env_file"; then
          sed -i "s|^SUPERSET_ADMIN_PASSWORD=.*|SUPERSET_ADMIN_PASSWORD=$new_admin_pass|" "$env_file"
        else
          echo "" >> "$env_file"
          echo "# Auto-generated on first run - do not change manually" >> "$env_file"
          echo "SUPERSET_ADMIN_PASSWORD=$new_admin_pass" >> "$env_file"
        fi
        echo "==> Generated new SUPERSET_ADMIN_PASSWORD (saved to $env_file)"
        password_changed=true
      fi
    else
      echo "⚠️  Warning: .env file not found. Cannot save generated password."
    fi
  fi
  
  # Generate DATABASE_PASSWORD if not set or is weak default
  if [ -z "${DATABASE_PASSWORD:-}" ] || [ "$DATABASE_PASSWORD" = "superset" ]; then
    local new_db_pass
    new_db_pass=$(openssl rand -hex 32)
    
    if [ -f "$env_file" ]; then
      # Check if already exists in file with non-default value
      if grep -q "^DATABASE_PASSWORD=" "$env_file" && ! grep -q "^DATABASE_PASSWORD=superset" "$env_file"; then
        echo "==> Using existing DATABASE_PASSWORD from $env_file"
      else
        # Update or add the password
        if grep -q "^DATABASE_PASSWORD=" "$env_file"; then
          sed -i "s|^DATABASE_PASSWORD=.*|DATABASE_PASSWORD=$new_db_pass|" "$env_file"
        else
          echo "" >> "$env_file"
          echo "# Auto-generated database password on first run - do not change manually" >> "$env_file"
          echo "DATABASE_PASSWORD=$new_db_pass" >> "$env_file"
        fi
        echo "==> Generated new DATABASE_PASSWORD (saved to $env_file)"
        password_changed=true
      fi
    else
      echo "⚠️  Warning: .env file not found. Cannot save generated database password."
    fi
  fi
  
  # Reload environment if passwords were changed
  if [ "$password_changed" = true ]; then
    export $(grep -v '^#' "$env_file" | xargs)
    echo "==> Passwords generated and saved. They will persist across restarts."
    echo ""
    echo "   IMPORTANT: Make a backup of your .env file!"
    echo "   If you lose these passwords, you'll need to reset the admin user manually."
    echo ""
  fi
}

# Run password generation
generate_passwords

echo "==> Installing Podman and podman-compose..."
sudo apt-get update -qq
sudo apt-get install -y podman podman-compose

echo "==> Checking versions..."
podman --version
podman-compose --version

echo "==> Creating internal network (hyperset-net)..."
podman network exists hyperset-net || podman network create hyperset-net

# Always deploy with integrated Superset stack
COMPOSE_FILES="-f podman-compose.yml -f podman-compose.superset.yml"

echo "==> Deploying with integrated Superset stack"

# Check for SUPERSET_SECRET_KEY
if [ -z "${SUPERSET_SECRET_KEY:-}" ] || [ "$SUPERSET_SECRET_KEY" = "CHANGE_ME_RUN_openssl_rand_base64_42" ]; then
  echo ""
  echo "⚠️  WARNING: SUPERSET_SECRET_KEY is not set or is using the default placeholder!"
  echo "   Please set a secure secret key in your .env file:"
  echo "   SUPERSET_SECRET_KEY=$(openssl rand -base64 42)"
  echo ""
  echo "   Continuing with setup, but Superset may fail to start..."
  echo ""
  sleep 3
fi

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

echo ""
echo "  2. Superset is being initialized (this may take 1-2 minutes)..."
echo "     You can monitor with: podman logs -f hyperset-superset-init"
echo ""
echo "  3. Once initialization completes, register your first account at:"
echo "       https://auth.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo ""
echo "  4. Open the portal at:"
echo "       https://\${HYPERSET_DOMAIN:-hyperset.internal}"
echo ""
echo "  Run 'podman-compose logs -f' to watch live logs."
podman-compose logs -f
