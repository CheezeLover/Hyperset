#!/bin/bash
# Apply Theme to Hyperset
# Usage: ./apply-theme.sh [orange|blue|green|dark|custom]

set -e

THEME_NAME="${1:-orange}"
THEME_FILE="theme.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
ORANGE='\033[38;5;208m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
show_orange() { echo -e "${ORANGE}$1${NC}"; }

# Check and create logos directory with defaults
check_logos() {
  if [ ! -d "logos" ]; then
    log "Creating logos directory..."
    mkdir -p logos
  fi
  
  # Create default logos if they don't exist
  if [ ! -f "logos/hyperset-logo.svg" ]; then
    log "Creating default Hyperset logo..."
    cat > logos/hyperset-logo.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" fill="none">
  <g transform="translate(10, 10)">
    <path d="M10 15c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9z" fill="#FF6B35"/>
    <path d="M28 15c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9z" fill="#FF8A5C"/>
    <path d="M19 15h9" stroke="#FF6B35" stroke-width="2"/>
    <text x="55" y="22" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="600" fill="#1A202C">Hyperset</text>
    <text x="55" y="32" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#718096">Analytics Portal</text>
  </g>
</svg>
EOF
  fi
  
  if [ ! -f "logos/hyperset-logo-dark.svg" ]; then
    log "Creating default dark mode logo..."
    cat > logos/hyperset-logo-dark.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" fill="none">
  <g transform="translate(10, 10)">
    <path d="M10 15c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9z" fill="#FF8A5C"/>
    <path d="M28 15c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9z" fill="#FFB088"/>
    <path d="M19 15h9" stroke="#FF8A5C" stroke-width="2"/>
    <text x="55" y="22" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="600" fill="#F7FAFC">Hyperset</text>
    <text x="55" y="32" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#A0AEC0">Analytics Portal</text>
  </g>
</svg>
EOF
  fi
  
  # Check for favicon
  if [ ! -f "logos/favicon.ico" ]; then
    warn "No favicon.ico found - browser will use default icon"
    info "Create one with: convert logos/hyperset-logo.svg logos/favicon.ico"
  fi
  
  log "Logo files ready"
}

# Theme presets
declare -A THEMES
case $THEME_NAME in
  orange)
    log "Applying ORANGE theme..."
    show_orange "
    ╔══════════════════════════════════════════╗
    ║     🍊 HYPERSET ORANGE THEME 🍊          ║
    ╚══════════════════════════════════════════╝
    "
    check_logos
    cat > $THEME_FILE << 'EOF'
{
  "name": "Hyperset Orange Theme",
  "version": "1.0.0",
  "description": "Warm orange theme for Hyperset analytics portal",
  "hyperset": {
    "colors": {
      "primary": "#FF6B35",
      "primaryDark": "#E85A2D",
      "primaryLight": "#FF8A5C",
      "secondary": "#2D3748",
      "background": "#FFF8F5",
      "surface": "#FFFFFF",
      "text": "#1A202C",
      "textMuted": "#718096",
      "border": "#FFE5D9",
      "success": "#48BB78",
      "warning": "#ED8936",
      "error": "#F56565",
      "info": "#4299E1"
    },
    "typography": {
      "fontFamily": "Inter, system-ui, sans-serif",
      "headingFont": "Inter, system-ui, sans-serif"
    },
    "borderRadius": "8px",
    "shadow": "0 4px 6px -1px rgba(255, 107, 53, 0.1)"
  },
  "superset": {
    "enabled": true,
    "colors": {
      "primary": "#FF6B35",
      "primaryDark": "#E85A2D",
      "secondary": "#2D3748",
      "grayscale": {
        "base": "#FFF8F5",
        "light1": "#FFEDE5",
        "light2": "#FFE5D9",
        "light3": "#FFD4C4",
        "light4": "#FFA07A",
        "light5": "#FF8A5C",
        "dark1": "#4A5568",
        "dark2": "#2D3748",
        "dark3": "#1A202C"
      }
    }
  },
  "logos": {
    "hyperset": {
      "main": "/logos/hyperset-logo.svg",
      "dark": "/logos/hyperset-logo-dark.svg",
      "favicon": "/logos/favicon.ico"
    }
  }
}
EOF
    ;;
  
  *)
    error "Unknown theme: $THEME_NAME"
    info "Available themes: orange"
    exit 1
    ;;
esac

# Validate JSON
if ! python3 -m json.tool $THEME_FILE > /dev/null 2>&1; then
  error "Invalid JSON in theme file!"
  exit 1
fi

log "Theme configuration updated"

# Show current colors
info "Current primary color: $(grep -o '"primary": "#[A-Fa-f0-9]*"' $THEME_FILE | head -1)"

# Check if running in container
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  warn "Running in container - theme will apply on next restart"
  info "Run: podman-compose restart"
else
  # Check if services are running
  if command -v podman &> /dev/null && podman ps --format "{{.Names}}" 2>/dev/null | grep -q "hyperset-caddy"; then
    log "Restarting services to apply theme..."
    
    # Restart Caddy to reload config
    podman restart hyperset-caddy 2>/dev/null || true
    
    # Restart Portal to load new theme
    podman restart hyperset-portal 2>/dev/null || true
    
    # Restart Superset if in integrated mode
    if podman ps --format "{{.Names}}" 2>/dev/null | grep -q "hyperset-superset"; then
      podman restart hyperset-superset 2>/dev/null || true
    fi
    
    log "Theme applied! Refresh your browser (Ctrl+F5)"
  else
    warn "Hyperset not running - start with: ./setup_podman.sh"
    info "Theme will be applied on next start"
  fi
fi

show_orange "
✨ Theme '$THEME_NAME' is now active!

📁 Logo files location: logos/
   - Main logo:      logos/hyperset-logo.svg
   - Dark logo:      logos/hyperset-logo-dark.svg
   - Favicon:        logos/favicon.ico (optional)

🎨 To customize your logo:
   1. Replace SVG files in logos/ folder
   2. Run: ./apply-theme.sh orange
   3. Clear browser cache (Ctrl+F5)

📖 See THEMING.md for full customization guide
"
