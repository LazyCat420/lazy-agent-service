# Shared agent runtime requirement-to-evidence ledger

Snapshot: September 19, 2026. This ledger maps the two original requirement
documents to executable evidence and explicitly names every remaining gate. A
row is `passed` only when the required kind of evidence exists; health checks,
declared hooks, synthetic fixtures, and endpoint names are not substituted for
domain or live evidence.

Source requirements:

- `/home/lazycat/.codex/attachments/b51f5974-a562-473d-a689-40e58ef1c9e4/pasted-text.txt`
- `/home/lazycat/.codex/attachments/b2b9fc00-df7e-49d7-8699-1f670f34da79/pasted-text.txt`

Detailed completed-run identifiers and deployed revisions are retained in
[runtime-release-20260919.md](runtime-release-20260919.md). This file is the
gate ledger; it does not duplicate transient credentials or raw production
payloads.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `passed` | Behavioral or live evidence satisfies the requirement. |
| `implementation` | Code work is still required and is named in the row. |
| `external gate` | Required source, access, domain data, or user environment is unavailable. |
| `time gate` | Passing requires elapsed production observation and cannot be simulated. |

## Canonical runtime and transport

| Requirement | Status | Evidence or remaining task |
| --- | --- | --- |
| One shared execution lifecycle; SDKs remain transport clients | passed | `RunExecutionEngine`, `LocalToolContinuation`, `RunApprovals`, generated wire identity, and Python/TypeScript contract fixtures. Runtime 800-test baseline and SDK 227-test baseline are recorded in the release evidence. |
| Exact contract/profile resolution and normalized aliases | passed | `RunAdmission`, `ProfileRegistry.loadProfile`, and `test/contract/RuntimeRepair.test.ts`; unknown exact versions fail and corrected admission can reuse the key. |
| Effective model, tools, and zero-valued budgets are validated | passed | `RunAdmission` folds top-level values into the validated effective override. `RuntimeRepair.test.ts` covers an out-of-policy top-level model, zero tools, and zero duration. |
| Real local result is correlated and returned before continuation | passed | `LocalToolContinuation`; `RuntimeRepair.test.ts` covers waiting state, cross-run rejection, duplicate acknowledgement, conflicting replay rejection, and exact observation delivery to the next model turn. |
| Approval allow/deny/expiry and scope are durable and fail closed | passed | `RunApprovals`, run routes, signed authorization receipts, and runtime contract tests. Application UI acceptance remains separate below. |
| LF/CRLF/chunked SSE, reconnect, explicit terminal states, and cancellation | passed | Cross-language wire fixtures, `RuntimeTransport.test.ts`, SDK stream tests, and cancellation propagation baseline recorded in release evidence. |
| Usage includes all attempts and distinguishes unknown/partial measurement | passed | `CanonicalProviderBudget` and budget regression tests; the live strategy canary recorded measured usage across three calls. |
| Context contributors, before-tool guards, result processors, and final validators actually execute | passed for non-worker hooks | `RunExecutionEngine` calls `context`, `beforeTool`, `afterTool`, and `validate`; `RuntimeRepair.test.ts` proves their lifecycle order around a correlated local result. `RuntimeExtensions.resolve` fails absent required context/verifier registrations. `worker_plugins` still have no task-dispatch binding and deliberately make a profile unready; implement the bounded worker lifecycle before enabling such a profile. |
| Workflow types are explicit (`structured_completion`, `interactive_agent`, `application_workflow`) | passed | `AgentProfile`, the profile JSON schemas, and every shipped manifest require an enumerated `workflow_type`; contract tests reject absent or unknown values. The type describes the caller-owned workflow without selecting a second execution loop. |
| Required guards fail readiness closed | passed | `RuntimeRepair.test.ts` proves `trading-analyst-v1` cannot generate when its required extensions are absent. |
| No placeholder executor can produce successful evidence | passed | Unimplemented media capabilities were removed from the published runtime capability set; global web execution has real observations and cancellation. |
| Restart never silently repeats a pending effect | passed, limited semantics | `RunStore.loadFromDisk` seals every nonterminal run as failed with `RUN_INTERRUPTED`, preserves pending tool journal entries, and never redispatches them; covered by `RuntimeRepair.test.ts`. This is failure recovery, not transparent resumption. |
| Durable mutation deduplication across runtime restart | implementation per app | Runtime call/result replay is durable, but executor-side side-effect deduplication must be demonstrated by Notes, Obsidian, and Music before write cutover. Compatibility fallback must remain disabled after any possibly executed mutation. |

## Strategy chat and trading

