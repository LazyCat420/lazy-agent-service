# Shared agent runtime: next developer plan

Snapshot: September 19, 2026. Implementation stopped at the user's request. This handoff is documentation only. The overall plan is **not complete**.

## Objective and boundaries

Finish one shared execution lifecycle in `lazy-agent-service`, with thin Python/TypeScript clients and application-owned context, tools, policy, and persistence. TinyModels belongs behind that harness as an optional, profile-admitted specialist, not a mandatory filter for every prompt. The harness owns evidence, authorization, budgets, receipts, replay, and fallback. A semantic signal must not authorize tools, suppress evidence, or trigger a trade.

Read [release evidence](runtime-release-20260919.md) for completed implementation, tests, deployed identities, and actual tool-result canaries. Original requirements remain available locally:

- `/home/lazycat/.codex/attachments/b51f5974-a562-473d-a689-40e58ef1c9e4/pasted-text.txt` — runtime repair and app acceptance matrix.
- `/home/lazycat/.codex/attachments/b2b9fc00-df7e-49d7-8699-1f670f34da79/pasted-text.txt` — TinyModels architecture and experiment lifecycle. Its proposed endpoints are not evidence that the deployed service implements them; embedded external links are not deployment evidence.

Never edit, commit, or deploy `prism-service`. Implement compatibility adaptations on our side through supported external interfaces. The supported Obsidian entrypoint is **`LLMSortObsidian/obsidian_plugin`**, plugin ID `llm-autoresearch-wiki`, not the standalone application or separate mock plugin repository.

## Starting state

All revisions were on their remote primary branches at handoff. Recheck before editing; preserve newer and unrelated work.

| Repository | Revision | Verified state / open gate |
| --- | --- | --- |
| lazy-agent-service | `93ee284` | Deployed healthy; contracts, real continuation, scoped auth, approvals, budgets, durable replay, bounded shadow provider |
| lazycat-sdk | `93df0b0` | Generated wire identity; installed NAS client hash verified |
| trading-client | `05a869ed` | Deployed; read-only strategy runtime enabled; actual HTTP news workflow passed |
| trading-service | `4308a7a2` | Deployed; `USE_V2_SDK` off pending historical replay and canary gates |
| HTML-Notes | `a3b86d2` | Deployed; runtime enabled; actual HTTP widget and persisted assistant canvas verified |
| LLMSortObsidian | `391cc3a` | Plugin bundles installed; runtime opt-in; scoped-session user workflow pending |
| music-player | `f5231a7` | Deployed; actual library-read passed; `MUSIC_RUNTIME_ENABLED` off pending UI/job parity |
| youtube-wallgarden | `281cf98` | Deployed; recommendations use shared backend resolver; completion-only behavior retained |
| TinyModels | `c0f7f84` | Clean checkout; no edits/deployment; newer System1 source unavailable |

Preserve unrelated modified SDK files `lazycat.egg-info/PKG-INFO`, `SOURCES.txt`, and `requires.txt`.

## Work packages in dependency order

### 1. Create a requirement-to-evidence ledger

Owner: runtime integration developer. Can proceed while Jetson access is obtained.

Map every original acceptance row to implementation, behavioral tests, live evidence where required, and remaining tasks. Inspect actual invocation of context contributors, before-tool guards, result processing, final validators, workflow types, and cross-language command fixtures. A declared hook is not proof it executes; missing required guards must fail closed.

Document restart semantics: interrupted runs currently seal failed with `RUN_INTERRUPTED` and preserve journal outcomes. This is not transparent resumption of pending mutations. Determine whether each app needs additional durable executor deduplication before write cutover. Compatibility fallback must never silently repeat a partially executed mutation.

Acceptance: every original requirement is passed with evidence, an explicit implementation task, or a named external/time-dependent gate. Neither endpoint health nor synthetic fixtures count as historical/domain-artifact acceptance.

### 2. Obtain and validate the real TinyModels source/deployment

