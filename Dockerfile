# ============================================================
# Lazy Tool Service — Dockerfile
# ============================================================

# ── Stage 1: Node.js TS Builder ──────────────────────────────
FROM node:20-slim AS node-build

WORKDIR /app
COPY package.json package-lock.json ./
COPY .npmrc ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Stage 2: Runtime ──────────────────────────────────────────
FROM node:20-slim

# Install wget for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Node.js dependency and build files
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/dist ./dist
COPY --from=node-build /app/package.json ./package.json

# Copy tool schemas
COPY tool_schemas.json ./tool_schemas.json

# Expose port
EXPOSE 5591

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:5591/health || exit 1

CMD ["node", "dist/boot.js"]
