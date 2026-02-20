#!/usr/bin/env bash
# Hyperset — one-shot setup script
# Run this once on a fresh Debian 12+ machine after cloning the repo.
set -euo pipefail

echo "==> Installing Podman and podman-compose..."
sudo apt-get update -qq
sudo apt-get install -y podman podman-compose

echo "==> Checking versions..."
podman --version
podman-compose --version

echo "==> Creating internal network (hyperset-net)..."
podman network exists hyperset-net || podman network create hyperset-net

echo "==> Building images and starting all services..."
cd "$(dirname "$0")"
podman-compose up --build -d

echo ""
echo "✓ Hyperset is starting up!"
echo ""
echo "  Next steps:"
DOMAIN="${HYPERSET_DOMAIN:-hyperset.internal}"
echo "  1. Add DNS entries to your client machine's hosts file:"
echo "       <this-server-ip>  ${DOMAIN}"
echo "       <this-server-ip>  auth.${DOMAIN}"
echo "       <this-server-ip>  superset.${DOMAIN}"
echo "       <this-server-ip>  pages.${DOMAIN}"
echo ""
echo "  2. Register your first account at:"
echo "       https://auth.${DOMAIN}"
echo ""
echo "  3. Open the portal at:"
echo "       https://${DOMAIN}"
echo ""
echo "  Run 'podman-compose logs -f' to watch live logs."
podman-compose logs -f
