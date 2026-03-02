# =============================================================================
# superset_config_docker.py
# Hyperset-compatible Superset configuration
#
# Drop-in override loaded by the official Superset Docker Compose stack.
# The base config (superset_config.py) is still loaded first; this file
# only overrides what is needed for Hyperset header-based SSO.
#
# Includes workarounds for:
#   - https://github.com/apache/superset/issues/36117 (LocalProxy bug)
#   - Superset's SupersetAuthView shadowing FAB's authremoteuserview
#
# Strategy: FLASK_APP_MUTATOR installs a before_request hook that auto-logs
# in the user from REMOTE_USER on every request — including /login/.
#
# Role assignment: roles from the X-Webauth-Groups header are applied ONLY
# at user creation time. After that, roles are managed in Superset.
# =============================================================================

import os
import json
import logging

from flask import redirect, request, g, session
from flask_appbuilder.security.manager import AUTH_REMOTE_USER
from flask_login import login_user, current_user
from superset.security import SupersetSecurityManager

# ---------------------------------------------------------------------------
# Theme Configuration (Ant Design v5 Token-based Theming)
# ---------------------------------------------------------------------------
# Load custom theme from shared config
_THEME_CONFIG = {}
_THEME_PATH = "/app/pythonpath/theme.json"

try:
    if os.path.exists(_THEME_PATH):
        with open(_THEME_PATH, 'r') as f:
            _THEME_CONFIG = json.load(f)
        logging.info(f"[Theme] Loaded theme from {_THEME_PATH}")
    else:
        logging.warning(f"[Theme] theme.json not found at {_THEME_PATH}")
except Exception as e:
    logging.error(f"[Theme] Error loading theme: {e}")

# Extract Superset theme configuration
_SUPERSET_THEME = _THEME_CONFIG.get("superset", {})
_SUPERSET_COLORS = _SUPERSET_THEME.get("colors", {})

# Build THEME_DEFAULT with Ant Design v5 tokens
if _SUPERSET_THEME.get("enabled", True) and _SUPERSET_COLORS:
    _primary = _SUPERSET_COLORS.get("primary", "#FF6B35")
    _primary_dark = _SUPERSET_COLORS.get("primaryDark", "#E85A2D")
    _secondary = _SUPERSET_COLORS.get("secondary", "#2D3748")
    
    logging.info(f"[Theme] Applying Ant Design theme - primary: {_primary}")
    
    THEME_DEFAULT = {
        "token": {
            # Primary color (buttons, links, accents)
            "colorPrimary": _primary,
            "colorPrimaryHover": _primary_dark,
            "colorPrimaryActive": _primary_dark,
            "colorPrimaryText": _primary,
            "colorPrimaryTextHover": _primary_dark,
            
            # Success, warning, error colors
            "colorSuccess": "#48BB78",
            "colorWarning": "#ED8936",
            "colorError": "#F56565",
            "colorInfo": "#4299E1",
            
            # Background colors
            "colorBgBase": "#FFFFFF",
            "colorBgContainer": "#FFFFFF",
            "colorBgElevated": "#FFFBF7",
            "colorBgLayout": "#FFFBF7",
            
            # Text colors
            "colorText": "#1A202C",
            "colorTextSecondary": "#718096",
            "colorTextTertiary": "#A0AEC0",
            
            # Border colors
            "colorBorder": "#FFF5EE",
            "colorBorderSecondary": "#FFF8F0",
            
            # Border radius
            "borderRadius": 8,
            "borderRadiusLG": 12,
            "borderRadiusSM": 4,
            
            # Typography
            "fontFamily": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            "fontFamilyCode": "'Fira Code', Monaco, Consolas, monospace",
        }
    }
    
    # Enable theme administration in UI
    ENABLE_UI_THEME_ADMINISTRATION = True
    
    logging.info(f"[Theme] THEME_DEFAULT configured with {len(THEME_DEFAULT['token'])} tokens")
else:
    logging.info("[Theme] Using default Superset theme (no custom colors found)")
    THEME_DEFAULT = {}
    ENABLE_UI_THEME_ADMINISTRATION = True

# ---------------------------------------------------------------------------
# Authentication — trust the X-Webauth-User header set by Caddy/Hyperset
# ---------------------------------------------------------------------------
AUTH_TYPE = AUTH_REMOTE_USER

