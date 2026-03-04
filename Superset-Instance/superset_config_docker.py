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

# Extract Superset theme configuration
_SUPERSET_THEME = _THEME_CONFIG.get("superset", {})
_SUPERSET_COLORS = _SUPERSET_THEME.get("colors", {})
_SUPERSET_COLORS_DARK = _SUPERSET_THEME.get("colorsDark", {})

print(f"[Theme] ===== THEME CONFIG LOADING =====", flush=True)
print(f"[Theme] Loaded theme.json: {_THEME_CONFIG.get('name', 'Unknown')}", flush=True)
print(f"[Theme] Superset enabled: {_SUPERSET_THEME.get('enabled', False)}", flush=True)
print(f"[Theme] Colors loaded: {bool(_SUPERSET_COLORS)}", flush=True)
print(f"[Theme] ColorsDark loaded: {bool(_SUPERSET_COLORS_DARK)}", flush=True)
print(f"[Theme] colorsDark content: {_SUPERSET_COLORS_DARK}", flush=True)
sys.stdout.flush()

logging.info(f"[Theme] Loaded colorsDark: {_SUPERSET_COLORS_DARK}")

# Build THEME_DEFAULT with Ant Design v5 tokens
if _SUPERSET_THEME.get("enabled", True) and _SUPERSET_COLORS:
    _primary = _SUPERSET_COLORS.get("primary", "#FF6B35")
    _primary_dark = _SUPERSET_COLORS.get("primaryDark", "#E85A2D")
    _secondary = _SUPERSET_COLORS.get("secondary", "#2D3748")
    
    # Text colors - controllable via theme.json (default to black/dark)
    _text = _SUPERSET_COLORS.get("text", "#000000")  # Main text - black
    _text_secondary = _SUPERSET_COLORS.get("textSecondary", "#4A5568")  # Secondary text
    _text_muted = _SUPERSET_COLORS.get("textMuted", "#718096")  # Muted text
    
    # Link colors - controllable via theme.json (default to dark orange/brown)
    _link = _SUPERSET_COLORS.get("link", "#E85A2D")  # Clickable links - dark orange
    _link_hover = _SUPERSET_COLORS.get("linkHover", "#FF6B35")  # Link hover - bright orange
    
    logging.info(f"[Theme] Applying Ant Design theme - primary: {_primary}, text: {_text}, link: {_link}")
    
    # Build light theme tokens
    THEME_DEFAULT_TOKENS = {
        # Primary color (buttons, accents)
        "colorPrimary": _primary,
        "colorPrimaryHover": _primary_dark,
        "colorPrimaryActive": _primary_dark,
        
        # Primary text - use dark text instead of orange for better readability
        "colorPrimaryText": _text,
        "colorPrimaryTextHover": _link,
        
        # Link colors - for clickable text
        "colorLink": _link,
        "colorLinkHover": _link_hover,
        "colorLinkActive": _primary_dark,
        
        # Success, warning, error colors
        "colorSuccess": "#48BB78",
        "colorWarning": "#ED8936",
        "colorError": "#F56565",
        "colorInfo": _link,  # Use link color instead of blue
        
        # Background colors - subtle variation for visual separation
        "colorBgBase": "#FFFFFF",
        "colorBgContainer": "#FFFFFF",
        "colorBgElevated": "#FAFAFA",  # Slightly off-white for elevated elements
        "colorBgLayout": "#F5F5F5",  # Light gray for main layout background
        "colorBgSpotlight": "#F0F0F0",  # Subtle gray for highlighted areas
        
        # Text colors - now controllable via theme.json
        "colorText": _text,
        "colorTextSecondary": _text_secondary,
        "colorTextTertiary": _text_muted,
        
        # Border colors
        "colorBorder": "#E5E5E5",
        "colorBorderSecondary": "#F5F5F5",
        
        # Border radius
        "borderRadius": 8,
        "borderRadiusLG": 12,
        "borderRadiusSM": 4,
        
        # Typography
        "fontFamily": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "fontFamilyCode": "'Fira Code', Monaco, Consolas, monospace",
    }
    
    # Create THEME_DEFAULT with same structure as THEME_DARK
    THEME_DEFAULT = {
        "token": THEME_DEFAULT_TOKENS
    }
    
    print(f"[Theme] ===== THEME_DEFAULT CREATED =====", flush=True)
    print(f"[Theme] THEME_DEFAULT keys: {list(THEME_DEFAULT.keys())}", flush=True)
    print(f"[Theme] THEME_DEFAULT['token'] count: {len(THEME_DEFAULT.get('token', {}))}", flush=True)
    print(f"[Theme] THEME_DEFAULT['token'] sample: colorPrimary={THEME_DEFAULT['token'].get('colorPrimary')}, colorBgBase={THEME_DEFAULT['token'].get('colorBgBase')}", flush=True)
    sys.stdout.flush()
    
    # Enable theme administration in UI
    ENABLE_UI_THEME_ADMINISTRATION = True
    
    # Force theme registration on startup
    PRELOAD_PERMSSIONS = True
    
    # Set default theme names for Superset to recognize
    # This tells Superset which themes to use by default
    THEME_MODEL_DEFAULT = "default"
    THEME_MODEL_DARK = "dark"
    
    # Dark theme configuration - read from theme.json
    logging.info(f"[Theme] Loading dark theme from colorsDark: {_SUPERSET_COLORS_DARK}")
    
    _primary_dark_mode = _SUPERSET_COLORS_DARK.get("primary", "#FF8A5C")
    _primary_dark_dark = _SUPERSET_COLORS_DARK.get("primaryDark", "#FF6B35")
    _text_dark = _SUPERSET_COLORS_DARK.get("text", "#E4E1E6")
    _text_secondary_dark = _SUPERSET_COLORS_DARK.get("textSecondary", "#A0A0A8")
    _text_muted_dark = _SUPERSET_COLORS_DARK.get("textMuted", "#808088")
    _link_dark = _SUPERSET_COLORS_DARK.get("link", "#FF8A5C")
    _link_hover_dark = _SUPERSET_COLORS_DARK.get("linkHover", "#FF6B35")
    _bg_dark = _SUPERSET_COLORS_DARK.get("background", "#1A1A1E")
    _surface_dark = _SUPERSET_COLORS_DARK.get("surface", "#242428")
    _surface_high_dark = _SUPERSET_COLORS_DARK.get("surfaceHigh", "#2E2E33")
    _border_dark = _SUPERSET_COLORS_DARK.get("border", "#49474E")
    _border_secondary_dark = _SUPERSET_COLORS_DARK.get("borderSecondary", "#3A383F")
    
    logging.info(f"[Theme] Dark mode variables - primary: {_primary_dark_mode}, bg: {_bg_dark}, text: {_text_dark}")
    
    THEME_DARK_TOKENS = {
        # Primary color (buttons, accents) - lighter orange for dark mode
        "colorPrimary": _primary_dark_mode,
        "colorPrimaryHover": _link_dark,
        "colorPrimaryActive": _primary_dark_dark,
        
        # Primary text
        "colorPrimaryText": _text_dark,
        "colorPrimaryTextHover": _primary_dark_mode,
        
        # Link colors
        "colorLink": _link_dark,
        "colorLinkHover": _link_hover_dark,
        "colorLinkActive": _primary_dark_dark,
        
        # Success, warning, error colors
        "colorSuccess": "#48BB78",
        "colorWarning": "#ED8936",
        "colorError": "#F56565",
        "colorInfo": _link_dark,
        
        # Background colors - dark mode
        "colorBgBase": _bg_dark,
        "colorBgContainer": _surface_dark,
        "colorBgElevated": _surface_high_dark,
        "colorBgLayout": _bg_dark,
        "colorBgSpotlight": _surface_high_dark,
        
        # Text colors - dark mode
        "colorText": _text_dark,
        "colorTextSecondary": _text_secondary_dark,
        "colorTextTertiary": _text_muted_dark,
        
        # Border colors - dark mode
        "colorBorder": _border_dark,
        "colorBorderSecondary": _border_secondary_dark,
        
        # Border radius
        "borderRadius": 8,
        "borderRadiusLG": 12,
        "borderRadiusSM": 4,
        
        # Typography
        "fontFamily": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "fontFamilyCode": "'Fira Code', Monaco, Consolas, monospace",
    }
    
    THEME_DARK = {
        "token": THEME_DARK_TOKENS
    }
    
    print(f"[Theme] ===== THEME_DARK CREATED =====", flush=True)
    print(f"[Theme] THEME_DARK keys: {list(THEME_DARK.keys())}", flush=True)
    print(f"[Theme] THEME_DARK['token'] count: {len(THEME_DARK.get('token', {}))}", flush=True)
    print(f"[Theme] THEME_DARK['token'] sample: colorPrimary={THEME_DARK['token'].get('colorPrimary')}, colorBgBase={THEME_DARK['token'].get('colorBgBase')}", flush=True)
    sys.stdout.flush()
    
    logging.info(f"[Theme] ===== FINAL THEME CONFIGURATION =====")
    logging.info(f"[Theme] THEME_DEFAULT keys: {list(THEME_DEFAULT.keys())}, token count: {len(THEME_DEFAULT.get('token', {}))}")
    logging.info(f"[Theme] THEME_DARK keys: {list(THEME_DARK.keys())}, token count: {len(THEME_DARK.get('token', {}))}")
    
    # Also set THEME_OVERRIDES to ensure both themes are available
    THEME_OVERRIDES = {
        "default": THEME_DEFAULT,
        "dark": THEME_DARK
    }
    print(f"[Theme] THEME_OVERRIDES configured with themes: {list(THEME_OVERRIDES.keys())}", flush=True)
    logging.info(f"[Theme] THEME_OVERRIDES configured with {len(THEME_OVERRIDES)} themes: {list(THEME_OVERRIDES.keys())}")
    
    # Explicitly set both theme variables at module level for Superset to find
    # This ensures they're available when Superset's theme manager looks for them
    print(f"[Theme] Final check - THEME_DEFAULT: {len(THEME_DEFAULT.get('token', {}))} tokens", flush=True)
    print(f"[Theme] Final check - THEME_DARK: {len(THEME_DARK.get('token', {}))} tokens", flush=True)
    
    # Make absolutely sure these are set as global variables
    # Superset will look for these in the module's global namespace
    globals()['THEME_DEFAULT'] = THEME_DEFAULT
    globals()['THEME_DARK'] = THEME_DARK
    globals()['THEME_OVERRIDES'] = THEME_OVERRIDES
    
    print(f"[Theme] Themes exported to globals - THEME_DEFAULT id: {id(THEME_DEFAULT)}, THEME_DARK id: {id(THEME_DARK)}", flush=True)
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
# Force all links to use orange color (overrides any custom CSS)
# ---------------------------------------------------------------------------
EXTRA_CSS = """
/* CSS Variables for theming */
:root {
    --primary-color: #FF6B35;
    --primary-dark: #E85A2D;
    --primary-light: #FF8A5C;
}

@media (prefers-color-scheme: dark) {
    :root {
        --primary-color: #FF8A5C;
        --primary-dark: #FF6B35;
        --primary-light: #FFB088;
    }
}

/* Force all links to be orange */
a, .link, [class*="link"], .ant-table-cell a, 
.ant-table-row a, td a, .table-cell a,
.ant-typography a, .ant-list-item a {
    color: #E85A2D !important;
}
a:hover, .link:hover, .ant-table-cell a:hover,
.ant-table-row a:hover, td a:hover, .table-cell a:hover,
.ant-typography a:hover, .ant-list-item a:hover {
    color: #FF6B35 !important;
}

/* Dark mode - force orange primary color */
@media (prefers-color-scheme: dark) {
    /* Primary buttons */
    .ant-btn-primary {
        background-color: #FF8A5C !important;
        border-color: #FF8A5C !important;
    }
    .ant-btn-primary:hover {
        background-color: #FF6B35 !important;
        border-color: #FF6B35 !important;
    }
    
    /* Primary color text and accents */
    .ant-btn-link,
    .ant-typography a,
    .ant-table-cell a,
    .ant-list-item a,
    a,
    .link,
    [class*="link"] {
        color: #FF8A5C !important;
    }
    
    .ant-btn-link:hover,
    .ant-typography a:hover,
    .ant-table-cell a:hover,
    a:hover,
    .link:hover {
        color: #FF6B35 !important;
    }
    
    /* Radio buttons, checkboxes, switches */
    .ant-radio-checked .ant-radio-inner,
    .ant-checkbox-checked .ant-checkbox-inner,
    .ant-switch-checked {
        background-color: #FF8A5C !important;
        border-color: #FF8A5C !important;
    }
    
    /* Tabs */
    .ant-tabs-tab-active,
    .ant-tabs-tab.ant-tabs-tab-active {
        color: #FF8A5C !important;
    }
    .ant-tabs-ink-bar {
        background-color: #FF8A5C !important;
    }
    
    /* Menu items */
    .ant-menu-item-selected,
    .ant-menu-item:hover,
    .ant-menu-submenu-selected,
    .ant-menu-submenu:hover {
        color: #FF8A5C !important;
    }
    .ant-menu-item-selected::after {
        border-bottom-color: #FF8A5C !important;
    }
    
    /* Spin/loading */
    .ant-spin-dot-item {
        background-color: #FF8A5C !important;
    }
    
    /* Progress bars */
    .ant-progress-bg {
        background-color: #FF8A5C !important;
    }
    
    /* Sliders */
    .ant-slider-track {
        background-color: #FF8A5C !important;
    }
    .ant-slider-handle {
        border-color: #FF8A5C !important;
    }
    
    /* Selected items, tags */
    .ant-select-item-option-selected,
    .ant-tag,
    .ant-picker-cell-selected .ant-picker-cell-inner {
        background-color: rgba(255, 138, 92, 0.2) !important;
        color: #FF8A5C !important;
    }
    
    /* Charts and visualizations - comprehensive override */
    .superset-legacy-chart-nvd3 .nv-point-paths path,
    .superset-legacy-chart-nvd3 .nv-groups path.nv-line,
    .superset-legacy-chart-nvd3 .nv-groups path.nv-area,
    .superset-legacy-chart-nvd3 .nv-bar,
    .superset-chart svg path[fill="#1E90FF"],
    .superset-chart svg path[fill="#20a7c9"],
    .superset-chart svg path[fill="#1890ff"],
    .superset-chart svg path[fill="#40a9ff"],
    .superset-chart svg path[fill="#69c0ff"],
    .superset-chart svg path[fill="#91d5ff"],
    .superset-chart svg path[fill="#bae7ff"],
    .superset-chart svg path[fill="#e6f7ff"],
    svg [fill="#1E90FF"],
    svg [fill="#20a7c9"],
    svg [fill="#1890ff"] {
        fill: #FF8A5C !important;
    }
    .superset-chart svg path[stroke="#1E90FF"],
    .superset-chart svg path[stroke="#20a7c9"],
    .superset-chart svg path[stroke="#1890ff"],
    svg [stroke="#1E90FF"],
    svg [stroke="#20a7c9"] {
        stroke: #FF8A5C !important;
    }
    
    /* Chart legends and labels */
    .nvd3 text,
    .nvd3 .nv-axis text,
    .nvd3 .nv-legend-text,
    .chart-container text,
    svg text {
        fill: #E4E1E6 !important;
    }
    
    /* Dropdown hover */
    .ant-dropdown-menu-item:hover,
    .ant-dropdown-menu-submenu-title:hover {
        background-color: rgba(255, 138, 92, 0.1) !important;
    }
    
    /* Pagination */
    .ant-pagination-item-active {
        border-color: #FF8A5C !important;
    }
    .ant-pagination-item-active a {
        color: #FF8A5C !important;
    }
    
    /* Force all blue colors to orange */
    *[style*="#1E90FF"],
    *[style*="#1890ff"],
    *[style*="#20a7c9"],
    *[style*="#40a9ff"] {
        color: #FF8A5C !important;
        background-color: #FF8A5C !important;
        border-color: #FF8A5C !important;
    }
}

/* Additional aggressive overrides for dark mode */
@media (prefers-color-scheme: dark) {
    /* Override inline styles */
    [style*="color: rgb(30, 144, 255)"],
    [style*="color: #1E90FF"],
    [style*="color: #1890ff"] {
        color: #FF8A5C !important;
    }
    
    /* Ant Design primary colors */
    .ant-btn-primary:not(.ant-btn-dangerous) {
        background-color: #FF8A5C !important;
        border-color: #FF8A5C !important;
    }
    
    /* DataTables and grid */
    .ReactVirtualized__Table__rowColumn,
    .ReactVirtualized__Grid__innerScrollContainer {
        color: #E4E1E6 !important;
    }
    
    /* Header actions */
    .header-actions .btn,
    .header-actions button {
        background-color: #FF8A5C !important;
        border-color: #FF8A5C !important;
    }
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
/* Force dark mode orange theme - injected by Hyperset config */
@media (prefers-color-scheme: dark) {
    :root {
        --ant-primary-color: #FF8A5C !important;
        --ant-primary-color-hover: #FF6B35 !important;
        --ant-primary-color-active: #E85A2D !important;
    }
    
    /* Override all Ant Design primary colors */
    .ant-btn-primary,
    .ant-radio-checked .ant-radio-inner,
    .ant-checkbox-checked .ant-checkbox-inner,
    .ant-switch-checked,
    .ant-btn-link,
    .ant-tabs-tab-active,
    .ant-menu-item-selected,
    .ant-pagination-item-active,
    .ant-select-item-option-selected,
    .ant-tag,
    .ant-progress-bg,
    .ant-slider-track,
    .ant-slider-handle,
    .ant-spin-dot-item {
        background-color: #FF8A5C !important;
        border-color: #FF8A5C !important;
        color: #FF8A5C !important;
    }
    
    /* Links */
    a, .ant-typography a, .ant-table-cell a {
        color: #FF8A5C !important;
    }
    
    /* Charts - force orange */
    .superset-chart svg *[fill="#1E90FF"],
    .superset-chart svg *[fill="#1890ff"],
    .superset-chart svg *[fill="#20a7c9"],
    .superset-chart svg *[fill="#40a9ff"],
    .nvd3 .nv-groups path.nv-line,
    .nvd3 .nv-bar,
    .nvd3 .nv-groups path.nv-area {
        fill: #FF8A5C !important;
        stroke: #FF8A5C !important;
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
        if 'THEME_DEFAULT' in globals():
            theme_info['THEME_DEFAULT_keys'] = list(THEME_DEFAULT.keys()) if THEME_DEFAULT else []
        return Response(json.dumps(theme_info, indent=2), mimetype='application/json')

    @app.after_request
    def inject_dark_mode_css(response):
        """Inject dark mode CSS into HTML responses"""
        if response.content_type and 'text/html' in response.content_type:
            try:
                html = response.get_data(as_text=True)
                if '</head>' in html:
                    html = html.replace('</head>', DARK_MODE_CSS + '</head>')
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
    if 'THEME_DARK' in globals() and THEME_DARK:
        logger.info(f"[Theme] THEME_DARK configured with {len(THEME_DARK.get('token', {}))} tokens")
    else:
        logger.warning("[Theme] THEME_DARK not configured!")
else:
    logger.info("[Theme] Using default Superset theme")

logger.info("=========================================")

LOG_LEVEL = logging.INFO
