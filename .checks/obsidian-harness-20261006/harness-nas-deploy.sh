#!/usr/bin/env bash
set -euo pipefail
cd /home/lazycat/github/projects/sun/lazy-agent-service
npm run typecheck
npm run build:runtime
cd /home/lazycat/github/projects/sun/deploy-kit
npm run deploy -- --only=lazy-tool-service --skip-pull --max-builds=6
