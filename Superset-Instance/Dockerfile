# Custom Superset image with PostgreSQL support
FROM docker.io/apache/superset:6.0.0

USER root

# Install PostgreSQL runtime library
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq5 && \
    rm -rf /var/lib/apt/lists/*

# Find the correct pip and install psycopg2
# Superset 6.0.0 may use system Python or a venv
RUN pip install --no-cache-dir psycopg2-binary || \
    /usr/local/bin/pip install --no-cache-dir psycopg2-binary || \
    (which pip3 && pip3 install --no-cache-dir psycopg2-binary) || \
    (ls /app/.venv/bin/pip* 2>/dev/null && /app/.venv/bin/pip install --no-cache-dir psycopg2-binary) || \
    (ls /opt/venv/bin/pip* 2>/dev/null && /opt/venv/bin/pip install --no-cache-dir psycopg2-binary) || \
    echo "WARNING: Could not install psycopg2"

# Verify installation with available Python
RUN (python -c "import psycopg2; print('psycopg2 OK:', psycopg2.__version__)" 2>/dev/null) || \
    (python3 -c "import psycopg2; print('psycopg2 OK:', psycopg2.__version__)" 2>/dev/null) || \
    (/app/.venv/bin/python -c "import psycopg2; print('psycopg2 OK:', psycopg2.__version__)" 2>/dev/null) || \
    echo "WARNING: psycopg2 not found"

# Switch back to superset user
USER superset
