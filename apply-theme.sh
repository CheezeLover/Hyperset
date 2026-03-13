#!/bin/bash
# Force complete rebuild and cache clear for Hyperset/Superset theme changes

echo "=== Force Applying Theme Changes ==="
echo ""

# Stop all containers
echo "1. Stopping all containers..."
podman-compose down

# Remove Superset container completely (forces fresh config load)
echo "2. Removing Superset container..."
podman rm -f hyperset-superset 2>/dev/null || true

# Clear Superset's web assets cache
echo "3. Clearing Superset web assets cache..."
podman volume rm -f hyperset_superset_home 2>/dev/null || true

# Clear any Redis cache
echo "4. Clearing Redis cache..."
podman exec -it hyperset-redis redis-cli FLUSHALL 2>/dev/null || echo "Redis not running or already cleared"

# Rebuild Superset image if needed (forces fresh EXTRA_CSS)
echo "5. Rebuilding Superset image..."
podman-compose build hyperset-superset

# Start everything fresh
echo "6. Starting all containers..."
podman-compose up -d

# Wait for Superset to be ready
echo "7. Waiting for Superset to start..."
sleep 10

# Check if Superset is responding
echo "8. Checking Superset status..."
for i in {1..30}; do
    if curl -s http://localhost:8088/health > /dev/null 2>&1; then
        echo "   ✓ Superset is ready!"
        break
    fi
    echo "   Waiting... ($i/30)"
    sleep 2
done

echo ""
echo "=== Theme Changes Applied ==="
echo ""
echo "IMPORTANT: Clear your browser cache:"
echo "  - Chrome/Edge: Press Ctrl+Shift+R (or Cmd+Shift+R on Mac)"
echo "  - Or open DevTools (F12) → Right-click refresh button → 'Empty Cache and Hard Reload'"
echo ""
echo "To verify theme is loaded:"
echo "  - Visit: https://your-domain/debug/theme"
echo "  - Check that 'THEME_DARK' shows the correct colors"
echo ""
