#!/bin/bash
# Diagnose Hyperset deployment issues

set -euo pipefail

echo "=== Hyperset Diagnostic Script ==="
echo ""

# Check if .env exists and load it
if [ -f .env ]; then
  echo "Loading environment from .env..."
  export $(grep -v '^#' .env | xargs)
else
  echo "WARNING: .env file not found!"
fi

echo ""
echo "=== Container Status ==="
podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Neither podman nor docker found"

echo ""
echo "=== Checking Portal Container ==="
PORTAL_LOGS=$(podman logs hyperset-portal --tail 50 2>/dev/null || docker logs hyperset-portal --tail 50 2>/dev/null || echo "Could not get portal logs")
echo "$PORTAL_LOGS"

echo ""
echo "=== Checking Superset Container ==="
SUPERSET_LOGS=$(podman logs hyperset-superset --tail 50 2>/dev/null || docker logs hyperset-superset --tail 50 2>/dev/null || echo "Could not get superset logs (may not be running in integrated mode)")
echo "$SUPERSET_LOGS"

echo ""
echo "=== Network Configuration ==="
echo "HYPERSET_DOMAIN: ${HYPERSET_DOMAIN:-NOT SET}"
echo "SUPERSET_UPSTREAM: ${SUPERSET_UPSTREAM:-NOT SET}"
echo "DEPLOY_WITH_SUPERSET: ${DEPLOY_WITH_SUPERSET:-NOT SET}"

echo ""
echo "=== Testing Internal Connectivity ==="
echo "Testing Portal from Caddy container..."
podman exec hyperset-caddy wget -qO- http://hyperset-portal:3000/api/config 2>/dev/null || echo "FAILED: Cannot reach Portal from Caddy"

echo ""
echo "Testing Superset from Caddy container..."
podman exec hyperset-caddy wget -qO- http://hyperset-superset:8088/health 2>/dev/null || echo "FAILED: Cannot reach Superset from Caddy"

echo ""
echo "Testing Superset from MCP container..."
podman exec hyperset-superset-mcp wget -qO- http://hyperset-superset:8088/health 2>/dev/null || echo "FAILED: Cannot reach Superset from MCP"

echo ""
echo "=== Caddy Configuration ==="
if [ -f Caddy/Caddyfile ]; then
  echo "Caddyfile exists - checking for common issues..."
  
  # Check if HYPERSET_DOMAIN is set in Caddyfile
  if grep -q '{$HYPERSET_DOMAIN}' Caddy/Caddyfile; then
    echo "✓ Caddyfile uses HYPERSET_DOMAIN variable"
  fi
  
  # Check if Superset upstream is set
  if grep -q '{$SUPERSET_UPSTREAM}' Caddy/Caddyfile; then
    echo "✓ Caddyfile uses SUPERSET_UPSTREAM variable"
  fi
else
  echo "ERROR: Caddy/Caddyfile not found!"
fi

echo ""
echo "=== SSO Header Test ==="
echo "Testing if Caddy forwards SSO headers to Superset..."
echo "Manual test command:"
echo "  curl -H 'X-Webauth-User: test@example.com' http://localhost:8088/api/v1/me/"
echo ""

echo "=== Recommendations ==="
if [ "${DEPLOY_WITH_SUPERSET:-false}" = "true" ]; then
  echo "Integrated Superset mode is ENABLED"
  echo "  - Superset should be at: http://hyperset-superset:8088"
  echo "  - Port 8088 should NOT be exposed externally"
  echo "  - You MUST access Superset via: https://superset.${HYPERSET_DOMAIN}"
  echo ""
  echo "If you're seeing Superset login at the main domain, try:"
  echo "  1. Restart the Portal: podman restart hyperset-portal"
  echo "  2. Restart Caddy: podman restart hyperset-caddy"
  echo "  3. Check if Portal is healthy: curl http://localhost:3000/api/config"
else
  echo "External Superset mode is ENABLED"
  echo "  - Superset should be at: ${SUPERSET_UPSTREAM}"
  echo "  - Ensure your external Superset has AUTH_REMOTE_USER configured"
fi

echo ""
echo "=== End of Diagnostics ==="
