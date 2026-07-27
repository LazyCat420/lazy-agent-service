#!/bin/bash
# ============================================================
# Lazy Tool Service — Build & Deploy to Synology NAS
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
IMAGE_NAME="lazy-tool-service"
DISPLAY_NAME="Lazy Tool Service"
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
  # repo), so this used to copy the file onto itself via a ../lazy-tool-service
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
