#!/bin/bash
# ============================================================
# Lazy Agent Service — Build & Deploy to Synology NAS
#
# Thin wrapper — all logic lives in ../deploy-kit/lib.sh
#
# Usage:
#   npm run deploy              # full deploy
#   npm run deploy -- --dry-run # validate without deploying
#   npm run deploy -- --skip-pull
#   npm run deploy -- --no-cache
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# IMAGE_NAME also decides the NAS deploy directory —
# `DEPLOY_COMPOSE_DIR="${DEPLOY_COMPOSE_ROOT}/${IMAGE_NAME}"` in deploy-kit/lib.sh
# — so changing it MOVES where this service's .env, projects.json and data live.
# Renamed lazy-tool-service -> lazy-agent-service 2026-08-07, with the live
# /volume1/docker/lazy-tool-service copied across first. That order is not
# optional: a half-finished earlier attempt had left a stale
# /volume1/docker/lazy-agent-service dating from Jul 13 whose .env held 4 keys
# against the live 10, missing DATABASE_URL, MONGO_URI, MONGO_STORE_BACKEND,
# INTERNAL_EXECUTE_TOKEN, TRADING_SERVICE_API_KEY and WALLGARDEN_MONGO_DB.
# (Historical: as of 2026-08-19 this service reads no Postgres at all, so
# DATABASE_URL is no longer one of its keys — TRADING_MONGO_DB replaced it.)
# Deploying into it would have come up GREEN — the healthcheck only fetches
# /health — while every Mongo, Postgres and internal-execute call failed, on the
# box that fronts every LLM request the desk makes.
IMAGE_NAME="lazy-agent-service"
DISPLAY_NAME="Lazy Agent Service"
PORT=5591

# Intercept exit to introduce a delay on successful build exit.
# This prevents a filesystem race condition in deploy-all.sh
# where the status file is checked before the pipeline completely closes.
exit() {
  local code="${1:-0}"
  if [ "$code" -eq 0 ]; then
    sleep 2
  fi
  builtin exit "$code"
}

PRE_BUILD() {
  step "Building flat tool_schemas.json from tool_schemas/ split sources"
  python3 "${SCRIPT_DIR}/../trading-service/scripts/build_tool_schemas.py"

  # build_tool_schemas.py already wrote this repo's copy (SCRIPT_DIR is that
  # repo), so this used to copy the file onto itself via a ../lazy-agent-service
  # round-trip — which broke outright once the directory was renamed. Nothing to
  # copy: the build above is the step.

  step "Copying projects.json from vault-service"
  cp "${SCRIPT_DIR}/../vault-service/projects.json" "${SCRIPT_DIR}/projects.json"

  # NO python staging. This step used to mirror trading-service/app, its scripts,
  # requirements.txt and lazycat-sdk/lazycat into ./python — ~12MB and 549 tracked
  # files — but the runtime image never contained any of it: Dockerfile stage 2
  # copies only node_modules, dist, package.json, tool_schemas.json and public
  # onto a bare node:22-slim, so there is no interpreter to run it. The old
  # subprocess bridge that would have used it was removed (see LocalToolRouter.ts);
  # every python-backed tool now goes over HTTP to trading-service. Removed
  # 2026-07-27 — do not reinstate without also adding python to the Dockerfile.
}



EXTRA_SSH_SYNC() {
  info "Syncing projects.json..."
  cat "${SCRIPT_DIR}/projects.json" | ssh "$DEPLOY_SSH_HOST" "cat > '${DEPLOY_COMPOSE_DIR}/projects.json'"
  ok "projects.json synced"

  info "Appending IMAGE_NAME and PORT to remote NAS .env..."
  ssh "$DEPLOY_SSH_HOST" "echo 'IMAGE_NAME=${IMAGE_NAME}' >> '${DEPLOY_COMPOSE_DIR}/.env' && echo 'PORT=${PORT}' >> '${DEPLOY_COMPOSE_DIR}/.env'"
  ok "remote NAS .env updated"
}

source "${SCRIPT_DIR}/../deploy-kit/lib.sh"
