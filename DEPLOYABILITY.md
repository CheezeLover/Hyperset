# Deployability Improvements Summary

This document summarizes the changes made to improve Hyperset's deployability with the new `DEPLOY_WITH_SUPERSET` environment variable.

## What's New

### 1. Environment Variable: `DEPLOY_WITH_SUPERSET`

Controls whether to deploy Superset as part of the main Hyperset stack.

**Values:**
- `false` (default) - Use external Superset instance
- `true` - Deploy integrated Superset stack

### 2. Two Deployment Modes

#### Mode A: Integrated Superset (DEPLOY_WITH_SUPERSET=true)

Deploys a complete Superset stack alongside Hyperset:
- **PostgreSQL 15** - Database for Superset metadata
- **Redis 7** - Caching and Celery broker
- **Superset 6.0.0** - Main application server
- **Celery Worker** - Background task processing
- **Celery Beat** - Task scheduler
- **Init Container** - One-time database setup and admin creation

**Benefits:**
- Single command deployment
- Everything isolated in podman network
- Pre-configured for Hyperset SSO
- No external dependencies

**Setup:**
```bash
# In .env
DEPLOY_WITH_SUPERSET=true
SUPERSET_SECRET_KEY=$(openssl rand -base64 42)

# Deploy
./setup_podman.sh
```

#### Mode B: External Superset (DEPLOY_WITH_SUPERSET=false)

Connects to an existing Superset instance:
- Use cloud-hosted Superset
- Self-hosted Superset on another machine
- Existing Superset deployment

**Setup:**
```bash
# In .env
DEPLOY_WITH_SUPERSET=false
SUPERSET_UPSTREAM=https://your-superset-instance.com

# Deploy
./setup_podman.sh
```

## New Files

### `podman-compose.superset.yml`
Complete Superset stack definition including:
- Database service (PostgreSQL)
- Cache service (Redis)
- Superset app with proper configuration
- Celery worker and scheduler
- Initialization job

### `Superset-Instance/README.md`
Comprehensive documentation explaining:
- Both deployment options
- Configuration files
- Environment variables
- Security considerations
- Troubleshooting

### `Superset-Instance/standalone-setup.sh` (renamed)
Formerly `superset_test_setup.sh`, now clearly marked for standalone deployments.

## Updated Files

### `.env`
Added new variables:
- `DEPLOY_WITH_SUPERSET` - Deployment mode switch
- `SUPERSET_SECRET_KEY` - Required for integrated mode

### `setup_podman.sh`
Now conditionally includes the Superset compose file based on `DEPLOY_WITH_SUPERSET`:
- Loads environment from `.env`
- Checks for required secrets when in integrated mode
- Provides helpful warnings and next steps

### `README.md`
Major updates including:
- Clear deployment mode selection guide
- Mode A and Mode B quick start sections
- Updated architecture diagrams showing both modes
- New environment variable documentation
- Reorganized Superset deployment section

### `Superset-Instance/superset_config_docker.py`
Enhanced with:
- Better comments
- Clearer environment variable handling
- Fixed security configurations

## Removed Files

- `mcp-auth.ts` - Orphaned duplicate file (exists in portal-app)
- `fix_deployment.sh` - Temporary script not referenced anywhere

## Configuration Reference

### Required Variables for Integrated Mode

```env
DEPLOY_WITH_SUPERSET=true
SUPERSET_SECRET_KEY=<42-char-base64-secret>
HYPERSET_DOMAIN=your-domain.com
AUTH_CRYPTO_KEY=<32-char-hex>
SESSION_SECRET=<32-char-secret>
MCP_SERVICE_SECRET=<32-char-secret>
```

### Required Variables for External Mode

```env
DEPLOY_WITH_SUPERSET=false
SUPERSET_UPSTREAM=https://your-superset.com
SUPERSET_PUBLIC_URL=https://superset.your-domain.com
HYPERSET_DOMAIN=your-domain.com
# ... other standard secrets
```

## Network Architecture

### Integrated Mode
```
┌─────────────────────────────────────────────────────────┐
│                    Hyperset Stack                       │
│  ├─ Caddy (reverse proxy, HTTPS)                       │
│  ├─ Portal (Next.js)                                  │
│  ├─ Pages Service                                       │
│  ├─ Superset MCP                                      │
│  └─ Superset Stack:                                   │
│     ├─ superset (app)                                 │
│     ├─ superset-db (PostgreSQL)                       │
│     ├─ superset-redis (Redis)                         │
│     ├─ superset-worker (Celery)                       │
│     └─ superset-beat (scheduler)                      │
└─────────────────────────────────────────────────────────┘
```

### External Mode
```
┌─────────────────────────┐      ┌──────────────────┐
│    Hyperset Stack       │      │ External         │
│  ├─ Caddy              │◄─────┤ Superset         │
│  ├─ Portal              │      │ Instance         │
│  ├─ Pages Service       │      │                  │
│  └─ Superset MCP       │      └──────────────────┘
└─────────────────────────┘
```

## Migration Guide

### From External to Integrated

1. Back up your external Superset data
2. Update `.env`:
   ```env
   DEPLOY_WITH_SUPERSET=true
   SUPERSET_SECRET_KEY=$(openssl rand -base64 42)
   ```
3. Run `./setup_podman.sh`
4. Import your data to the new PostgreSQL instance

### From Integrated to External

1. Export data from integrated PostgreSQL
2. Update `.env`:
   ```env
   DEPLOY_WITH_SUPERSET=false
   SUPERSET_UPSTREAM=https://your-external-superset.com
   ```
3. Run `./setup_podman.sh`
4. Import data to external Superset

## Security Notes

1. **SUPERSET_SECRET_KEY** must be changed from the placeholder before production use
2. When using integrated mode, port 8088 is exposed - firewall it appropriately
3. Caddy remains the only internet-facing service
4. All internal traffic is on isolated podman network

## Testing the Deployment

### Verify Integrated Mode

```bash
# Check all services are running
podman ps

# Check Superset initialization
podman logs hyperset-superset-init

# Test Superset API
curl -H "X-Webauth-User: admin" http://localhost:8088/api/v1/me/

# Check MCP connectivity
curl http://localhost:8000/mcp
```

### Verify External Mode

```bash
# Check Hyperset services
podman ps

# Verify external Superset is reachable
podman exec hyperset-caddy curl -s $SUPERSET_UPSTREAM/health
```

## Support

For issues or questions:
1. Check the [Superset-Instance README](Superset-Instance/README.md)
2. Review environment variable configuration
3. Check service logs: `podman-compose logs -f <service-name>`
4. Refer to the main [README.md](README.md)
