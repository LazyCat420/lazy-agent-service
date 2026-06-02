# ============================================================
# Lazy Tool Service — Dockerfile
# ============================================================

# ── Stage 1: Python venv Builder ─────────────────────────────
FROM python:3.11-slim AS python-deps

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY python/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ── Stage 2: Node.js TS Builder ──────────────────────────────
FROM node:26-slim AS node-build

WORKDIR /app
COPY package.json package-lock.json ./
COPY .npmrc ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Stage 3: Runtime ──────────────────────────────────────────
FROM node:26-slim

# Install Python 3.11 and wget
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Fix python symlink for virtualenv compatibility
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# Copy python virtual environment
COPY --from=python-deps /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy Node.js dependency and build files
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/dist ./dist
COPY --from=node-build /app/package.json ./package.json

# Copy python app source code
COPY python/ ./python/
COPY tool_schemas.json ./tool_schemas.json

# Expose port
EXPOSE 5591

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:5591/health || exit 1

CMD ["node", "dist/boot.js"]
