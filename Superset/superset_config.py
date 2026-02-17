# Superset specific config
import os
from cachelib.file import FileSystemCache

# Set the authentication type
# AUTH_TYPE = AUTH_DB

# SQLite Configuration
SQLALCHEMY_DATABASE_URI = 'sqlite:////app/superset_home/superset.db'

# Secret key for signing cookies
SECRET_KEY = os.environ.get('SUPERSET_SECRET_KEY', 'your-secret-key-change-this')

# Cache configuration (File-based for SQLite deployments)
CACHE_CONFIG = {
    'CACHE_TYPE': 'FileSystemCache',
    'CACHE_DIR': '/app/superset_home/cache',
    'CACHE_DEFAULT_TIMEOUT': 300,
    'CACHE_KEY_PREFIX': 'superset_'
}

# Explore cache configuration
DATA_CACHE_CONFIG = CACHE_CONFIG

# Feature flags
FEATURE_FLAGS = {
    'ENABLE_TEMPLATE_PROCESSING': True,
    'ALERT_REPORTS': False,  # Requires Celery
    'DASHBOARD_NATIVE_FILTERS': True,
    'DASHBOARD_CROSS_FILTERS': True,
    'DASHBOARD_FILTERS_EXPERIMENTAL': True,
    'EMBEDDABLE_CHARTS': True,
    'SCHEDULED_QUERIES': False,  # Requires Celery
}

# Webserver configuration
ROW_LIMIT = 5000
SUPERSET_WEBSERVER_PORT = 8088

# CSV/Excel export size limits
CSV_EXPORT = {
    'encoding': 'utf-8',
}

# Set timeout for queries (in seconds)
SQLLAB_TIMEOUT = 300
SUPERSET_WEBSERVER_TIMEOUT = 300

# Allow for iframe embedding (if needed)
# HTTP_HEADERS = {'X-Frame-Options': 'ALLOWALL'}

# Enable scheduled queries and alerts (requires Celery - disabled for SQLite)
ALERT_REPORTS_NOTIFICATION_DRY_RUN = True