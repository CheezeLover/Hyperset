#!/bin/bash
# One-liner updater for Hyperset with theming support
# Preserves your .env and updates to latest with theming

set -e

echo "🔄 Updating Hyperset with theming support..."

# Backup current config
cp .env .env.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true

# Pull latest changes
git pull origin viiibe || git pull origin main || git pull

# Create logos directory if not exists
mkdir -p logos

# Check if theme.json exists, if not use the example
test -f theme.json || cp theme.json theme.json.example 2>/dev/null || true

echo "✅ Update complete!"
echo ""
echo "Next steps:"
echo "1. Review theme.json and customize your colors"
echo "2. Add your logos to the logos/ folder"
echo "3. Run: ./setup_podman.sh"
echo ""
echo "Your .env has been backed up"
