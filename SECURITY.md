# 🔒 HYPERSET SECURITY HARDENING GUIDE

## Executive Summary

This guide provides comprehensive security hardening for both deployment modes:
- **Mode A**: `DEPLOY_WITH_SUPERSET=true` (Integrated Stack)
- **Mode B**: `DEPLOY_WITH_SUPERSET=false` (External Superset)

**Critical Security Level**: ⚠️ HIGH - Analytics platforms handle sensitive business data

---

## 📋 SECURITY CHECKLIST

### Phase 1: Pre-Deployment (CRITICAL)

- [ ] Run `./security-check.sh` - Must pass all checks
- [ ] Generate secure secrets using `./generate-secrets.sh`
- [ ] Change default domain from `hyperset.internal`
- [ ] Verify `.env` is NOT committed to git (in `.gitignore`)
- [ ] Set file permissions: `chmod 600 .env`
- [ ] Configure proper TLS certificates (not self-signed for production)
- [ ] Enable firewall rules (ports 80/443 only)
- [ ] Set up log aggregation and monitoring

### Phase 2: Deployment Security

- [ ] Deploy with read-only container filesystems where possible
- [ ] Enable Podman user namespace remapping
- [ ] Configure resource limits (CPU/Memory)
- [ ] Set up automatic security updates
- [ ] Enable container image scanning

### Phase 3: Runtime Security

- [ ] Configure automated backups
- [ ] Set up intrusion detection
- [ ] Enable audit logging
- [ ] Configure log rotation
- [ ] Set up alerting for suspicious activity

---

## 🔐 MODE A: Integrated Superset (`DEPLOY_WITH_SUPERSET=true`)

### Additional Security Considerations

#### Database Security
**Current Risk**: PostgreSQL uses weak credentials
**Impact**: CRITICAL - Database contains all analytics data

**Hardening Steps:**

1. **Change Database Password** (IMMEDIATE)
   ```bash
   # Generate strong password
   DB_PASSWORD=$(openssl rand -base64 32)
   
   # Update in .env
   sed -i "s/POSTGRES_PASSWORD=superset/POSTGRES_PASSWORD=${DB_PASSWORD}/" .env
   
   # Update in podman-compose.superset.yml
   sed -i "s/DATABASE_PASSWORD=superset/DATABASE_PASSWORD=${DB_PASSWORD}/" podman-compose.superset.yml
   sed -i "s/DB_PASS=superset/DB_PASS=${DB_PASSWORD}/" podman-compose.superset.yml
   ```

2. **Enable PostgreSQL SSL** (HIGH PRIORITY)
   Add to `podman-compose.superset.yml`:
   ```yaml
   superset-db:
     environment:
       - POSTGRES_SSL_MODE=require
       - POSTGRES_SSL_CERT=/var/lib/postgresql/server.crt
       - POSTGRES_SSL_KEY=/var/lib/postgresql/server.key
   ```

3. **Database Network Isolation** (MEDIUM PRIORITY)
   - Move database to separate internal network
   - Only allow connections from Superset service

#### Redis Security
**Current Risk**: Redis accessible without authentication
**Impact**: MEDIUM - Cache and session data exposure

**Hardening Steps:**

1. **Enable Redis Authentication**
   ```yaml
   superset-redis:
     environment:
       - REDIS_PASSWORD=${REDIS_PASSWORD:-$(openssl rand -base64 32)}
   ```

2. **Update Superset to use Redis auth**
   Add to `superset_config_docker.py`:
   ```python
   REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "")
   if REDIS_PASSWORD:
       CACHE_CONFIG['CACHE_REDIS_PASSWORD'] = REDIS_PASSWORD
   ```

#### Superset Application Security

1. **Enable Content Security Policy (CSP)**
   Update `superset_config_docker.py`:
   ```python
   TALISMAN_CONFIG = {
       "content_security_policy": {
           "default-src": ["'self'"],
           "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
           "style-src": ["'self'", "'unsafe-inline'"],
           "img-src": ["'self'", "data:", "https:"],
           "frame-ancestors": [_portal_origin],
       },
       "force_https": True,
   }
   ```

2. **Enable Session Security**
   ```python
   SESSION_COOKIE_HTTPONLY = True
   SESSION_COOKIE_SECURE = True
   SESSION_COOKIE_SAMESITE = "Lax"
   PERMANENT_SESSION_LIFETIME = 3600  # 1 hour
   ```

3. **Disable Dangerous Features in Production**
   ```python
   # Disable SQL Lab file uploads
   ALLOW_FILE_UPLOAD_TO_DATABASE = False
   
   # Restrict data export
   MAX_SQL_ROWS = 100000
   DISPLAY_MAX_ROW = 10000
   
   # Enable query cost estimation
   ENABLE_COST_ESTIMATE = True
   ```

---

## 🔐 MODE B: External Superset (`DEPLOY_WITH_SUPERSET=false`)

### Additional Security Considerations

#### External Superset Security
**Current Risk**: Communication with external Superset may be unencrypted
**Impact**: HIGH - Man-in-the-middle attacks possible

**Hardening Steps:**

1. **Enforce HTTPS Only**
   ```bash
   # Verify SUPERSET_UPSTREAM uses HTTPS
   if [[ "$SUPERSET_UPSTREAM" != https://* ]]; then
       echo "⚠️ WARNING: External Superset should use HTTPS"
   fi
   ```

