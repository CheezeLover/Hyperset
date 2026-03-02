#!/usr/bin/env bash
# Hyperset — one-shot setup script
# Run this once on a fresh Debian 12+ machine after cloning the repo.
set -euo pipefail

# Load environment variables from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

echo "==> Installing Podman and podman-compose..."
sudo apt-get update -qq
sudo apt-get install -y podman podman-compose

echo "==> Checking versions..."
podman --version
podman-compose --version

echo "==> Creating internal network (hyperset-net)..."
podman network exists hyperset-net || podman network create hyperset-net

# Determine which compose files to use
COMPOSE_FILES="-f podman-compose.yml"
DEPLOY_WITH_SUPERSET=${DEPLOY_WITH_SUPERSET:-false}
if [ "$DEPLOY_WITH_SUPERSET" = "true" ]; then
  echo "==> DEPLOY_WITH_SUPERSET=true: Including integrated Superset stack"
  COMPOSE_FILES="$COMPOSE_FILES -f podman-compose.superset.yml"
  
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
else
  echo "==> DEPLOY_WITH_SUPERSET=false: Using external Superset instance"
  echo "   Ensure SUPERSET_UPSTREAM in .env points to your Superset instance"
fi

echo "==> Building images and starting all services..."
cd "$(dirname "$0")"
podman-compose $COMPOSE_FILES up --build -d

echo ""
echo "✓ Hyperset is starting up!"
echo ""
echo "  Next steps:"
echo "  1. Add DNS entries to your client machine's hosts file:"
echo "       <this-server-ip>  \${HYPERSET_DOMAIN:-hyperset.internal}"
echo "       <this-server-ip>  auth.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo "       <this-server-ip>  superset.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo "       <this-server-ip>  pages.\${HYPERSET_DOMAIN:-hyperset.internal}"

if [ "$DEPLOY_WITH_SUPERSET" = "true" ]; then
  echo ""
  echo "  2. Superset is being initialized (this may take 1-2 minutes)..."
  echo "     You can monitor with: podman logs -f hyperset-superset-init"
  echo ""
  echo "  3. Once initialization completes, register your first account at:"
else
  echo ""
  echo "  2. Register your first account at:"
fi
echo "       https://auth.\${HYPERSET_DOMAIN:-hyperset.internal}"
echo ""
echo "  3. Open the portal at:"
echo "       https://\${HYPERSET_DOMAIN:-hyperset.internal}"
echo ""
echo "  Run 'podman-compose logs -f' to watch live logs."
podman-compose logs -f
