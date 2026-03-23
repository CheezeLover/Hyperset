# ── Builder stage ──────────────────────────────────────────────
# node:20-slim (Debian) required — onnxruntime-node ships glibc binaries
# that cannot run on Alpine (musl).
FROM node:20-slim AS builder
WORKDIR /app

# Copy package files
COPY portal-app/package*.json ./
RUN npm install

# Copy source files
COPY portal-app/ ./

# Copy theme.json from project root (build context is repository root)
COPY theme.json ./theme.json

# Build args for environment variables (can be passed during docker build)
ARG HYPERSET_DOMAIN=hyperset.internal
ENV HYPERSET_DOMAIN=$HYPERSET_DOMAIN

# Limit Node heap during build to avoid OOM SIGKILL
ENV NODE_OPTIONS="--max-old-space-size=1536"
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