2. **Certificate Pinning**
   Add certificate fingerprint validation in `superset_config_docker.py`:
   ```python
   # Pin external Superset certificate
   EXTERNAL_SUPERSET_CERT_PIN = os.getenv("EXTERNAL_SUPERSET_CERT_PIN", "")
   if EXTERNAL_SUPERSET_CERT_PIN:
       # Add certificate validation logic
       pass
   ```

3. **API Rate Limiting**
   Configure in external Superset:
   ```python
   RATELIMIT_STORAGE_URI = "redis://redis:6379/0"
   AUTH_RATE_LIMITED = True
   AUTH_RATE_LIMIT = "5 per minute"
   ```

#### Communication Security

1. **Mutual TLS (mTLS)**
   If both Hyperset and external Superset are under your control:
   - Enable client certificate authentication
   - Verify both server and client certificates

2. **API Key Rotation**
   - Rotate SUPerset MCP credentials every 90 days
   - Use service account with minimal permissions

---

## 🛡️ UNIVERSAL SECURITY CONTROLS

### 1. Network Security

#### Firewall Rules
```bash
# Allow only HTTPS traffic
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# Allow SSH (if needed for management)
sudo iptables -A INPUT -p tcp --dport 22 -s YOUR_IP/32 -j ACCEPT

# Drop all other incoming traffic
sudo iptables -P INPUT DROP
sudo iptables -P FORWARD DROP
```

#### Container Network Security
Add to `podman-compose.yml`:
```yaml
services:
  portal:
    networks:
      - hyperset-net
      - hyperset-public
    
  superset-mcp:
    networks:
      - hyperset-net
    # No public network - only internal communication

networks:
  hyperset-public:
    driver: bridge
    internal: false
  hyperset-net:
    driver: bridge
    internal: true  # Isolate from public
```

### 2. TLS Configuration

#### For Production (Let's Encrypt)
Update `Caddyfile`:
```
{$HYPERSET_DOMAIN} {
    tls {
        issuer acme {
            email admin@yourdomain.com
            # Production Let's Encrypt
        }
    }
    # ... rest of config
}
```

#### For Internal/Corporate (Custom CA)
```
{$HYPERSET_DOMAIN} {
    tls /path/to/cert.pem /path/to/key.pem
    # ... rest of config
}
```

### 3. Logging & Monitoring

#### Enable Audit Logging
Add to `superset_config_docker.py`:
```python
# Enable query audit logging
QUERY_LOGGER = {
    'logger': 'superset.query_logger',
    'level': 'INFO',
}

# Log all database queries
LOG_QUERIES = True
```

#### Security Event Monitoring
```python
# Alert on suspicious patterns
def security_event_handler(event):
    if event['type'] in ['failed_login', 'unauthorized_access']:
        # Send alert to security team
        send_security_alert(event)

SECURITY_EVENT_HANDLERS = [security_event_handler]
```

### 4. Backup & Recovery

#### Automated Backup Script
```bash
#!/bin/bash
# backup.sh - Run via cron daily

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/secure/backups/hyperset"

# Backup database
podman exec hyperset-superset-db pg_dump -U superset superset > "$BACKUP_DIR/db_$DATE.sql"

# Backup user data
tar -czf "$BACKUP_DIR/users_$DATE.tar.gz" Caddy/users.json

# Encrypt backups
openssl enc -aes-256-cbc -salt -in "$BACKUP_DIR/db_$DATE.sql" -out "$BACKUP_DIR/db_$DATE.sql.enc"
rm "$BACKUP_DIR/db_$DATE.sql"

# Keep only last 7 days
find "$BACKUP_DIR" -name "*.enc" -mtime +7 -delete
```

### 5. Vulnerability Management

#### Container Scanning
```bash
# Scan images before deployment
podman images | grep hyperset | awk '{print $3}' | while read image; do
    podman image inspect "$image" --format "{{.Names}}" | xargs trivy image
    podman image inspect "$image" --format "{{.Names}}" | xargs clairctl scan
    # Or use: docker scan, anchore, etc.
done
```

#### Dependency Updates
```bash
# Check for outdated dependencies
npm audit --prefix portal-app
pip-audit -r Superset-MCP/requirements.txt
```

---

## 🚨 SECURITY INCIDENT RESPONSE

### If Compromised:

1. **Immediate Actions** (First 5 minutes)
   ```bash
   # Isolate the system
   podman-compose down
   
   # Preserve logs
   cp -r /var/log/containers /secure/incident-$(date +%Y%m%d)
   ```

2. **Assessment** (Next 30 minutes)
   - Check access logs for unauthorized entries
   - Review database query logs for data exfiltration
   - Verify integrity of configuration files

3. **Recovery** (Next 24 hours)
   - Rotate ALL secrets (crypto keys, passwords, API keys)
   - Restore from clean backup
   - Patch vulnerabilities
   - Re-deploy with hardened configuration

---

## 🔄 REGULAR MAINTENANCE

**Weekly:**
- Review access logs for anomalies
- Check failed login attempts

**Monthly:**
- Rotate service account credentials
- Review and prune user access
- Update container images

**Quarterly:**
- Full security audit with `./security-check.sh`
- Penetration testing
- Disaster recovery drill

**Annually:**
- Full security review and architecture update
- Compliance audit (SOC2, ISO27001, etc.)

---

*Last Updated: March 2026*
