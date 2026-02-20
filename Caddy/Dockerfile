FROM docker.io/library/caddy:2.10.2-builder AS builder
RUN xcaddy build v2.9.1 \
    --with github.com/greenpau/caddy-security@v1.1.31 \
    --with github.com/caddyserver/replace-response

FROM docker.io/library/caddy:2.9.1-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