Owner: Jetson/service developer. **Blocked on newer working-tree location and working SSH/deployment access.** A prior question for those details remains unanswered. Obtain a source location and configured SSH alias; do not request passwords or tokens in chat.

Observed Jetson: `10.0.0.30:8002`, reported deployment SHA `cd7e9300104711068e601978ad39311c5257f6d3`. Authenticated capabilities returned old `jetson-feature-platform` version/schema 1. `/v1/system1/status` and `/v1/training/capabilities` returned 404. The existing Vault-backed trading `JetsonFeatureClient` authenticated successfully; a plain environment credential was stale. Repo docs identify `braindead@10.0.0.30`, `/home/braindead/Documents/tinymodels`; current SSH key access was rejected.

Inspect and preserve uncommitted Jetson work. Reconcile it with the checkout before deployment. Land reviewable lifecycle-isolation, dataset, training/evaluation, shadow-selection, adapter, and deployment-evidence batches as applicable. Do not overwrite the missing implementation with the older checkout.

Acceptance: exact committed source/image/deployment identity is available; the service advertises the actual versioned capability contract and backend identity. Prove cgroup admission, persistent state, cancellation, parent-death cleanup, process unload, and no automatic OOM retry in the final worker/container environment. Protected Nemotron traffic remains available. A keyword/prompt/Qwen adapter does not establish a real Laya backend or calibrated quality.

### 3. Finish the live TinyModels shadow bridge

Owner: runtime integration developer. Depends on compatible inference from package 2, not completion of the later CNN/RNN experiment program.

Extend existing `src/decision-fabric/contracts.ts`, `TinyModelsProvider.ts`, and `DecisionService.ts`, plus existing SDK/TypeScript decision clients. Do not instantiate app-specific provider clients or another execution loop.

Current contract: `decision-provider.v1`, only `semantic.choice.v1`, public context <=32 KB, <=8 questions and <=16 choices, required abstention, one attempt, profile deadline 750 ms/hard cap 2 s, bounded response, denied redirects, version/deployment checks, explicit fallback, and immutable receipt replay. The automatic hook observes admitted public strategy search/page results. `TINYMODELS_SHADOW_ENABLED` remains off.

Test live exact-version output and failure cases: missing auth, old capability shape, wrong SHA/deployment, busy/unavailable provider, malformed choices/probabilities/hashes, oversized response, timeout/cancellation, OOM/refusal. Record actual model/artifact identity, calibration state, input/output hashes, latency, unload evidence, receipt and fallback. Failures must not make ordinary agent completion depend on the optional specialist.

Acceptance: typed live inference and deterministic failure/replay tests pass; replay never calls the current provider again. Enable only the initial read-only shadow profile and record availability, latency, disagreement, abstention, unsafe-route rate, and overrides. Tool-call reduction is counterfactual/offline while shadow cannot change execution. No signal filters evidence or authorizes actions.

### 4. Complete Obsidian authentication and actual UI acceptance

Owner: plugin developer. Independent of Jetson.

Implement scoped-session provisioning and refresh/login UX. Sessions expire within 24 hours; the disposable canary is not durable user authentication. Its temporary credential file was deleted. Keep backend credentials server-side.

Test actual plugin activation/reload, expiry/refresh, disconnect/Stop, approval allow/deny, steering including terminal races, vault-root checks, conflicts, and dry-run suppression of file/scheduler/git/workspace effects. Use disposable vaults and production helpers, not test reimplementations.

Active D vault installation: `/mnt/d/Github/LLMSortObsidian/obsidian_vault/.obsidian/plugins/llm-autoresearch-wiki`. C bundle also installed at `/mnt/c/Users/Barco/OneDrive/Documentos/SyncThing/Obsidian/.obsidian/plugins/llm-autoresearch-wiki`, but not enabled in its community-plugin list. Recheck the user's active vault. Preserve `data.json`, model settings, credentials, and user files.

