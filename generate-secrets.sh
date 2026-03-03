#!/bin/bash
# Generate secure secrets for Hyperset deployment
# Run this script once during initial setup

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  HYPERSET SECRET GENERATOR"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ ERROR: .env file not found!"
    echo "   Copy .env.example to .env first: cp .env.example .env"
    exit 1
fi

# Generate secrets
echo "Generating secure secrets..."
echo ""

# Generate AUTH_CRYPTO_KEY (32-byte hex)
AUTH_KEY=$(openssl rand -hex 32)
echo "✓ AUTH_CRYPTO_KEY generated (32-byte hex)"

# Generate SESSION_SECRET (base64)
SESSION_SECRET=$(openssl rand -base64 32)
echo "✓ SESSION_SECRET generated (base64)"

# Generate MCP_SERVICE_SECRET (32-byte hex)
MCP_SECRET=$(openssl rand -hex 32)
echo "✓ MCP_SERVICE_SECRET generated (32-byte hex)"

# Generate SUPERSET_SECRET_KEY (42-byte base64)
SUPERSET_KEY=$(openssl rand -base64 42)
echo "✓ SUPERSET_SECRET_KEY generated (42-byte base64)"

# Generate SUPERSET_ADMIN_PASSWORD (24-byte base64)
ADMIN_PASS=$(openssl rand -base64 24)
echo "✓ SUPERSET_ADMIN_PASSWORD generated (24-byte base64)"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  SECRETS GENERATED SUCCESSFULLY"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Replace the placeholder values in your .env file with these:"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "AUTH_CRYPTO_KEY=${AUTH_KEY}"
echo "SESSION_SECRET=${SESSION_SECRET}"
echo "MCP_SERVICE_SECRET=${MCP_SECRET}"
echo "SUPERSET_SECRET_KEY=${SUPERSET_KEY}"
echo "SUPERSET_ADMIN_PASSWORD=${ADMIN_PASS}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⚠️  IMPORTANT:"
echo "   1. Copy the values above into your .env file"
echo "   2. Delete this script after running it (shred generate-secrets.sh)"
echo "   3. Never commit .env to git!"
echo "   4. Store these secrets securely (password manager, etc.)"
echo ""