| Requirement | Status | Evidence or remaining task |
| --- | --- | --- |
| Narration, EOF, provider error, Stop, and timeout cannot become false success or launch an untracked second request | passed | Trading client stream/runtime migration tests and deployed read-only runtime route; terminal state remains correlated to one run. |
| Current user message occurs once; tool progress differs from approval | passed | Trading chat regression suite and canonical message contract. |
| News search result and relevant page content reach a subsequent model turn | passed | Actual HTTP canary `e4ebfd5e-7622-4e52-b387-51ba640bcf91` / runtime `run-1373a566-a731-4daf-9905-0fccdba226e3` has durable completed `global.web.search` and `global.web.read_page` events. |
| Legacy internal Prism incident has a proven root cause | external gate, optional | Canonical path is repaired and proven. The older internal Prism failure was not isolated; Prism remains outside repository ownership and may only be inspected through supported interfaces. |
| Junior analyst preserves full prompt, role tools, SharedDesk/artifact order, financial checks, heartbeat/deadline, identity, receipts, and usage | passed in focused implementation tests | `app/agents/sdk_adapter.py` and the recorded trading suites cover the adapter invariants. Historical/domain parity is a separate open gate. |
| Provider/endpoint discovery proves moved, removed, expired, capacity, and discovery-failure parity | implementation | Execute admission-time discovery cases against the canonical adapter and record selected provider/endpoint/capacity. Fixed mappings and unit mocks are insufficient. |
| Twenty genuine historical frozen replays achieve at least 95% concordance with zero schema/policy/receipt violations | external gate | Only 20 synthetic frozen cases exist. Obtain 20 genuine, sanitized historical observations and expected decisions; never replay orders. Keep `USE_V2_SDK` off. |
| Seven consecutive production canary days have zero unhandled failures and fallback below 0.1% | time gate | Begin only after historical and routing gates pass. Store daily denominators, failures, fallbacks, receipt verification, and policy outcomes. Seven elapsed days cannot be replaced by fixtures. |
| Legacy trading loop is removed | implementation, gated | Retain it until historical replay and seven-day canary gates pass; document rollback without mutation replay before deletion. |

## Application acceptance

| Application requirement | Status | Evidence or remaining task |
| --- | --- | --- |
| HTML Notes context/history, ownership, HTML safety, result continuation, cancellation, widget persistence | passed | 72-test focused baseline plus deployed actual HTTP widget run `run-712415a8-a03e-4d29-83ec-47c999fa9681`; persisted assistant canvas contained the canary marker. |
| HTML Notes executor deduplicates a write after process restart | passed | Notes commit `ded3aa4` adds a SQLite-backed execution journal keyed by app/session/run/call and nonce. A completed duplicate returns the original persisted observation after process-cache loss; a crash-window pending mutation returns `EXECUTION_OUTCOME_UNKNOWN` without redispatch. The expanded security/integration selection passed 106 cases and the NAS image is healthy at `ded3aa4`. |
| Obsidian uses `LLMSortObsidian/obsidian_plugin` and production vault helpers | passed | Seven production-code tests/typecheck/build and installed bundle hash are recorded. The separate mock plugin repository is not accepted evidence. |
| Obsidian scoped session provisioning and refresh/login UX, expiry, disconnect/Stop, approval, steering races, conflict, root, and dry-run behavior | implementation | Build server-side scoped-session provisioning/refresh and plugin UX, then exercise the installed plugin in the user's active vault with disposable artifacts. Preserve `data.json`, settings, credentials, and user notes. |
| Obsidian actual active-vault UI workflow | external gate | Recheck whether D or C is active and perform user-visible activation/reload acceptance. The prior disposable credential was intentionally deleted. |
| Music full context/history/tool memory, canonical names, receipts, ownership, validation, queue/idempotency, sequencing | passed in focused implementation tests | 53-test adapter/queue/memory/truncation baseline and deployed read-only library run `run-73778bee-9b8a-4bb2-8485-0a6055ba5cd4`. |
| Music actual frontend payload, follow-up job visibility, malformed/truncated suppression, duplicate delivery, stall outcome, and persisted UI handoff | implementation, narrowed | Runtime/UI tests now prove a stable request ID, one current turn, preserved tool-result memory, `tool_start` before the correlated result, duplicate call suppression, malformed-argument suppression, explicit stalls, and studio-bus handoffs. The unsafe uncorrelated `/api/chat` fallback was removed. Run one controlled persisted mutation workflow before enabling `MUSIC_RUNTIME_ENABLED`. |
| Wallgarden recommendation resolver, thresholds, mining idempotency, cache, stale model hint, and nonblocking scheduling preserve completion-only behavior | passed | The 18-suite browser test chain proves signal thresholds/re-arming, impression deduplication, bounded evidence budgets, idle queue behavior, mining replay suppression, topic-scoped classifier caching, and late nonblocking classification. The shared backend's 48 focused tests prove Jetson-only discovery/routing, stale-hint rejection, and empty/malformed/no-channel completion rejection. At 19:07 PDT, deployed `/api/wallgarden/models` discovered `vllm::nemotron35`; a completion-only `/recommend-channels` call using that identity returned HTTP 200 with five parsed recommendations. No tool loop or mutation was involved. |