# Disable recaptcha (Superset 6.0 enables it by default)
RECAPTCHA_PUBLIC_KEY = ""
RECAPTCHA_PRIVATE_KEY = ""

REMOTE_USER_ENV_VAR = "HTTP_X_WEBAUTH_USER"

AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Gamma"  # fallback if no role header present

# Do NOT sync roles on every login — only set at creation
AUTH_ROLES_SYNC_AT_LOGIN = False

AUTH_ROLES_MAPPING = {
    os.getenv("HYPERSET_ADMIN_ROLE_HEADER", "hyperset/admin"): ["Admin"],
    os.getenv("HYPERSET_USER_ROLE_HEADER", "hyperset/user"):   ["Gamma"],
}

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------

# Fix 8: SECRET_KEY must be set to a strong random value — never a placeholder.
_secret_key = os.getenv("SECRET_KEY") or os.getenv("SUPERSET_SECRET_KEY", "")
_known_placeholders = {"CHANGE_ME_IN_PRODUCTION", "change_me_in_production", ""}
if not _secret_key or _secret_key in _known_placeholders:
    raise RuntimeError(
        "SECRET_KEY (or SUPERSET_SECRET_KEY) must be set to a strong random value. "
        "Generate one with: openssl rand -base64 42"
    )
SECRET_KEY = _secret_key

# Fix 7: CORS must be locked to the portal origin — never a wildcard.
# Set HYPERSET_ORIGIN explicitly (e.g. https://hyperset.internal), or derive
# it from HYPERSET_DOMAIN. A wildcard '*' is rejected to prevent cross-origin
# credential leakage regardless of the CSRF state.
_hyperset_domain = os.getenv("HYPERSET_DOMAIN", "")
_portal_origin = (
    os.getenv("HYPERSET_ORIGIN")
    or (f"https://{_hyperset_domain}" if _hyperset_domain else None)
)
if not _portal_origin:
    raise RuntimeError(
        "HYPERSET_ORIGIN or HYPERSET_DOMAIN must be set so that the Superset "
        "CORS policy can be restricted to the portal's origin. "
        "Example: HYPERSET_ORIGIN=https://hyperset.internal"
    )
if _portal_origin == "*":
    raise RuntimeError(
        "HYPERSET_ORIGIN must be an explicit origin (e.g. https://hyperset.internal), "
        "not the wildcard '*'. A wildcard with credentials is rejected by browsers "
        "and creates a CORS vulnerability."
    )

ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": [
        "Content-Type",
        "X-CSRFToken",
        "X-Webauth-User",
        "X-Webauth-Email",
        "X-Webauth-Groups",
    ],
    "resources": ["/api/*"],
    "origins": [_portal_origin],
}

HTTP_HEADERS = {
    "X-Frame-Options": os.getenv("SUPERSET_FRAME_OPTIONS", "ALLOWALL"),
    "Content-Security-Policy": (
        "frame-ancestors 'self' "
        + _portal_origin
    ),
}

# Fix 6: Re-enable CSRF protection.
# The MCP server already fetches a CSRF token from /api/v1/security/csrf_token/
# before every state-changing request and sends it in the X-CSRFToken header,
# so API calls continue to work with CSRF enabled.
WTF_CSRF_ENABLED = True

# ---------------------------------------------------------------------------
# Embedded / guest token support
# ---------------------------------------------------------------------------
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
    "ALERT_REPORTS": True,
}

# ---------------------------------------------------------------------------
# Cache (Redis)
# ---------------------------------------------------------------------------
REDIS_HOST     = os.getenv("REDIS_HOST", "redis")
REDIS_PORT     = int(os.getenv("REDIS_PORT", "6379"))
REDIS_CELERY_DB = int(os.getenv("REDIS_CELERY_DB", "0"))
REDIS_RESULTS_DB = int(os.getenv("REDIS_RESULTS_DB", "1"))
REDIS_CACHE_DB   = int(os.getenv("REDIS_CACHE_DB", "2"))

CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_HOST": REDIS_HOST,
    "CACHE_REDIS_PORT": REDIS_PORT,
    "CACHE_REDIS_DB": REDIS_CACHE_DB,
}

DATA_CACHE_CONFIG = CACHE_CONFIG.copy()
DATA_CACHE_CONFIG["CACHE_KEY_PREFIX"] = "superset_data_"
DATA_CACHE_CONFIG["CACHE_REDIS_DB"] = REDIS_RESULTS_DB

