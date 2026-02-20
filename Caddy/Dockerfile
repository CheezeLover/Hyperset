FROM docker.io/library/caddy:2.10.2-builder AS builder
# Cache-bust this layer any time the plugin list changes.
# Update this string to force a full xcaddy rebuild.
ARG CADDY_PLUGINS="caddy-security@v1.1.31,replace-response"
RUN xcaddy build v2.9.1 \
    --with github.com/greenpau/caddy-security@v1.1.31 \
    --with github.com/caddyserver/replace-response
# Verify the plugins are present before committing the image
RUN /usr/bin/caddy list-modules | grep -E "http.handlers.replace_response|security" && \
    echo "✓ required Caddy plugins verified"

FROM docker.io/library/caddy:2.9.1-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
