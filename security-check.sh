#!/bin/bash
# Security Checklist for Hyperset Deployment
# Run this before first deployment and periodically for audits

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

check_passed() {
    echo -e "${GREEN}✓${NC} $1"
}

check_failed() {
    echo -e "${RED}✗${NC} $1"
    ((ERRORS++))
}

check_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARNINGS++))
}

echo "═══════════════════════════════════════════════════════════"
echo "  HYPERSET SECURITY AUDIT CHECKLIST"
echo "═══════════════════════════════════════════════════════════"
echo ""

# 1. Check .env file exists and is not .env.example
echo "1. Checking .env file..."
if [ -f .env ]; then
    if [ .env -nt .env.example ]; then
        check_passed ".env file exists and is newer than .env.example"
    else
        check_warning ".env exists but may be outdated (older than .env.example)"
    fi
else
    check_failed ".env file not found! Copy from .env.example and configure."
fi

# 2. Check for default secrets in .env
echo ""
echo "2. Checking for default/placeholder secrets..."
if [ -f .env ]; then
    # Check each critical secret
    if grep -q "SUPERSET_SECRET_KEY=CHANGE_ME" .env 2>/dev/null || grep -q 'SUPERSET_SECRET_KEY="CHANGE_ME' .env 2>/dev/null; then
        check_failed "SUPERSET_SECRET_KEY is using default placeholder"
    else
        check_passed "SUPERSET_SECRET_KEY appears to be configured"
    fi
    
    if grep -q "SUPERSET_ADMIN_PASSWORD=CHANGE_ME" .env 2>/dev/null || grep -q 'SUPERSET_ADMIN_PASSWORD="CHANGE_ME' .env 2>/dev/null; then
        check_failed "SUPERSET_ADMIN_PASSWORD is using default placeholder"
    else
        check_passed "SUPERSET_ADMIN_PASSWORD appears to be configured"
    fi
    
    if grep -q "AUTH_CRYPTO_KEY=CHANGE_ME" .env 2>/dev/null || grep -q 'AUTH_CRYPTO_KEY="CHANGE_ME' .env 2>/dev/null; then
        check_failed "AUTH_CRYPTO_KEY is using default placeholder"
    else
        check_passed "AUTH_CRYPTO_KEY appears to be configured"
    fi
    
    if grep -q "MCP_SERVICE_SECRET=CHANGE_ME" .env 2>/dev/null || grep -q 'MCP_SERVICE_SECRET="CHANGE_ME' .env 2>/dev/null; then
        check_failed "MCP_SERVICE_SECRET is using default placeholder"
    else
        check_passed "MCP_SERVICE_SECRET appears to be configured"
    fi
    
    if grep -q "SESSION_SECRET=change-me" .env 2>/dev/null || grep -q 'SESSION_SECRET="change-me' .env 2>/dev/null; then
        check_failed "SESSION_SECRET is using default placeholder"
    else
        check_passed "SESSION_SECRET appears to be configured"
    fi
fi