class CeleryConfig:
    broker_url     = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_CELERY_DB}"
    result_backend = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_RESULTS_DB}"

CELERY_CONFIG = CeleryConfig

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
# Use DATABASE_* env vars (set in podman-compose.superset.yml)
DB_HOST     = os.getenv("DATABASE_HOST", "hyperset-superset-db")
DB_PORT     = os.getenv("DATABASE_PORT", "5432")
DB_NAME     = os.getenv("DATABASE_DB", "superset")
DB_USER     = os.getenv("DATABASE_USER", "superset")
DB_PASS     = os.getenv("DATABASE_PASSWORD", "superset")

SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

# ---------------------------------------------------------------------------
# Proxy fix — Superset sits behind Caddy
# ---------------------------------------------------------------------------
ENABLE_PROXY_FIX = True
PROXY_FIX_CONFIG = {
    "x_for":    1,
    "x_proto":  1,
    "x_host":   1,
    "x_port":   1,
    "x_prefix": 1,
}

# ---------------------------------------------------------------------------
# Middleware — forward X-Webauth-User header to REMOTE_USER
# ---------------------------------------------------------------------------
class HypersetRemoteUserMiddleware:
    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        user = environ.get("HTTP_X_WEBAUTH_USER", "")
        if user:
            environ["REMOTE_USER"] = user
            logger.info(f"[Middleware] Set REMOTE_USER={user} from X-Webauth-User header")
        else:
            logger.warning(f"[Middleware] No X-Webauth-User header found! Headers: {dict((k,v) for k,v in environ.items() if k.startswith('HTTP_'))}")
        return self.app(environ, start_response)

ADDITIONAL_MIDDLEWARE = [HypersetRemoteUserMiddleware]

# ---------------------------------------------------------------------------
# Custom Security Manager — patches auth_user_remote_user to avoid
# the LocalProxy bug in Superset 6.0 (issue #36117)
#
# Reads X-Webauth-Groups header at creation time to determine initial role.
# After creation, roles are managed in Superset (AUTH_ROLES_SYNC_AT_LOGIN=False).
# ---------------------------------------------------------------------------
class HypersetSecurityManager(SupersetSecurityManager):

    def _resolve_initial_role(self):
        """
        Read the X-Webauth-Groups header (space-separated roles from Caddy)
        and return the highest-privilege Superset role.
        Falls back to AUTH_USER_REGISTRATION_ROLE if no match.
        """
        roles_header = request.environ.get("HTTP_X_WEBAUTH_GROUPS", "")
        caddy_roles = roles_header.split() if roles_header else []

        # Check for admin first (highest privilege wins)
        admin_key = os.getenv("HYPERSET_ADMIN_ROLE_HEADER", "hyperset/admin")
        user_key = os.getenv("HYPERSET_USER_ROLE_HEADER", "hyperset/user")

        role = None
        if admin_key in caddy_roles:
            role = self.find_role("Admin")
        elif user_key in caddy_roles:
            role = self.find_role("Gamma")

        # Fallback to default registration role
        if role is None:
            default_role_name = self.auth_user_registration_role
            role = self.find_role(default_role_name)
            logger.info(f"[SecurityManager] Using default role: {default_role_name}")
        
        if role is None:
            # Last resort - create/find the Gamma role
            logger.error(f"[SecurityManager] Could not find any role! Attempting to use Gamma...")
            role = self.find_role("Gamma") or self.find_role("Public")
        
        logger.info(f"[SecurityManager] Resolved role: {role}")
        return role

    def auth_user_remote_user(self, username):
        """
        Override that avoids passing g.user (a LocalProxy) to session.add().
        On first login (user creation), reads roles from Caddy header.
        On subsequent logins, just logs in without touching roles.
        
        NOTE: AUTH_ROLES_SYNC_AT_LOGIN = False means roles are set ONLY at 
        user creation time. After that, roles are managed in Superset UI
        and won't be overwritten by SSO headers on subsequent logins.
        """
        logger.info(f"[SecurityManager] auth_user_remote_user called with username={username}")
        user = self.find_user(username=username)
        
        if user is None and self.auth_user_registration:
            # New user — resolve role from Caddy header
            initial_role = self._resolve_initial_role()
            logger.info(f"[SecurityManager] Creating new user={username} with role={initial_role}")
            
            # Safety check - ensure we have a valid role
            if initial_role is None:
                logger.error(f"[SecurityManager] ERROR: No role found for new user {username}! Using Gamma.")
                initial_role = self.find_role("Gamma")
            
            # Extract email from header if available
            email = request.environ.get("HTTP_X_WEBAUTH_EMAIL", "")
            if not email:
                email = f"{username}@hyperset.local"
            
            # Create the user
            try:
                user = self.add_user(
                    username=username,
                    first_name=username.split("@")[0].title(),
                    last_name="",
                    email=email,
                    role=initial_role,
                )
                logger.info(f"[SecurityManager] Created user={username}, id={user.id if user else 'FAILED'}")
            except Exception as e:
                logger.error(f"[SecurityManager] ERROR creating user {username}: {e}")
                raise
        else:
            logger.info(f"[SecurityManager] Found existing user={username}, user={user}")
        
        if user:
            login_user(user)
            g.user = user
            logger.info(f"[SecurityManager] Logged in user={username}")
        else:
            logger.error(f"[SecurityManager] Failed to login user={username}")
        return user

