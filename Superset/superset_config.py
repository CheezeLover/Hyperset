# docker/pythonpath/superset_config.py
import os

SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "CHANGE_ME")
SQLALCHEMY_DATABASE_URI = os.environ.get("SQLALCHEMY_DATABASE_URI")

# Redis cache
CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_HOST": os.environ.get("REDIS_HOST", "redis"),
    "CACHE_REDIS_PORT": int(os.environ.get("REDIS_PORT", 6379)),
    "CACHE_REDIS_DB": 1,
}

# Celery
class CeleryConfig:
    broker_url = f"redis://{os.environ.get('REDIS_HOST', 'redis')}:{os.environ.get('REDIS_PORT', 6379)}/0"
    result_backend = f"redis://{os.environ.get('REDIS_HOST', 'redis')}:{os.environ.get('REDIS_PORT', 6379)}/0"
    imports = ("superset.sql_lab",)

CELERY_CONFIG = CeleryConfig

# Optional: enable feature flags
FEATURE_FLAGS = {
    "DASHBOARD_NATIVE_FILTERS": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
}

# Thumbnail cache for Celery
THUMBNAIL_CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 86400,
    "CACHE_KEY_PREFIX": "thumbnail_",
    "CACHE_REDIS_HOST": os.environ.get("REDIS_HOST", "redis"),
    "CACHE_REDIS_PORT": int(os.environ.get("REDIS_PORT", 6379)),
    "CACHE_REDIS_DB": 2,
}