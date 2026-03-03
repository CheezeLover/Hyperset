# Custom Superset image with PostgreSQL support
FROM docker.io/apache/superset:6.0.0

USER root

# Install PostgreSQL runtime library
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq5 && \
    rm -rf /var/lib/apt/lists/*

# Install psycopg2-binary in the system site-packages
# First find where site-packages is located
RUN SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])") && \
    pip install --no-cache-dir --target="$SITE_PACKAGES" psycopg2-binary && \
    echo "Installed to: $SITE_PACKAGES"

# Verify installation
RUN python -c "import psycopg2; print('psycopg2 OK:', psycopg2.__version__)"

USER superset
