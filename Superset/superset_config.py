import os

SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "changeme")
SQLALCHEMY_DATABASE_URI = os.environ.get("SQLALCHEMY_DATABASE_URI")

# Critical for running behind a reverse proxy under /superset
ENABLE_PROXY_FIX = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

# Subpath config
APPLICATION_ROOT = "/superset"
WTF_CSRF_EXEMPT_LIST = []