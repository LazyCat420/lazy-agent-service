#!/usr/bin/env bash
set -euo pipefail
pnpm run typecheck
pnpm exec vitest run --maxWorkers=2 src/services/__tests__/LocalToolVerification.test.ts src/services/__tests__/ObsidianCompletionJobs.test.ts src/routes/__tests__/ObsidianCompletionRoutes.test.ts test/contract/RuntimeScopeRoutes.test.ts test/contract/RuntimeRepair.test.ts test/contract/ContractV12Suite.test.ts test/contract/RuntimeNewsWorkflow.test.ts
pnpm run build:runtime
python3 documentation/build_docs.py