CUSTOM_SECURITY_MANAGER = HypersetSecurityManager

# ---------------------------------------------------------------------------
# FLASK_APP_MUTATOR — installs a before_request hook that:
#   1. Reads REMOTE_USER (set by the WSGI middleware above)
#   2. Logs the user in via our patched auth_user_remote_user
#   3. Redirects /login/ to the index if already authenticated
# ---------------------------------------------------------------------------
def FLASK_APP_MUTATOR(app):
    logger.info("[FLASK_APP_MUTATOR] Installing before_request hook")

    @app.before_request
    def hyperset_auto_login():
        # Skip static files
        if request.path.startswith("/static"):
            return None

        remote_user = request.environ.get("REMOTE_USER", "")
        logger.info(f"[AutoLogin] path={request.path}, REMOTE_USER={remote_user}, current_user={current_user}")
        
        if not remote_user:
            logger.warning(f"[AutoLogin] No REMOTE_USER found for path={request.path}")
            return None

        # Already logged in as the correct user — nothing to do
        if current_user and current_user.is_authenticated:
            if current_user.username == remote_user:
                logger.info(f"[AutoLogin] Already logged in as {remote_user}")
                if request.path.rstrip("/") == "/login":
                    return redirect("/superset/welcome/")
                return None

        # Log the user in
        sm = app.appbuilder.sm
        user = sm.auth_user_remote_user(remote_user)
        if user:
            login_user(user)
            g.user = user
            logger.info(f"[AutoLogin] Successfully logged in {remote_user}")

            if request.path.rstrip("/") == "/login":
                next_url = request.args.get("next", "/superset/welcome/")
                # Guard against open redirects — only allow same-origin paths
                if not next_url.startswith("/") or next_url.startswith("//"):
                    next_url = "/superset/welcome/"
                return redirect(next_url)
        else:
            logger.error(f"[AutoLogin] Failed to auth user {remote_user}")

        return None

# ---------------------------------------------------------------------------
# Logging and Debug
# ---------------------------------------------------------------------------
import logging
logger = logging.getLogger(__name__)
logger.info("=== Hyperset Superset Config Loaded ===")
logger.info(f"AUTH_TYPE: {AUTH_TYPE}")
logger.info(f"REMOTE_USER_ENV_VAR: {REMOTE_USER_ENV_VAR}")
logger.info(f"AUTH_USER_REGISTRATION: {AUTH_USER_REGISTRATION}")
logger.info(f"CUSTOM_SECURITY_MANAGER: HypersetSecurityManager")
logger.info(f"ADDITIONAL_MIDDLEWARE: {ADDITIONAL_MIDDLEWARE}")
logger.info(f"ENABLE_CORS: {ENABLE_CORS}")
logger.info(f"CORS origins: {_portal_origin}")

# Theme logging
if _SUPERSET_THEME.get("enabled", False) and _SUPERSET_COLORS:
    logger.info(f"[Theme] Superset theming enabled with primary color: {_SUPERSET_COLORS.get('primary', 'N/A')}")
    if 'THEME_DEFAULT' in globals() and THEME_DEFAULT:
        logger.info(f"[Theme] THEME_DEFAULT configured with {len(THEME_DEFAULT.get('token', {}))} tokens")
else:
    logger.info("[Theme] Using default Superset theme")

logger.info("=========================================")

LOG_LEVEL = logging.INFO
