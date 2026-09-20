# Shared runtime duplication inventory

Snapshot: September 19, 2026. This inventory names temporary execution loops,
stream parsers, provider mappings, and compatibility wrappers. An entry may be
deleted only after its callers, acceptance evidence, rollback boundary, and
mutation semantics satisfy the listed gate.

## Inventory

| Repository / path | Duplicate responsibility | Current callers / owner | Deletion gate | Rollback limit |
| --- | --- | --- | --- | --- |
| `trading-client/app/routers/chat/stream.py` legacy Prism stream | Provider stream, tool/progress interpretation, completion, persistence | Strategy Chat legacy switch; trading-client owner | Canonical strategy path remains healthy through its observation period; terminal/error/UI behavior and actual search/read evidence remain green | Never retry the legacy route after a canonical run may have admitted an effect. Strategy tools are currently read-only, but the rule remains mandatory. |
| `trading-client/frontend/src/lib/api.ts` and Chat panel SSE reducer | Browser event parsing and old fallback behavior | Strategy Chat UI | UI consumes the shared typed reducer or a generated equivalent; Stop, EOF, reconnect, progress, and approval tests pass | A reconnect resumes the same run/cursor; it must not create another request. |
| `trading-service/app/agents/base_agent.py` Junior Analyst branch | Legacy agent loop, provider discovery, tools, retry, usage | V3 Junior Analyst when `USE_V2_SDK` is off; trading-service owner | 20 genuine historical cases at >=95% concordance, zero schema/policy/receipt violations, route/capacity parity, then seven consecutive canary days with zero unhandled failures and fallback <0.1% | Never replay an order or other possibly executed mutation through compatibility fallback. |
| `trading-service/app/agents/sdk_adapter.py` | Migration wrapper from V3 call shape to canonical runtime | V3 Junior Analyst canary | Becomes the direct primary call boundary after the same historical/canary gates; delete only the redundant legacy branch, not the domain adapter until its callers use the wire contract directly | Preserve SharedDesk/artifact order, heartbeat/deadline, financial checks, dedicated receipt verification, and usage coverage. |
| `trading-service/app/services/prism_agent_caller.py` and endpoint maps | Provider/model discovery for legacy Prism calls | Legacy trading roles | Every migrated role proves fresh moved/removed/expired model discovery, endpoint capacity, requested/served identity, and discovery failure on the canonical path | Do not replace measured discovery with fixed profile mappings. |
| `HTML-Notes/apps/api/app/agent/runtime_adapter.py` | Application adapter and local executor bridge | Notes chat runtime path | Keep as the application-owned context/tool/persistence boundary; remove only any embedded reasoning loop after all calls are runtime-driven | Signed receipt, ownership, HTML safety, and persistent executor idempotency must survive rollback. |
| HTML Notes local reply router | Completion shortcut that bypasses agent execution | Notes UI/API owner | Inventory each caller; either document it as a non-agent completion-only path or migrate it. It cannot count as runtime acceptance evidence | Never label a local reply as a runtime/tool-completed result. |
| `LLMSortObsidian/obsidian_plugin/agent/agent.ts` | Legacy local model/tool execution loop | Installed plugin when shared runtime is disabled | Scoped provisioning/refresh UX, active-vault UI acceptance, expiry/Stop/approval/steering/conflict/root/dry-run cases pass, then intended vault switch is enabled | A failed or expired runtime session must not replay vault writes through the legacy loop. |
| `LLMSortObsidian/obsidian_plugin/agent/runtime_client.ts` | Thin desktop runtime transport and local vault executor | Installed `llm-autoresearch-wiki` plugin | Retain as the application boundary; converge its event parsing on generated fixtures, but do not move vault credentials or file execution server-side | Runtime server credential stays off the desktop; scoped bearer expires within 24 hours. |
| `music-player/apps/api/app/agent/harness.py` legacy GLM loop | Reasoning loop, tool dispatch, memory, stalls | Music API while `MUSIC_RUNTIME_ENABLED` is off | Controlled persisted runtime job workflow proves UI payload/result/handoff and mutation deduplication; then enable runtime and observe before deleting legacy loop | Never invoke `/api/chat` after an ambiguous runtime failure. Check persisted job status before a user retry. |
| `music-player/apps/api/app/agent/runtime_adapter.py` | Thin canonical adapter and local music executor | Music runtime opt-in | Retain as application-owned tool/queue boundary; delete only logic duplicated by generated transport after parity | Call/result IDs, receipt validation, ownership, queue reuse, and composition sequencing remain mandatory. |
| `music-player/apps/web/components/MusicPlayer/ChatBox.tsx` stream reader | Browser SSE reducer and tool/UI handoff | Music UI | Replace with shared/generated reducer only when `tool_start`/`tool_result`, terminal errors, partial frames, and studio-bus handoffs have equivalent UI tests | No whole-request fallback after stream ambiguity. The September 19 fix removed that unsafe fallback. |
| `music-player/apps/api/app/routers/chat.py` | Older non-agent chat endpoint | Non-agent legacy UI/API callers | Confirm no callers require it after runtime rollout, then remove or document it as completion-only | It must never be an automatic fallback for an agent run. |
| `youtube-wallgarden` direct Prism/completion routes | Completion-only classification and legacy provider calls | Recommendation/feed pipeline | Shared backend resolver plus topic/feedback thresholds, mining idempotency, cache, nonblocking schedule, model discovery, and stale-hint evidence pass | Preserve completion-only semantics; do not force classification into a tool loop. |
| `lazycat-sdk` legacy `PrismClient.agent_chat_stream` | Legacy provider transport and SSE parsing | Unmigrated applications | Repository-wide caller inventory reaches zero or each remaining caller has a documented non-runtime contract | Removing it must not silently reroute callers to a different model/provider. |
| `lazy-agent-service` compatibility aliases in `RunAdmission` and wire models | v1/v1.1 field aliases | Existing SDK/application versions | Installed consumers all advertise the canonical generated wire identity and the compatibility support window expires | Reject conflicts; never guess between two different alias values. |

## Shared components that are not duplication

- Application adapters remain responsible for domain context, local executors,
  ownership, validation, persistence, and UI handoff. They are not competing
  reasoning loops.
- Wallgarden classification may remain completion-only.
- Trading's multi-role orchestration and Music's durable job sequencing remain
  application workflows; each model invocation uses the shared lifecycle.
- `TinyModelsProvider` is an optional typed specialist adapter, not another
  agent loop and not a policy authority.

## Release check

Before deleting any row, record the exact caller search, primary-branch commit,
test command, installed image/SDK/profile identity, representative domain
workflow, rollback image, and mutation replay rule in the release evidence.
Prism compatibility work remains on our side; `prism-service` is never edited,
committed, or deployed as part of this inventory.