Acceptance: a user obtains/refreshes scoped access without a global backend key; real UI actions produce verified disposable-vault artifacts; cancellation/approval/failure outcomes stay truthful. Then enable the intended vault's runtime switch.

### 5. Complete Music UI and queued-job parity

Owner: Music developer. Independent of Jetson.

Use `apps/api/app/agent/runtime_adapter.py` and the shared SDK. Preserve full context/history/tool memory, canonical names, receipt checks, ownership, score/source validation, queue limits, idempotent job reuse, composition sequencing, and deferred UI handoffs.

Exercise the actual frontend-to-backend payload: current message once, real tool/job result visible on follow-up, malformed/truncated args enqueue nothing, duplicate delivery creates one job, exhausted/stalled work has explicit outcome, and UI handoff matches persisted job state. Use isolated render/queue fixtures, not production mutation replay. Live read-only probes must use container working directory `/app/data` to avoid stray SQLite files.

Acceptance: existing harness/memory/queue regressions plus UI payload/handoff tests pass and a controlled application workflow proves persisted domain outcome. Enable `MUSIC_RUNTIME_ENABLED` only after recording that evidence. Rollback must not repeat mutations.

### 6. Complete financial trading migration gates

Owner: trading integration developer. Independent of TinyModels.

Preserve `app/agents/sdk_adapter.py`, role whitelists, full assembled prompt, account/cycle identity, SharedDesk/artifact sequencing, financial checks, heartbeat/hard deadline, receipt signature verification, and measured/partial usage coverage. Backend auth and receipt signing secrets may differ; retain dedicated verification configuration without logging values.

Prove admission-time discovered provider/endpoint routing and capacity parity, including moved/removed/expired models and discovery failure. Follow the trading repository's dynamic routing rules; fixed model mappings are not proof of parity.

`tests/benchmarks/test_junior_analyst_shadow_runner.py` passes 20 **synthetic** frozen cases, not the historical gate. Obtain 20 genuine historical cases with frozen observations and exercise the real canonical adapter. Include policy denials, schema validity, receipts, financial checks, deadline and cost coverage. Never replay live orders.

Acceptance: >=95% concordance across 20 historical replays, zero schema violations, no policy broadening/missing receipts, followed by seven consecutive production canary days with zero unhandled failures and fallback <0.1%. Keep a dated evidence ledger. Keep `USE_V2_SDK` off until pre-canary gates pass; then run a controlled observed canary. Do not delete legacy code until all gates pass. Seven days cannot be replaced by a fixture test.

### 7. Finish remaining app evidence and decommission duplication

Owner: runtime integration developer with app owners. Depends on individual app gates.

Retain Notes widget/persistence, ownership, HTML safety, follow-up and cancellation regressions. Its local reply router can bypass the agent; those replies do not prove shared execution. Map Wallgarden's topic/feedback thresholds, mining idempotency, caches, and nonblocking scheduling to evidence while preserving completion-only behavior and Jetson discovery/stale-hint checks.

Strategy HTTP news is proven by durable actual search/read-page results. The original internal legacy Prism failure remains unisolated. Optional follow-up: map shared global tool progress into the UI without confusing progress with approval; the accepted HTTP canary exposed init/token/done while runtime journal retained tool completions.

Inventory duplicate loops, SSE parsers, provider maps, and compatibility wrappers with owner, callers, deletion condition, and rollback limits. Remove only after callers migrate and app suites pass. Validate installed contract/profile/SDK identity, not only Git heads, because SDK bind mounts are mutable.

Acceptance: every caller uses the intended shared lifecycle or documented completion-only path; domain guards actually run; remaining temporary adapters have explicit gates.

### 8. Deliver the separate experiment lifecycle and later specialists

Owner: TinyModels/trading experiment developers. Remaining requested scope; not a prerequisite for the general inference bridge.