## TinyModels decision provider and experiment lifecycle

| Requirement | Status | Evidence or remaining task |
| --- | --- | --- |
| Harness owns policy/evidence/tools; semantic signals are advisory only | passed | `DecisionService` is invoked only after admitted public web observations; its receipt is telemetry and never changes authorization or model context. Profile admission is explicit. |
| Bounded `decision-provider.v1` / `semantic.choice.v1` contract, abstention, one attempt, hashes, replay, and fallback | passed in deterministic runtime tests | `decision-fabric/contracts.ts`, `TinyModelsProvider`, `DecisionService`, and `DecisionProvider.test.ts`. Live provider evidence remains open. |
| Exact real TinyModels committed source, image, deployment SHA, backend identity, and versioned capabilities | external gate | Jetson reports old `jetson-feature-platform` schema; System1/training endpoints return 404. Git checkout `c0f7f84` lacks the handoff implementation and SSH key access was rejected. Obtain the newer working-tree location and configured SSH alias without requesting credentials in chat. |
| Preserve and reconcile uncommitted Jetson work before deployment | external gate | Must inspect the real Jetson working tree before any TinyModels edit/deploy. Never overwrite it with the older checkout. |
| Live success/failure matrix: auth, schema/version/SHA, busy, malformed result, oversize, timeout/cancel, OOM/refusal, unload | implementation after source/access gate | Extend live provider tests and capture sanitized immutable receipts, artifact identity, latency, calibration state, unload evidence, and fallback. Keep `TINYMODELS_SHADOW_ENABLED` off. |
| Cgroup admission, persistent state, cancellation, parent-death cleanup, unload, no automatic OOM retry, protected Nemotron traffic | external gate | Requires execution in the final Jetson worker/container environment. A prompt/Qwen adapter cannot satisfy real Laya identity or quality claims. |
| Initial read-only shadow metrics | implementation after live bridge | Record availability, latency, disagreement, abstention, unsafe-route rate, and overrides. Tool-call reduction remains counterfactual/offline while shadow cannot alter execution. |
| Typed experiment proposals, quotas, bounded hyperparameters, immutable datasets/lineage, temporal leak checks | external gate then implementation | Required code is not in the available checkout. Implement only after preserving/reconciling the newer source. |
| Real CNN/RNN train/evaluate/cancel, immutable model cards, CAS shadow selection, inference artifact identity | external gate then implementation | Requires the real source plus Jetson execution evidence. No shell, Docker, raw dataset path, or raw model path may be exposed to agents; no automatic promotion or OOM retry. |
| GLiNER2 typed evidence annotation | gated implementation | Begin only after the semantic live bridge passes. Output remains advisory and cannot suppress evidence or authorize effects. |

## Duplication and release gates

| Requirement | Status | Evidence or remaining task |
| --- | --- | --- |
| Inventory duplicate loops, SSE parsers, provider maps, wrappers, callers, owners, deletion/rollback gates | passed | `runtime-duplication-inventory-20260919.md` names each path, caller/owner, deletion condition, and rollback/mutation limit. Deletion remains gated per row. |
| Installed contract/profile/SDK identity is verified, not inferred from Git | passed for the September 19 release | Release evidence records NAS container revisions, installed client hash, health, and actual domain workflows. Repeat after every affected deployment. |
| Completed changes land on primary branches, pass secret scan, push, and targeted deploy | ongoing release rule | Each completed batch must follow the workspace integration/deploy instructions. No Prism edit, commit, or deployment is permitted. |

## Immediate critical path

1. Bind declared worker plugins to bounded task requests and lifecycle evidence.
2. Finish Music's controlled persisted workflow and Obsidian scoped-session UX independently.
3. Complete trading discovery parity and obtain genuine historical cases.
4. Obtain the real TinyModels source and Jetson access; only then finish live shadow and experiment lifecycle work.
5. Start the seven-day trading canary after its pre-canary gates pass.
6. Remove duplicate paths only after each caller's acceptance and rollback gates close.

The overall plan remains open while any `implementation`, `external gate`, or
`time gate` row remains. In particular, the unavailable TinyModels source,
missing historical trading corpus, active-vault UI acceptance, and seven-day
canary must never be represented as passed by synthetic tests.
