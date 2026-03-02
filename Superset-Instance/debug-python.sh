#!/bin/bash
# Debug Superset image Python environment

echo "=== Checking Superset Image Python Environment ==="

# Check where pip installs things
echo ""
echo "--- pip show psycopg2 ---"
podman run --rm docker.io/apache/superset:6.0.0 pip show psycopg2-binary 2>/dev/null || echo "Not installed"

# Check Python paths
echo ""
echo "--- Python sys.path ---"
podman run --rm docker.io/apache/superset:6.0.0 python -c "import sys; print('\n'.join(sys.path))"

# Check pip version and location
echo ""
echo "--- pip info ---"
podman run --rm docker.io/apache/superset:6.0.0 pip --version
podman run --rm docker.io/apache/superset:6.0.0 which pip

# Check user
echo ""
echo "--- Current user ---"
podman run --rm docker.io/apache/superset:6.0.0 whoami
podman run --rm docker.io/apache/superset:6.0.0 id

# Try to install as superset user and test
echo ""
echo "--- Installing as superset user ---"
podman run --rm --user superset docker.io/apache/superset:6.0.0 pip install --user psycopg2-binary
podman run --rm --user superset docker.io/apache/superset:6.0.0 python -c "import psycopg2; print('OK from user install')"

echo ""
echo "=== Done ==="
