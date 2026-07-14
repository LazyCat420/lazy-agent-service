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

  step "Copying tool_schemas.json from lazy-tool-service"
  cp "${SCRIPT_DIR}/../lazy-tool-service/tool_schemas.json" "${SCRIPT_DIR}/tool_schemas.json"

  step "Copying projects.json from vault-service"
  cp "${SCRIPT_DIR}/../vault-service/projects.json" "${SCRIPT_DIR}/projects.json"

  step "Cleaning and staging Python files for Docker build..."
  rm -rf "${SCRIPT_DIR}/python"
  mkdir -p "${SCRIPT_DIR}/python/app"

  # Copy entire python app structure from trading-service
  cp -r "${SCRIPT_DIR}/../trading-service/app/"* "${SCRIPT_DIR}/python/app/"
  
  cp -r "${SCRIPT_DIR}/../trading-service/scripts" "${SCRIPT_DIR}/python/"
  cp "${SCRIPT_DIR}/../trading-service/requirements.txt" "${SCRIPT_DIR}/python/requirements.txt"

  # Copy lazycat SDK dependencies
  cp -r "${SCRIPT_DIR}/../lazycat-sdk/lazycat" "${SCRIPT_DIR}/python/"

  # Copy tool_schemas.json into python/ so the docker builder includes it inside /app/python
  cp "${SCRIPT_DIR}/tool_schemas.json" "${SCRIPT_DIR}/python/tool_schemas.json"
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
