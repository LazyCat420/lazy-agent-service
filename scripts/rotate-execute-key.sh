#!/usr/bin/env bash
# Generate a new EXECUTE_API_KEY (lazy-tool-service POST /execute/*) and apply it
# everywhere it lives, without ever printing it.
#
#   scripts/rotate-execute-key.sh              # rotate + redeploy everything
#   scripts/rotate-execute-key.sh --no-deploy  # only write the key (deploy later)
#
# Where the key lives (all updated here):
#   1. vault-service/projects.json  -> config.EXECUTE_API_KEY  (local + NAS copy)
#   2. deploy-kit/.env.deploy                                   (most deploys)
#   3. NAS vault-service/env/.env                               (trading-* deploys copy it)
#   4. Obsidian plugin setting — the key is copied to the Windows clipboard; paste it
#      into LLMSortObsidian-Plugin -> "NAS Lazy Tool Service API Key".
#
# trading-service: a deploy kills an in-flight cycle. Run this between cycles.
# Rollout record: documentation/chapters/11-security-hardening-plan-2026-10-11.md (Item 3).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/deploy-kit"
ENV_DEPLOY="$KIT/.env.deploy"
LOCAL_PROJECTS="$ROOT/vault-service/projects.json"
NAS="${DEPLOY_SSH_HOST:-nas}"
NAS_VAULT="/volume1/docker/vault-service"
DOCKER="/usr/local/bin/docker"
EXECUTE_URL="http://10.0.0.16:5591/execute/web_search"
# Callers first, the server last (it is the one that starts rejecting the old key).
CALLERS=(html-notes treesearch-service trading-client trading-service)
SERVER=lazy-tool-service
SERVER_CONTAINER=lazy-agent-service

DEPLOY=1
[[ "${1:-}" == "--no-deploy" ]] && DEPLOY=0

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$ENV_DEPLOY" ]] || die "missing $ENV_DEPLOY"
[[ -f "$LOCAL_PROJECTS" ]] || die "missing $LOCAL_PROJECTS"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$NAS" true || die "cannot ssh to $NAS"

# The key only ever exists in this variable and in the files below.
NEW_KEY="$(openssl rand -hex 32)"; export NEW_KEY
[[ ${#NEW_KEY} -eq 64 ]] || die "key generation failed"
KEY_FP="$(printf %s "$NEW_KEY" | sha256sum | cut -c1-12)"
STAMP="$(date +%Y%m%d-%H%M%S)"

set_json_key() {  # $1 = a projects.json file on local disk
  python3 - "$1" <<'EOF'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault("config", {})["EXECUTE_API_KEY"] = os.environ["NEW_KEY"]
open(p, "w").write(json.dumps(d, indent=2) + "\n")
EOF
}

step "1/4 vault-service/projects.json (local + NAS)"
cp -p "$LOCAL_PROJECTS" "$LOCAL_PROJECTS.bak-$STAMP"
set_json_key "$LOCAL_PROJECTS"
ok "local copy (backup projects.json.bak-$STAMP)"
# Edit the NAS copy itself (it can hold entries the local copy lacks) and write it in
# place, so the container's single-file bind mount keeps pointing at it.
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
ssh "$NAS" "cat $NAS_VAULT/projects.json" > "$TMP"
set_json_key "$TMP"
ssh "$NAS" "cp -p $NAS_VAULT/projects.json $NAS_VAULT/projects.json.bak-$STAMP && cat > $NAS_VAULT/projects.json" < "$TMP"
ok "NAS copy (backup projects.json.bak-$STAMP)"

step "2/4 deploy-kit/.env.deploy"
cp -p "$ENV_DEPLOY" "$ENV_DEPLOY.bak-$STAMP"
python3 - "$ENV_DEPLOY" <<'EOF'
import os, re, sys
p = sys.argv[1]; s = open(p).read(); line = "EXECUTE_API_KEY=" + os.environ["NEW_KEY"]
if re.search(r"(?m)^EXECUTE_API_KEY=", s):
    s = re.sub(r"(?m)^EXECUTE_API_KEY=.*$", lambda _m: line, s)
else:
    s = s.rstrip("\n") + "\n" + line + "\n"
open(p, "w").write(s)
EOF
ok "written (backup .env.deploy.bak-$STAMP)"

step "3/4 NAS vault-service/env/.env"
printf '%s' "$NEW_KEY" | ssh "$NAS" "F=$NAS_VAULT/env/.env; K=\$(cat); cp -p \$F \$F.bak-$STAMP;
  if grep -q '^EXECUTE_API_KEY=' \$F; then sed -i \"s|^EXECUTE_API_KEY=.*|EXECUTE_API_KEY=\$K|\" \$F;
  else printf '\nEXECUTE_API_KEY=%s\n' \"\$K\" >> \$F; fi"
ok "written (backup env/.env.bak-$STAMP)"

step "4/4 restart vault-service (re-reads projects.json)"
ssh "$NAS" "sudo $DOCKER restart vault-service >/dev/null"
ok "restarted"

if command -v clip.exe >/dev/null; then
  printf '%s' "$NEW_KEY" | clip.exe
  ok "key copied to the Windows clipboard (not shown) — paste it into Obsidian"
fi

if [[ $DEPLOY -eq 0 ]]; then
  step "Skipped deploys (--no-deploy). Redeploy: ${CALLERS[*]}, then $SERVER."
  exit 0
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh"
for svc in "${CALLERS[@]}" "$SERVER"; do
  step "deploy $svc"
  log="/tmp/rotate-execute-key-$svc.log"
  if (cd "$KIT" && npm run deploy -- --only="$svc" --skip-pull >"$log" 2>&1); then ok "$svc deployed"
  else die "$svc deploy failed — see $log"; fi
done

step "verify"
code() { curl -s -m 45 -o /dev/null -w '%{http_code}' -X POST "$EXECUTE_URL" \
  -H 'content-type: application/json' "$@" -d '{"query":"openssl","limit":1}'; }
[[ "$(code)" == 401 ]] && ok "no key -> 401" || die "a call without the key was not rejected"
[[ "$(code -H "x-api-key: $NEW_KEY")" == 200 ]] && ok "new key -> 200" || die "the new key was rejected"
for c in "${CALLERS[@]}" "$SERVER_CONTAINER"; do
  fp=$(ssh "$NAS" "sudo $DOCKER exec $c sh -c 'printf %s \"\$EXECUTE_API_KEY\" | sha256sum'" 2>/dev/null | cut -c1-12 || true)
  [[ "$fp" == "$KEY_FP" ]] && ok "$c has the new key" || warn "$c does not have the new key"
done
step "Done. Last step: paste the key (on your clipboard) into Obsidian -> LLMSortObsidian-Plugin -> first field."
