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
import sys

# Confirm this config file is being loaded
print("[Config] superset_config_docker.py is being loaded", flush=True)
logging.info("[Config] superset_config_docker.py is being loaded")

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

# Extract theme configuration from simplified light/dark structure
_LIGHT_THEME = _THEME_CONFIG.get("light", {})
_DARK_THEME = _THEME_CONFIG.get("dark", {})

print(f"[Theme] ===== THEME CONFIG LOADING =====", flush=True)
print(f"[Theme] Loaded theme.json: {_THEME_CONFIG.get('name', 'Unknown')}", flush=True)
print(f"[Theme] Light theme fields: {list(_LIGHT_THEME.keys()) if _LIGHT_THEME else 'None'}", flush=True)
sys.stdout.flush()

# Build THEME_DEFAULT with Ant Design v5 tokens using simplified light/dark structure
if _LIGHT_THEME:
    logging.info("[Theme] Building themes from simplified light/dark structure")
    
    # Light mode colors - directly from theme.json "light" section
    _primary = _LIGHT_THEME.get("primary", "#D35400")
    _primary_hover = _LIGHT_THEME.get("primaryHover", "#A04000")
    _text = _LIGHT_THEME.get("textPrimary", "#1F2937")
    _text_secondary = _LIGHT_THEME.get("textSecondary", "#4B5563")
    _text_muted = _LIGHT_THEME.get("textMuted", "#6B7280")
    _text_placeholder = _LIGHT_THEME.get("textMuted", "#9CA3AF")  # Use textMuted for placeholders
    _bg_light = _LIGHT_THEME.get("background", "#F8F9FA")
    _surface_light = _LIGHT_THEME.get("surface", "#FFFFFF")
    _border_light = _LIGHT_THEME.get("border", "#DEE2E6")
    _border_secondary_light = _LIGHT_THEME.get("border", "#E5E7EB")  # Slightly lighter variant
    
    # State colors from light theme
    _success = _LIGHT_THEME.get("success", "#059669")
    _warning = _LIGHT_THEME.get("warning", "#D97706")
    _error = _LIGHT_THEME.get("error", "#DC2626")
    _info = _LIGHT_THEME.get("primary", "#D35400")  # Use primary for info
    
    logging.info(f"[Theme] Light mode - primary: {_primary}, text: {_text}")
    
    # Build light theme tokens
    THEME_DEFAULT_TOKENS = {
        "colorPrimary": _primary,
        "colorPrimaryHover": _primary_hover,
        "colorPrimaryActive": _primary_hover,
        "colorPrimaryText": _text,
        "colorPrimaryTextHover": _primary,
        "colorLink": _primary_hover,
        "colorLinkHover": _primary,
        "colorLinkActive": _primary_hover,
        "colorSuccess": _primary,  # Use primary orange for success icons (checkmarks in Published badges)
        # Explicit success tokens — give Published badge a clearly filled warm
        # background so it's visually distinct from Draft's outline-only style
        "colorSuccessBg": "#FFF7ED",  # Light warm background for success badges
        "colorSuccessBgHover": "#FFE8D0",
        "colorSuccessBorder": "#F5A070",
        "colorSuccessText": _primary,  
        "colorSuccessTextHover": _primary_hover,
        "colorWarning": _warning,
        "colorError": _error,
        "colorInfo": _info,
        # Alert/Message warning colors — ensure dark text on light backgrounds for readability
        "colorWarningText": _text,  # Dark text for warning alerts/messages
        "colorWarningBg": "#FEF3C7",  # Light yellow background
        "colorWarningBorder": "#FCD34D",
        # Explicit primary bg tokens for light mode — prevents Ant Design from auto-deriving
        # orange backgrounds for buttons (Favorite/Mine/All tabs) to align with neutral theme
        "colorPrimaryBg": "#F5F5F5",
        "colorPrimaryBgHover": "#E5E5E5",
        "colorPrimaryBorder": "#D4D4D4",
        "colorBgBase": _surface_light,
        "colorBgContainer": _surface_light,
        "colorBgElevated": _bg_light,
        "colorBgLayout": _bg_light,
        "colorBgSpotlight": _bg_light,
        "colorText": _text,
        "colorTextSecondary": _text_secondary,
        "colorTextTertiary": _text_muted,
        "colorTextPlaceholder": _text_placeholder,
        "colorBorder": _border_light,
        "colorBorderSecondary": _border_secondary_light,
        "borderRadius": 8,
        "borderRadiusLG": 12,
        "borderRadiusSM": 4,
        "fontFamily": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "fontFamilyCode": "'Fira Code', Monaco, Consolas, monospace",
    }
    
    THEME_DEFAULT = {"token": THEME_DEFAULT_TOKENS}
    
    # Dark mode colors - directly from theme.json "dark" section
    _primary_dark_mode = _DARK_THEME.get("primary", "#FF8A5C")
    _primary_dark_hover = _DARK_THEME.get("primaryHover", "#FF6B35")
    _text_dark = _DARK_THEME.get("textPrimary", "#FAFAFA")
    _text_secondary_dark = _DARK_THEME.get("textSecondary", "#E5E5E5")
    _text_muted_dark = _DARK_THEME.get("textMuted", "#A3A3A3")
    _text_placeholder_dark = _DARK_THEME.get("textMuted", "#737373")  # Use textMuted for placeholders
    _text_inverse_dark = "#0A0A0A"  # Dark text for light backgrounds
    _bg_dark = _DARK_THEME.get("background", "#0A0A0A")
    _surface_dark = _DARK_THEME.get("surface", "#141414")
    _surface_higher_dark = "#1C1C1C"  # Slightly lighter surface for elevation
    _border_dark = _DARK_THEME.get("border", "#404040")
    _border_secondary_dark = "#525252"  # Slightly lighter border
    
    # State colors from dark theme
    _success_dark = _DARK_THEME.get("success", "#34D399")
    _warning_dark = _DARK_THEME.get("warning", "#FBBF24")
    _error_dark = _DARK_THEME.get("error", "#F87171")
    _info_dark = _DARK_THEME.get("primary", "#FF8A5C")  # Use primary for info
    
    logging.info(f"[Theme] Dark mode - primary: {_primary_dark_mode}, bg: {_bg_dark}, text: {_text_dark}")
    
    THEME_DARK_TOKENS = {
        "colorPrimary": _primary_dark_mode,
        "colorPrimaryHover": _primary_dark_hover,
        "colorPrimaryActive": _primary_dark_hover,
        "colorPrimaryText": _primary_dark_mode,
        "colorPrimaryTextHover": _primary_dark_hover,
        "colorLink": _primary_dark_mode,
        "colorLinkHover": _primary_dark_hover,
        "colorLinkActive": _primary_dark_hover,
        "colorSuccess": _primary_dark_mode,  # Use primary orange for success icons (checkmarks in Published badges)
        # Explicit success badge tokens — prevents Ant Design from auto-generating
        # a blinding light background in dark mode (Published tag, etc.)
        "colorSuccessBg": "#2D1608",  # Dark warm background for success badges
        "colorSuccessBgHover": "#3D2010",
        "colorSuccessBorder": "#5A2D10",
        "colorSuccessText": _primary_dark_mode,  
        "colorSuccessTextHover": _primary_dark_hover,
        # Explicit primary bg tokens — prevents Ant Design from auto-deriving
        # near-white from colorPrimary=#FF8A5C (Physical badge, All tab, buttons)
        "colorPrimaryBg": "#241205",
        "colorPrimaryBgHover": "#341A08",
        "colorPrimaryBorder": "#5C2E0A",
        # Fill tokens — prevents default tags and fills from auto-deriving
        # light backgrounds (Draft badge, general surfaces in dark mode)
        "colorFill": "#303030",
        "colorFillSecondary": "#262626",
        "colorFillTertiary": "#1E1E1E",
        "colorFillQuaternary": "#181818",
        "colorFillContent": "#242424",
        "colorFillAlter": "#1A1A1A",
        "colorWarning": _warning_dark,
        "colorError": _error_dark,
        "colorInfo": _info_dark,
        # Alert/Message warning colors — ensure light text on dark backgrounds for readability
        "colorWarningText": _text_dark,  # Light text for warning alerts/messages
        "colorWarningBg": "#78350F",  # Dark amber background
        "colorWarningBorder": "#92400E",
        "colorBgBase": _bg_dark,
        "colorBgContainer": _surface_dark,
        "colorBgElevated": _surface_higher_dark,
        "colorBgLayout": _bg_dark,
        "colorBgSpotlight": _surface_higher_dark,
        "colorText": _text_dark,
        "colorTextSecondary": _text_secondary_dark,
        "colorTextTertiary": _text_muted_dark,
        "colorTextPlaceholder": _text_placeholder_dark,
        "colorBorder": _border_dark,
        "colorBorderSecondary": _border_secondary_dark,
        "borderRadius": 8,
        "borderRadiusLG": 12,
        "borderRadiusSM": 4,
        "fontFamily": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "fontFamilyCode": "'Fira Code', Monaco, Consolas, monospace",
    }
    
    # Add component-specific overrides
    THEME_DARK_COMPONENTS = {
        "Tag": {
            # Default (uncolored) tags — Draft badge, Virtual badge, etc.
            "defaultBg": "#1E1E1E",
            "defaultColor": _primary_dark_mode,
        },
        "Button": {
            "colorPrimary": _primary_dark_mode,
            "colorPrimaryText": _text_inverse_dark,
            "colorPrimaryTextHover": _text_inverse_dark,
            "colorPrimaryTextActive": _text_inverse_dark,
            "defaultColor": _text_dark,
            "defaultBg": _surface_higher_dark,
            "defaultBorderColor": _border_dark,
            "defaultHoverBg": "#3E3E43",
            "defaultHoverColor": _text_dark,
            "defaultHoverBorderColor": "#505050",
            "ghostColor": _text_dark,
            "ghostHoverColor": _primary_dark_mode,
            "ghostBg": "transparent",
            "ghostHoverBg": "rgba(255, 138, 92, 0.1)",
            "ghostBorderColor": _border_dark,
            "ghostHoverBorderColor": _primary_dark_mode,
        }
    }
    
    THEME_DARK = {
        "token": THEME_DARK_TOKENS,
        "components": THEME_DARK_COMPONENTS
    }
    
    # Theme configuration
    ENABLE_UI_THEME_ADMINISTRATION = False
    PRELOAD_PERMSSIONS = True
    THEME_MODEL_DEFAULT = "default"
    THEME_MODEL_DARK = "dark"
    
    THEME_OVERRIDES = {
        "default": THEME_DEFAULT,
        "dark": THEME_DARK
    }
    
    # Ensure themes are available globally
    globals()['THEME_DEFAULT'] = THEME_DEFAULT
    globals()['THEME_DARK'] = THEME_DARK
    globals()['THEME_OVERRIDES'] = THEME_OVERRIDES
    
    print(f"[Theme] Themes created - Default: {len(THEME_DEFAULT_TOKENS)} tokens, Dark: {len(THEME_DARK_TOKENS)} tokens", flush=True)
    logging.info(f"[Theme] Themes configured successfully")
