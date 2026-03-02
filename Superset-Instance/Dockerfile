# Custom Superset image with PostgreSQL support
FROM docker.io/apache/superset:6.0.0

USER root

# Install PostgreSQL driver and other dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq-dev \
        gcc \
        python3-dev && \
    pip install --no-cache-dir psycopg2-binary && \
    apt-get remove -y gcc python3-dev && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Switch back to superset user
USER superset