# 3. Check secret lengths (basic validation)
echo ""
echo "3. Validating secret lengths..."
if [ -f .env ]; then
    SUPERSET_KEY=$(grep "^SUPERSET_SECRET_KEY=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "")
    if [ -n "$SUPERSET_KEY" ] && [ ${#SUPERSET_KEY} -lt 40 ]; then
        check_failed "SUPERSET_SECRET_KEY is too short (${#SUPERSET_KEY} chars, need 42+)"
    else
        check_passed "SUPERSET_SECRET_KEY length is adequate"
    fi
    
    AUTH_KEY=$(grep "^AUTH_CRYPTO_KEY=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "")
    if [ -n "$AUTH_KEY" ] && [ ${#AUTH_KEY} -lt 32 ]; then
        check_failed "AUTH_CRYPTO_KEY is too short (${#AUTH_KEY} chars, need 32+)"
    else
        check_passed "AUTH_CRYPTO_KEY length is adequate"
    fi
fi

# 4. Check domain configuration
echo ""
echo "4. Checking domain configuration..."
if [ -f .env ]; then
    DOMAIN=$(grep "^HYPERSET_DOMAIN=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "")
    if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "hyperset.internal" ]; then
        check_warning "Using default domain 'hyperset.internal' - change for production"
    else
        check_passed "Custom domain configured: $DOMAIN"
    fi
fi

# 5. Check TLS/SSL considerations
echo ""
echo "5. TLS/SSL Configuration..."
if [ -f Caddy/Caddyfile ]; then
    if grep -q "tls internal" Caddy/Caddyfile; then
        check_warning "Using internal/self-signed TLS certificates"
        echo "   For production, use:"
        echo "   - Let's Encrypt: tls { email your@email.com }"
        echo "   - Custom cert: tls /path/to/cert.pem /path/to/key.pem"
    else
        check_passed "Custom TLS configuration detected"
    fi
fi

# 6. Check for network isolation
echo ""
echo "6. Network Security..."
if podman network ls 2>/dev/null | grep -q "hyperset-net"; then
    check_passed "hyperset-net network exists"
else
    check_failed "hyperset-net network not found - run setup first"
fi

# 7. Check for exposed ports
echo ""
echo "7. Port Exposure..."
if [ -f podman-compose.yml ]; then
    EXPOSED_PORTS=$(grep -E "^\s+- \"[0-9]+:" podman-compose.yml | wc -l)
    if [ "$EXPOSED_PORTS" -eq 2 ]; then
        check_passed "Only standard HTTPS (443) and HTTP (80) ports exposed"
    else
        check_warning "$EXPOSED_PORTS port mappings found - verify all are intentional"
    fi
fi

# 8. Check containers running
echo ""
echo "8. Container Security Status..."
RUNNING=$(podman ps --filter name=hyperset 2>/dev/null | wc -l)
if [ "$RUNNING" -gt 1 ]; then
    check_passed "$((RUNNING-1)) Hyperset containers are running"
    
    # Check for privileged containers
    PRIVILEGED=$(podman ps --filter name=hyperset --format "{{.Names}}" 2>/dev/null | while read name; do
        podman inspect --format "{{.HostConfig.Privileged}}" "$name" 2>/dev/null | grep -q "true" && echo "$name"
    done | wc -l)
    
    if [ "$PRIVILEGED" -gt 0 ]; then
        check_failed "$PRIVILEGED containers running in privileged mode"
    else
        check_passed "No containers running in privileged mode"
    fi
else
    check_warning "Containers not running (may be expected if not deployed yet)"
fi

# 9. Check file permissions
echo ""
echo "9. File Permissions..."
if [ -f .env ]; then
    PERM=$(stat -c "%a" .env 2>/dev/null || stat -f "%A" .env 2>/dev/null || echo "unknown")
    if [ "$PERM" = "600" ] || [ "$PERM" = "644" ]; then
        check_passed ".env file permissions are secure ($PERM)"
    else
        check_warning ".env file permissions are $PERM (recommend 600 or 644)"
        echo "   Fix: chmod 600 .env"
    fi
fi

# 10. Check for production readiness
echo ""
echo "10. Production Readiness..."
if [ -f .env ]; then
    DEPLOY_MODE=$(grep "^DEPLOY_WITH_SUPERSET=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "false")
    if [ "$DEPLOY_MODE" = "true" ]; then
        check_passed "Integrated Superset deployment mode"
        
        # Check for database security
        if grep -q "SUPERSET_SECRET_KEY=CHANGE_ME" .env 2>/dev/null; then
            check_failed "Integrated Superset requires SUPERSET_SECRET_KEY to be set"
        fi
    else
        check_passed "External Superset mode - verify SUPERSET_UPSTREAM is correct"
    fi
fi

# Summary
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  SECURITY AUDIT SUMMARY"
echo "═══════════════════════════════════════════════════════════"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC} System appears secure."
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠ $WARNINGS warnings${NC} - Review recommendations above"
    exit 0
else
    echo -e "${RED}✗ $ERRORS errors, $WARNINGS warnings${NC}"
    echo ""
    echo "CRITICAL: Fix errors before deploying to production!"
    exit 1
fi