else:
    logging.info("[Theme] Using default Superset theme (no palette found)")
    THEME_DEFAULT = {}
    THEME_DARK = {}
    THEME_OVERRIDES = {}
    ENABLE_UI_THEME_ADMINISTRATION = False

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
    "X-Content-Type-Options": "nosniff",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}

# Fix 6: Re-enable CSRF protection.
# The MCP server already fetches a CSRF token from /api/v1/security/csrf_token/
# before every state-changing request and sends it in the X-CSRFToken header,
# so API calls continue to work with CSRF enabled.
WTF_CSRF_ENABLED = True

# ---------------------------------------------------------------------------
# Session Security - Prevent session hijacking and enforce secure cookies
# Note: These require HTTPS to be fully functional
# ---------------------------------------------------------------------------
# SESSION_COOKIE_SECURE = True  # Uncomment when using HTTPS
# SESSION_COOKIE_HTTPONLY = True  # Uncomment when using HTTPS
# SESSION_COOKIE_SAMESITE = "Lax"  # Uncomment when using HTTPS

# ---------------------------------------------------------------------------
# Embedded / guest token support
# ---------------------------------------------------------------------------
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
    "ALERT_REPORTS": True,
}

# ---------------------------------------------------------------------------
# Force all links to use orange color (overrides any custom CSS)
# ---------------------------------------------------------------------------
EXTRA_CSS = """
/* Chart colors - blue to orange */
.superset-chart svg path[fill="#1E90FF"],
.superset-chart svg path[fill="#1890ff"] {
    fill: #FF8A5C;
}

/* Link buttons */
[class*="ant-btn-color-primary"][class*="ant-btn-variant-link"] {
    color: #FF8A5C;
}
"""

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

