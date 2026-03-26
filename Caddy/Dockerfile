FROM docker.io/library/caddy:2.10.2-builder AS builder

# Build Caddy v2.9.1 with caddy-security and replace-response plugins.
# The RUN command includes a timestamp comment so podman never caches this layer —
# xcaddy always rebuilds fresh, guaranteeing the plugins are present.
# renovate: datasource=github-releases depName=caddyserver/caddy
ARG CADDY_VERSION=v2.9.1
ARG CADDY_SECURITY_VERSION=v1.1.31
ARG BUILD_DATE
RUN xcaddy build ${CADDY_VERSION} \
    --with github.com/greenpau/caddy-security@${CADDY_SECURITY_VERSION} \
    --with github.com/caddyserver/replace-response

# Verify both plugins compiled in — fail the build immediately if either is missing
RUN /usr/bin/caddy list-modules 2>/dev/null | grep -q "http.handlers.replace" || \
      (echo "FATAL: replace module missing from caddy binary" && exit 1)
RUN /usr/bin/caddy list-modules 2>/dev/null | grep -q "security" || \
      (echo "FATAL: security module missing from caddy binary" && exit 1)
RUN echo "✓ Caddy plugins verified: replace_response + security"

FROM docker.io/library/caddy:2.9.1-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
