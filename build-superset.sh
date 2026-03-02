#!/bin/bash
# Build Superset with PostgreSQL support

set -euo pipefail

echo "=== Building Custom Superset Image ==="
echo ""

# Export env vars
export $(grep -v '^#' .env | xargs)

# Remove old images
echo "Removing old Superset images..."
podman rmi -f localhost/hyperset-superset:latest 2>/dev/null || echo "No existing image to remove"
podman rmi -f docker.io/apache/superset:6.0.0 2>/dev/null || echo "No base image cache to clear"

# Build the custom image
echo ""
echo "Building custom Superset image with PostgreSQL support..."
cd Superset-Instance
podman build -t localhost/hyperset-superset:latest -f Dockerfile .
cd ..

# Verify the image was built
echo ""
echo "Verifying image..."
podman images | grep hyperset-superset

# Test if psycopg2 is installed
echo ""
echo "Testing if psycopg2 is installed in the image..."
podman run --rm localhost/hyperset-superset:latest python -c "import psycopg2; print('psycopg2 version:', psycopg2.__version__)" || {
    echo "ERROR: psycopg2 is NOT installed!"
    exit 1
}

echo ""
echo "✓ Custom Superset image built successfully with PostgreSQL support!"
echo ""
echo "Now run:"
echo "  export \$(grep -v '^#' .env | xargs)"
echo "  COMPOSE_FILES=\"-f podman-compose.yml -f podman-compose.superset.yml\""
echo "  podman-compose \$COMPOSE_FILES up -d"
