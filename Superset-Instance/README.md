# Superset Configuration for Hyperset

This directory contains configuration files for Apache Superset integration with Hyperset.

## Two Deployment Options

### Option 1: Integrated Deployment (Recommended for New Users)

The easiest way to get started is using the integrated Superset deployment included in Hyperset's main `podman-compose.yml`.

**Benefits:**
- Everything runs with one command
- PostgreSQL and Redis included
- Pre-configured for Hyperset SSO
- Isolated within the podman network

**Setup:**
1. In your root `.env` file, set:
   ```env
   DEPLOY_WITH_SUPERSET=true
   SUPERSET_SECRET_KEY=$(openssl rand -base64 42)
   ```
2. Run `./setup_podman.sh`

The integrated stack will start:
- `hyperset-superset-db` (PostgreSQL 15)
- `hyperset-superset-redis` (Redis 7)
- `hyperset-superset` (Superset 6.0.0 app)
- `hyperset-superset-worker` (Celery worker)
- `hyperset-superset-beat` (Celery scheduler)
- `hyperset-superset-init` (one-time initialization)

### Option 2: External/Standalone Superset

Use this if you:
- Already have a Superset instance
- Want to run Superset on a different machine
- Prefer to manage Superset separately
- Are using a cloud-hosted Superset

**Setup:**
1. Keep `DEPLOY_WITH_SUPERSET=false` in your `.env`
2. Set `SUPERSET_UPSTREAM` to your Superset URL
3. Configure your Superset for header-based auth (see below)

For standalone deployment, you can use the provided script:
```bash
cd Superset-Instance
chmod +x standalone-setup.sh
./standalone-setup.sh
```

**Note:** This script is for deploying Superset separately from Hyperset. If you're using the integrated deployment (`DEPLOY_WITH_SUPERSET=true`), you don't need to run this script.

## Configuration Files

### superset_config_docker.py
**Purpose:** Hyperset-compatible Superset configuration for Docker/Podman deployments.

**Key features:**
- Header-based authentication (`AUTH_REMOTE_USER`)
- Automatic user provisioning from Caddy headers
- Role mapping from `X-Webauth-Groups` header
- CORS configured for Hyperset portal origin
- CSRF protection enabled
- Redis caching and Celery setup
- Security patches for Superset 6.0 bugs

**Used by:** Integrated deployment (mounted in compose file)

### superset_config.py
**Purpose:** Additional base configuration (optional). 

**Used by:** Standalone deployment via `superset_test_setup.sh`

### superset_test_setup.sh
**Purpose:** Standalone Superset deployment script.

**What it does:**
1. Clones Apache Superset 6.0.0
2. Copies configuration files
3. Creates local environment
4. Starts with docker-compose or podman-compose

**Use case:** Deploy Superset separately from Hyperset main stack

## Required Superset Configuration

For Hyperset integration, your Superset needs these settings:

```python
# Authentication
AUTH_TYPE = AUTH_REMOTE_USER
REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Gamma"
AUTH_ROLES_SYNC_AT_LOGIN = False

# CORS (allow Hyperset portal)
ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["X-CSRFToken", "X-Webauth-User", "X-Webauth-Email", "X-Webauth-Groups"],
    "origins": ["https://your-hyperset-domain"],
}

# Embedded mode
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
}
```

## Environment Variables

### For Integrated Deployment

Set these in your root `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOY_WITH_SUPERSET` | Yes | Must be `true` |
| `SUPERSET_SECRET_KEY` | Yes | Session encryption key |
| `HYPERSET_DOMAIN` | Yes | Your Hyperset domain |
| `SUPERSET_PUBLIC_URL` | Yes | Browser-accessible URL |

### For Standalone/External Deployment

Configure these in your Superset's environment:

| Variable | Purpose |
|----------|---------|
| `HYPERSET_DOMAIN` | Hyperset domain for CORS |
| `HYPERSET_ORIGIN` | Full Hyperset URL (e.g., `https://hyperset.internal`) |
| `HYPERSET_ADMIN_ROLE_HEADER` | Header value for admin role (default: `hyperset/admin`) |
| `HYPERSET_USER_ROLE_HEADER` | Header value for user role (default: `hyperset/user`) |
| `SECRET_KEY` | Superset session encryption |

## Security Considerations

⚠️ **Critical:** When using header-based auth (`AUTH_REMOTE_USER`):

1. **Never expose Superset directly to the internet**
   - Only Caddy should reach Superset
   - Use firewall rules to block direct access to port 8088

2. **Caddy must be the only entry point**
   - It validates users and injects trusted headers
   - Superset trusts `X-Webauth-User` unconditionally

3. **Use HTTPS everywhere**
   - Caddy handles TLS termination
   - Internal traffic should also use TLS in production

## Troubleshooting

**Superset not accepting headers:**
- Check `superset_config_docker.py` is loaded
- Verify `REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"`
- Test: `curl -H "X-Webauth-User: admin" http://localhost:8088/api/v1/me/`

**CORS errors in browser:**
- Verify `HYPERSET_ORIGIN` matches your portal URL exactly
- Check `ENABLE_CORS = True` in config
- Ensure no trailing slash mismatch

**User not auto-created:**
- Check `AUTH_USER_REGISTRATION = True`
- Verify Caddy is sending `X-Webauth-User` header
- Look at Superset logs: `podman logs hyperset-superset`

## Links

- [Apache Superset Documentation](https://superset.apache.org/docs/)
- [Superset GitHub](https://github.com/apache/superset)
- [Hyperset Main README](../README.md)