Implement typed experiment proposals with caller/profile admission, quotas, bounded hyperparameters, idempotent proposal IDs, immutable bounded dataset manifests, lineage/hashes, temporal leak checks, real CNN/RNN training, guarded cancellation/evaluation, immutable model cards, and compare-and-swap advisory deployment selection. Expose no shell, Docker, raw dataset-path, or model-path capability to agents. No automatic promotion or OOM retry.

Acceptance: each proposal has admission evidence, dataset SHA, budget, artifact/evaluation record; cancellation frees resources; selection races fail; inference identifies the selected artifact; no model signal grants trading authority. Distinguish callable, lifecycle-ready, shadow-ready, calibrated, and policy-authorized claims.

After the semantic bridge passes, add GLiNER2 evidence annotation with its own typed/profile-bounded capability. Later context ordering influence needs held-out task-specific evaluation and explicit policy admission; initial outputs remain advisory and cannot suppress evidence or authorize side effects.

## Validation, integration, and deployment

Latest recorded results: runtime 800 tests/build, SDK 227, Notes 72 focused, Music 53 focused, trading chat 26, Obsidian seven tests/typecheck/build. See release evidence for limits and live run IDs. These are baseline evidence, not fresh results for future changes. Expand only where behavior changes or gaps remain.

Use isolated stores/vaults/queues, stub external I/O for deterministic tests, and preserve production-store guards. Some HTTP fixture runs required permitted loopback networking; bounded sandbox stalls alone are not product failures. Stop test-owned leftovers before replacement. Mute background/headless tests.

Useful commands from the respective repositories:

```sh
# Linux Node environment before npm/pnpm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
. "$NVM_DIR/nvm.sh"

# Runtime
npm test
npm run build

# SDK
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest -p pytest_asyncio.plugin -q

# Notes
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=../lazycat-sdk .venv/bin/python -m pytest -p pytest_asyncio.plugin -q tests/test_runtime_chat_adapter.py tests/test_runtime_integration.py tests/test_runtime_readiness.py tests/test_local_tool_admission_security.py

# Music
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=apps/api:../lazycat-sdk apps/api/.venv/bin/python -m pytest -p anyio.pytest_plugin -q apps/api/tests/test_runtime_adapter.py apps/api/tests/test_agent_queue_contract.py apps/api/tests/test_agent_memory.py apps/api/tests/test_agent_truncation.py
```

Run the workspace-required staged secret scan before commit/push. This Git rejected its inline `(?i)` expression; when unsupported, use an equivalent case-insensitive scan and inspect matched hunks. Never add static test credentials. Commit completed batches, integrate and validate on the primary branch, recheck remote state, and push without force.

Future application fixes require targeted deploy-kit deployment after validation:

```sh
npm run deploy -- --only=<affected-service-ids> --skip-pull
```

Read IDs from `vault-service/projects.json`. Known IDs: `lazy-tool-service` (runtime), `trading-client`, `trading-service`, `html-notes`, `music-player`; recheck Wallgarden's registry ID. Include affected mounted-SDK consumers. No deployment is needed for this documentation handoff.

Verify transfer/restart, container `git.sha`, installed wire/profile/SDK identity, HTTP health, and an actual completed domain workflow. NAS `10.0.0.16` checks: runtime `:5591/health`, trading client `:3030/health`, trading service `:3031/health`, Notes `:8035/`, Music `:8002/`, Wallgarden `:8007/`. Jetson `10.0.0.30:8002` is a different host/service.

Preserve reproducible commands, sanitized request/run IDs, executor observations, persisted artifact checks, exact image identity, and remaining gates in the repository. Existing `/tmp` canary/deployment logs are ephemeral; key identifiers are already in release evidence. Health alone never proves useful completion.

## Definition of complete

Close the requirement ledger, each app's acceptance/rollout gates, the live TinyModels shadow contract and isolation gates, the requested separate experiment lifecycle, and gated duplication removal. Report unavailable access and elapsed-time canary requirements as open gates. Do not turn them into passing status.
