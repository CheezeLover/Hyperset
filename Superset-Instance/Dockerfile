# Custom Superset image with PostgreSQL support
FROM docker.io/apache/superset:6.0.0

USER root

# Install PostgreSQL driver
# Note: Superset 6.0.0 uses a venv at /app/.venv
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq5 && \
    rm -rf /var/lib/apt/lists/*

# Install psycopg2-binary in Superset's Python environment
# The base image uses a virtualenv at /app/.venv
RUN /app/.venv/bin/pip install --no-cache-dir psycopg2-binary

# Verify installation
RUN /app/.venv/bin/python -c "import psycopg2; print('psycopg2 installed:', psycopg2.__version__)"

# Switch back to superset user
USER superset
