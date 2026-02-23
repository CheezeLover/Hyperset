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
import logging

from flask import redirect, request, g, session
from flask_appbuilder.security.manager import AUTH_REMOTE_USER
from flask_login import login_user, current_user
from superset.security import SupersetSecurityManager

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
SECRET_KEY = os.getenv("SECRET_KEY", os.getenv("SUPERSET_SECRET_KEY", "CHANGE_ME_IN_PRODUCTION"))

ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": [
        os.getenv("HYPERSET_ORIGIN", "*"),
    ],
}

HTTP_HEADERS = {
    "X-Frame-Options": os.getenv("SUPERSET_FRAME_OPTIONS", "ALLOWALL"),
    "Content-Security-Policy": (
        "frame-ancestors 'self' "
        + os.getenv("HYPERSET_ORIGIN", "*")
    ),
}

WTF_CSRF_ENABLED = False

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
DB_HOST     = os.getenv("DB_HOST", "db")
DB_PORT     = os.getenv("DB_PORT", "5432")
DB_NAME     = os.getenv("DB_NAME", "superset")
DB_USER     = os.getenv("DB_USER", "superset")
DB_PASS     = os.getenv("DB_PASS", "superset")

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

        if admin_key in caddy_roles:
            return self.find_role("Admin")
        elif user_key in caddy_roles:
            return self.find_role("Gamma")

        # Fallback
        return self.find_role(self.auth_user_registration_role)

    def auth_user_remote_user(self, username):
        """
        Override that avoids passing g.user (a LocalProxy) to session.add().
        On first login (user creation), reads roles from Caddy header.
        On subsequent logins, just logs in without touching roles.
        """
        user = self.find_user(username=username)

        if user is None and self.auth_user_registration:
            # New user — resolve role from Caddy header
            initial_role = self._resolve_initial_role()

            # Extract email from header if available
            email = request.environ.get("HTTP_X_WEBAUTH_EMAIL", "")
            if not email:
                email = f"{username}@hyperset.local"

            user = self.add_user(
                username=username,
                first_name=username.split("@")[0].title(),
                last_name="",
                email=email,
                role=initial_role,
            )

        if user:
            login_user(user)
            g.user = user
        return user

CUSTOM_SECURITY_MANAGER = HypersetSecurityManager

# ---------------------------------------------------------------------------
# FLASK_APP_MUTATOR — installs a before_request hook that:
#   1. Reads REMOTE_USER (set by the WSGI middleware above)
#   2. Logs the user in via our patched auth_user_remote_user
#   3. Redirects /login/ to the index if already authenticated
# ---------------------------------------------------------------------------
def FLASK_APP_MUTATOR(app):

    @app.before_request
    def hyperset_auto_login():
        # Skip static files
        if request.path.startswith("/static"):
            return None

        remote_user = request.environ.get("REMOTE_USER", "")
        if not remote_user:
            return None

        # Already logged in as the correct user — nothing to do
        if current_user and current_user.is_authenticated:
            if current_user.username == remote_user:
                if request.path.rstrip("/") == "/login":
                    return redirect("/superset/welcome/")
                return None

        # Log the user in
        sm = app.appbuilder.sm
        user = sm.auth_user_remote_user(remote_user)
        if user:
            login_user(user)
            g.user = user

            if request.path.rstrip("/") == "/login":
                next_url = request.args.get("next", "/superset/welcome/")
                return redirect(next_url)

        return None

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_LEVEL = logging.INFO
