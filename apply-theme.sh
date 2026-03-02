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
  
  blue)
    log "Applying BLUE theme..."
    cat > $THEME_FILE << 'EOF'
{
  "name": "Hyperset Blue Theme",
  "hyperset": {
    "colors": {
      "primary": "#3182CE",
      "primaryDark": "#2C5282",
      "primaryLight": "#63B3ED",
      "background": "#EBF8FF",
      "border": "#BEE3F8"
    }
  }
}
EOF
    ;;
  
  dark)
    log "Applying DARK theme..."
    cat > $THEME_FILE << 'EOF'
{
  "name": "Hyperset Dark Theme",
  "hyperset": {
    "colors": {
      "primary": "#FF6B35",
      "background": "#1A202C",
      "surface": "#2D3748",
      "text": "#F7FAFC",
      "border": "#4A5568"
    }
  }
}
EOF
    ;;
  
  custom)
    if [ ! -f "theme.custom.json" ]; then
      error "theme.custom.json not found!"
      info "Create theme.custom.json with your custom colors"
      exit 1
    fi
    log "Applying CUSTOM theme from theme.custom.json..."
    cp theme.custom.json $THEME_FILE
    ;;
  
  *)
    error "Unknown theme: $THEME_NAME"
    info "Available themes: orange, blue, green, dark, custom"
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
  if podman ps --format "{{.Names}}" | grep -q "hyperset-caddy"; then
    log "Restarting services to apply theme..."
    
    # Restart Caddy to reload config
    podman restart hyperset-caddy || true
    
    # Restart Portal to load new theme
    podman restart hyperset-portal || true
    
    # Restart Superset if in integrated mode
    if podman ps --format "{{.Names}}" | grep -q "hyperset-superset"; then
      podman restart hyperset-superset || true
    fi
    
    log "Theme applied! Refresh your browser (Ctrl+F5)"
  else
    warn "Hyperset not running - start with: ./setup_podman.sh"
  fi
fi

show_orange "
✨ Theme '$THEME_NAME' is now active!

Next steps:
1. Clear browser cache (Ctrl+F5)
2. Add your logo to: logos/hyperset-logo.svg
3. Refresh the page to see changes

To change theme later:
  ./apply-theme.sh orange  # Warm orange
  ./apply-theme.sh blue    # Professional blue
  ./apply-theme.sh dark    # Dark mode with orange accent
  ./apply-theme.sh custom  # Your own theme.custom.json
"
