#!/bin/bash
# Hyperset - One-click installer for fresh VM
# Run as root on a fresh Debian/Ubuntu VM

set -euo pipefail

# Configuration
REPO_URL="https://github.com/CheezeLover/Hyperset.git"
INSTALL_DIR="/opt/hyperset"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    error "Please run as root (use sudo)"
    exit 1
fi

# Update system
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y

# Install required packages
log "Installing git and podman..."
apt-get install -y git podman podman-compose openssl

# Check versions
log "Checking versions..."
podman --version
podman-compose --version

# Clone repository
if [ -d "$INSTALL_DIR" ]; then
    warn "Directory $INSTALL_DIR exists, updating..."
    cd "$INSTALL_DIR"
    git pull
else
    log "Cloning Hyperset repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Generate secrets
log "Generating secrets..."
AUTH_CRYPTO_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -base64 32)
MCP_SERVICE_SECRET=$(openssl rand -hex 32)
SUPERSET_SECRET_KEY=$(openssl rand -base64 42)

# Create .env file
cat > .env << EOF
# Hyperset Configuration
# Generated automatically on $(date)

# Domain configuration
HYPERSET_DOMAIN=hyperset.local

# Deployment mode
deprecated_WITH_SUPERSET=true

# Superset configuration
SUPERSET_SECRET_KEY=$SUPERSET_SECRET_KEY
SUPERSET_UPSTREAM=http://hyperset-superset:8088
SUPERSET_PUBLIC_URL=https://superset.hyperset.local

# Pages configuration
PAGES_PUBLIC_URL=https://pages.hyperset.local

# Auth secrets (GENERATED - DO NOT SHARE)
AUTH_CRYPTO_KEY=$AUTH_CRYPTO_KEY
SESSION_SECRET=$SESSION_SECRET
MCP_SERVICE_SECRET=$MCP_SERVICE_SECRET

# LLM Configuration (update these with your API key)
LLM_API_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key-here
LLM_MODEL=gpt-4o

# Superset credentials
SUPERSET_MCP_USER=admin
SUPERSET_MCP_PASSWORD=

# OAuth configuration (optional)
OAUTH_CLIENT_ID=placeholder
OAUTH_CLIENT_SECRET=placeholder
ENTRA_TENANT_ID=common
OIDC_METADATA_URL=https://localhost/.well-known/openid-configuration
EOF

log "Configuration saved to .env"

# Create podman network
log "Creating podman network..."
podman network exists hyperset-net || podman network create hyperset-net

# Build and start services
log "Building and starting Hyperset..."
export $(grep -v '^#' .env | xargs)
COMPOSE_FILES="-f podman-compose.yml -f podman-compose.superset.yml"

log "Building custom Superset image..."
cd Superset-Instance
podman build -t localhost/hyperset-superset:latest -f Dockerfile .
cd ..

log "Starting all services..."
podman-compose $COMPOSE_FILES up -d

# Display completion message
echo ""
echo "=========================================="
echo "  Hyperset Installation Complete!"
echo "=========================================="
echo ""
echo "Access URLs:"
echo "  Portal:      https://hyperset.local"
echo "  Auth:        https://auth.hyperset.local"
echo "  Superset:    https://superset.hyperset.local"
echo "  Pages:       https://pages.hyperset.local"
echo ""
echo "Next Steps:"
echo "  1. Add to your hosts file (/etc/hosts):"
echo "     <VM-IP>  hyperset.local auth.hyperset.local superset.hyperset.local pages.hyperset.local"
echo ""
echo "  2. Open browser and visit:"
echo "     https://auth.hyperset.local"
echo ""
echo "  3. Register your first account (first user gets admin rights)"
echo ""
echo "  4. Update LLM API key in: $INSTALL_DIR/.env"
echo "     Then run: cd $INSTALL_DIR && podman-compose restart portal"
echo ""
echo "Useful commands:"
echo "  View logs:    podman-compose -f podman-compose.yml -f podman-compose.superset.yml logs -f"
echo "  Stop:         podman-compose -f podman-compose.yml -f podman-compose.superset.yml down"
echo "  Restart:      podman-compose -f podman-compose.yml -f podman-compose.superset.yml restart"
echo ""
echo "Installation directory: $INSTALL_DIR"
echo ""

# Show service status
log "Service status:"
podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
