import os

SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "changeme")
SQLALCHEMY_DATABASE_URI = "sqlite:////app/superset_home/superset.db"

ENABLE_PROXY_FIX = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

APPLICATION_ROOT = "/superset"