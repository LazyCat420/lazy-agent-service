# ============================================================
# Lazy Tool Service — Dockerfile
# ============================================================

# ── Stage 1: Node.js TS Builder ──────────────────────────────
# ── Stage 1: Python venv Builder ─────────────────────────────
FROM python:3.11-slim AS python-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY python/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ── Stage 2: Node.js TS Builder ──────────────────────────────
FROM node:20-slim AS node-build

RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build
RUN pnpm prune --prod

# ── Stage 3: Runtime ──────────────────────────────────────────
FROM python:3.11-slim

# Install Node.js 20.x, wget, and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy python virtual environment
COPY --from=python-deps /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy Node.js dependency and build files
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/dist ./dist
COPY --from=node-build /app/package.json ./package.json

# Copy python app source code and schemas
COPY python/ /app/python/
COPY tool_schemas.json ./tool_schemas.json

# Expose port
EXPOSE 7778

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:7778/health || exit 1

CMD ["node", "dist/boot.js"]