# Dark mode CSS to inject into HTML responses
DARK_MODE_CSS = """
<style id="hyperset-dark-mode-fix">
/* Modern thin scrollbar - matches chat panel style */
::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

::-webkit-scrollbar-track {
    background: transparent;
}

::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 10px;
}

::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.4);
}

* {
    scrollbar-width: thin;
    scrollbar-color: rgba(0, 0, 0, 0.25) transparent;
}

/* Dark mode overrides */
@media (prefers-color-scheme: dark) {
    ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.25);
    }

    ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.4);
    }

    * {
        scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
    }

    /* Chart colors - blue to orange */
    .superset-chart svg *[fill="#1E90FF"],
    .superset-chart svg *[fill="#1890ff"] {
        fill: #FF8A5C;
    }

    /* Fix: Link variant buttons should show primary color, not primaryText color */
    .ant-btn-color-primary.ant-btn-variant-link,
    [class*="ant-btn-color-primary"][class*="ant-btn-variant-link"] {
        color: #FF8A5C;
    }

    .ant-btn-color-primary.ant-btn-variant-link:hover,
    [class*="ant-btn-color-primary"][class*="ant-btn-variant-link"]:hover {
        color: #FFB088;
    }
}
</style>
"""

# ---------------------------------------------------------------------------
# FLASK_APP_MUTATOR — installs a before_request hook that:
#   1. Reads REMOTE_USER (set by the WSGI middleware above)
#   2. Logs the user in via our patched auth_user_remote_user
#   3. Redirects /login/ to the index if already authenticated
#   4. Injects dark mode CSS into HTML responses
# ---------------------------------------------------------------------------
def FLASK_APP_MUTATOR(app):
    logger.info("[FLASK_APP_MUTATOR] Installing before_request hook")
    
    # Debug: Log theme configuration
    logger.info(f"[FLASK_APP_MUTATOR] THEME_DEFAULT present: {'THEME_DEFAULT' in globals()}")
    logger.info(f"[FLASK_APP_MUTATOR] THEME_DARK present: {'THEME_DARK' in globals()}")
    if 'THEME_DARK' in globals():
        logger.info(f"[FLASK_APP_MUTATOR] THEME_DARK content: {THEME_DARK}")
    if 'THEME_OVERRIDES' in globals():
        logger.info(f"[FLASK_APP_MUTATOR] THEME_OVERRIDES keys: {list(THEME_OVERRIDES.keys())}")
    
    # Add a debug endpoint to check theme config
    @app.route('/debug/theme')
    def debug_theme():
        from flask import Response
        import json
        theme_info = {
            'THEME_DEFAULT_present': 'THEME_DEFAULT' in globals(),
            'THEME_DARK_present': 'THEME_DARK' in globals(),
            'THEME_OVERRIDES_present': 'THEME_OVERRIDES' in globals(),
        }
        if 'THEME_DARK' in globals():
            theme_info['THEME_DARK'] = THEME_DARK
            theme_info['THEME_DARK_keys'] = list(THEME_DARK.keys()) if THEME_DARK else []
        if 'THEME_DEFAULT' in globals():
            theme_info['THEME_DEFAULT'] = THEME_DEFAULT
            theme_info['THEME_DEFAULT_keys'] = list(THEME_DEFAULT.keys()) if THEME_DEFAULT else []
        return Response(json.dumps(theme_info, indent=2), mimetype='application/json')

    @app.after_request
    def inject_dark_mode_css(response):
        """Inject dark mode CSS into HTML responses"""
        if response.content_type and 'text/html' in response.content_type:
            try:
                html = response.get_data(as_text=True)
                import re
                if re.search(r'</head>', html, re.IGNORECASE):
                    html = re.sub(r'</head>', DARK_MODE_CSS + '\n<script src="/bridge.js"></script>\n</head>', html, flags=re.IGNORECASE)
                elif re.search(r'</body>', html, re.IGNORECASE):
                    html = re.sub(r'</body>', DARK_MODE_CSS + '\n<script src="/bridge.js"></script>\n</body>', html, flags=re.IGNORECASE)
                response.set_data(html)
                logger.debug("[Theme] Injected dark mode CSS")
            except Exception as e:
                logger.error(f"[Theme] Error injecting CSS: {e}")
        return response

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
# Audit Logging - Track user actions and queries for security compliance
# ---------------------------------------------------------------------------
AUDIT_LOG_ENABLED = True
QUERY_SEARCH_LIMIT = 1000
SQLLAB_ASYNC_TIME_LIMIT_SEC = 60 * 60  # 1 hour

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
if _LIGHT_THEME and _DARK_THEME:
    logger.info(f"[Theme] Custom theming enabled")
    logger.info(f"[Theme] Light primary: {_LIGHT_THEME.get('primary', 'N/A')}, Dark primary: {_DARK_THEME.get('primary', 'N/A')}")
    if 'THEME_DEFAULT' in globals() and THEME_DEFAULT:
        logger.info(f"[Theme] THEME_DEFAULT configured with {len(THEME_DEFAULT.get('token', {}))} tokens")
    if 'THEME_DARK' in globals() and THEME_DARK:
        logger.info(f"[Theme] THEME_DARK configured with {len(THEME_DARK.get('token', {}))} tokens")
    else:
        logger.warning("[Theme] THEME_DARK not configured!")
else:
    logger.info("[Theme] Using default Superset theme")

logger.info("=========================================")

LOG_LEVEL = logging.INFO
