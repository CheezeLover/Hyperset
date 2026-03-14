# SSO Troubleshooting Guide

## Quick Diagnosis Steps

### Step 1: Check Container Status

```bash
# Check if all containers are running
podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Or use docker
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

You should see:
- `hyperset-caddy` - Running
- `hyperset-portal` - Running (healthy)
- `hyperset-superset` - Running
- `hyperset-superset-mcp` - Running
- `hyperset-pages` - Running

### Step 2: Test Portal Health

```bash
# Test Portal directly
curl http://localhost:3000/api/config

# Test Portal from Caddy container
podman exec hyperset-caddy wget -qO- http://hyperset-portal:3000/api/config
```

Should return JSON with configuration. If this fails, the Portal is the issue.

### Step 3: Check Portal Logs

```bash
podman logs hyperset-portal --tail 100
```

Look for:
- "✓ Ready" message (good)
- Stream errors (may indicate issues but not necessarily fatal)
- Crash messages (bad)

### Step 4: Check What Caddy is Doing

```bash
# Follow Caddy logs
podman logs -f hyperset-caddy
```

Then access your main domain and watch the logs. You should see:
- Request coming in
- Authorization check passing
- Reverse proxy to hyperset-portal:3000

**If you see it proxying to Superset instead, there's a Caddyfile issue!**

### Step 5: Verify Headers to Superset

```bash
# Check Superset logs with new debug config
podman logs hyperset-superset --tail 100
```

With the updated config, you should see:
```
[Middleware] Set REMOTE_USER=admin@HYPERSET.local from X-Webauth-User header
[AutoLogin] path=/api/v1/database/, REMOTE_USER=admin@HYPERSET.local
[SecurityManager] auth_user_remote_user called with username=admin@HYPERSET.local
```

If you DON'T see these messages, the config isn't loading!

### Step 6: Manual Header Test

```bash
# Test if Superset accepts headers directly
podman exec hyperset-caddy curl -H "X-Webauth-User: test@example.com" http://hyperset-superset:8088/api/v1/me/
```

Should return user info, not a 401 error.

## Common Issues

### Issue 1: Main domain shows Superset instead of Portal

**Symptoms:**
- Accessing `https://your-domain.com` shows Superset login
- Should show Hyperset Portal

**Causes:**
1. **Portal container not running**
   - Check: `podman ps | grep portal`
   - Fix: `podman restart hyperset-portal`

2. **Portal unhealthy**
   - Check: `podman logs hyperset-portal`
   - Fix: Restart and check for errors

3. **Port conflict**
   - If something else is using port 3000
   - Fix: Check `netstat -tlnp | grep 3000`

4. **Caddyfile not updated**
   - The Caddyfile should route `{$HYPERSET_DOMAIN}` to Portal
   - Fix: Check `cat Caddy/Caddyfile | grep -A5 "{$HYPERSET_DOMAIN}"`

### Issue 2: Superset showing login page (SSO not working)

**Symptoms:**
- Accessing `https://superset.your-domain.com` shows login form
- Should automatically log you in

**Causes:**

1. **Config not loaded**
   - The `superset_config_docker.py` file is not being loaded
   - **Check:** Look in Superset logs for "=== Hyperset Superset Config Loaded ==="
   - **Fix:** 
     ```bash
     # Verify file is mounted
     podman exec hyperset-superset ls -la /app/pythonpath/
     
     # Should show superset_config_docker.py
     # If not, rebuild with: podman-compose build --no-cache superset-app
     ```

2. **Headers not reaching Superset**
   - **Check:** In Superset logs, look for "No X-Webauth-User header found!"
   - **Fix:** Verify Caddy is sending headers:
     ```bash
     # Check Caddyfile has these lines in superset block:
     # header_up X-Webauth-User  {http.request.header.X-Token-User-Email}
     # header_up X-Webauth-Email {http.request.header.X-Token-User-Email}
     # header_up X-Webauth-Groups {http.request.header.X-Token-User-Roles}
     ```

3. **Wrong Superset URL**
   - **Check:** Are you accessing via `https://superset.your-domain.com`?
   - **NOT:** `http://your-server:8088` (bypasses Caddy and SSO!)

4. **Config caching**
   - Superset might cache the config
   - **Fix:** 
     ```bash
     podman restart hyperset-superset
     # Or full rebuild
     podman-compose down
     podman-compose build --no-cache
     podman-compose up -d
     ```

### Issue 3: MCP getting 401 errors

**Symptoms:**
- Chat says "Superset 401: Missing Authorization Header"
- Data tools don't work

**Causes:**

1. **Superset rejecting API calls**
   - The MCP sends `X-Webauth-User` header but Superset rejects it
   - **Check:** Look for `[Middleware]` and `[SecurityManager]` messages in Superset logs
   - **Fix:** Same as Issue 2 above

2. **User not created in Superset**
   - First time accessing, user needs to be auto-created
   - **Fix:** Make sure you've logged in via the portal first

3. **Wrong upstream URL**
   - Check that `SUPERSET_UPSTREAM` matches your setup:
     - Integrated mode: `http://hyperset-superset:8088`
     - External mode: Your external Superset URL

## Nuclear Option: Full Reset

If nothing works, do a complete reset:

```bash
# 1. Stop everything
podman-compose -f podman-compose.yml -f podman-compose.superset.yml down

# 2. Remove all containers
podman rm -f $(podman ps -aq)

# 3. Remove images to force rebuild
podman rmi -f $(podman images -q)

# 4. Clear volumes (DANGER: loses data!)
# podman volume rm $(podman volume ls -q)

# 5. Rebuild from scratch
export $(grep -v '^#' .env | xargs)
COMPOSE_FILES="-f podman-compose.yml -f podman-compose.superset.yml"
podman-compose $COMPOSE_FILES build --no-cache
podman-compose $COMPOSE_FILES up -d

# 6. Watch logs
podman-compose $COMPOSE_FILES logs -f
```

## Getting Help

If you're still stuck:

1. Run `./diagnose.sh` and save output
2. Get logs from all containers:
   ```bash
   podman logs hyperset-caddy > caddy.log
   podman logs hyperset-portal > portal.log
   podman logs hyperset-superset > superset.log
   podman logs hyperset-superset-mcp > mcp.log
   ```
3. Check your `.env` file (remove secrets before sharing):
   ```bash
   cat .env | grep -v KEY | grep -v SECRET | grep -v PASSWORD
   ```
4. Check what's actually running:
   ```bash
   podman ps > containers.txt
   podman network inspect hyperset-net > network.txt
   ```

## Expected Working State

When everything works correctly:

1. **Main domain** (`https://your-domain.com`):
   - Shows Hyperset Portal
   - Has Chat, Dashboard, Settings in sidebar

2. **Superset subdomain** (`https://superset.your-domain.com`):
   - Automatically logs you in (no login form!)
   - Shows your email in top right corner
   - Can browse charts and dashboards

3. **Chat**:
   - Can ask about data
   - Gets responses with charts
   - No "401" errors

4. **Logs**:
   - Superset logs show `REMOTE_USER=your-email@domain.com`
   - No "Missing Authorization Header" errors
   - No "No X-Webauth-User header found" warnings
