FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Limit Node heap during build to avoid OOM SIGKILL in memory-constrained envs.
# Webpack/SWC compilation is the culprit; 1.5 GB is usually sufficient for Next.js.
ENV NODE_OPTIONS="--max-old-space-size=1536"
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy standalone output (Next.js bundles most deps here automatically)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# serverExternalPackages are NOT bundled — the standalone node_modules only
# contains what Next.js traced. Copy the full node_modules so externals resolve.
# This is larger but ensures @modelcontextprotocol/sdk and iron-session work.
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
