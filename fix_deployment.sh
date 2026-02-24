#!/bin/bash

# Script pour corriger le deploiement du MCP

echo "🔧 Correction du deploiement MCP"
echo "=================================="

# 1. Arreter le service actuel
echo "1. Arret du service MCP..."
podman-compose down hyperset-superset-mcp

# 2. Supprimer l'ancien conteneur si necessaire
echo "2. Nettoyage des anciens conteneurs..."
podman rm -f hyperset-superset-mcp 2>/dev/null || true

# 3. Supprimer les volumes si necessaire
echo "3. Nettoyage des volumes..."
podman volume rm hyperset_superset-mcp-data 2>/dev/null || true

# 4. Reconstruire l'image
echo "4. Reconstruction de l'image MCP..."
podman-compose build --no-cache superset-mcp

# 5. Redemarrer le service
echo "5. Redemarrage du service MCP..."
podman-compose up -d superset-mcp

# 6. Verifier les logs
echo "6. Verification des logs..."
sleep 3
podman-compose logs --tail=20 superset-mcp

echo ""
echo "✅ Correction terminee!"
echo "Le MCP devrait maintenant utiliser le nouveau code."