# Agent chat migration inventory

Snapshot: 2026-09-20. This is an inventory and compatibility map, not a
claim that migration is complete. The older
`docs/runtime-duplication-inventory-20260919.md` has stale Notes paths; the
current callers are `HTML-Notes/app/services/runtime_chat_adapter.py` and
`HTML-Notes/app/static/index.js`.

## Canonical contract

The source of truth is `src/contracts/RuntimeWire.ts`, exported to
`contracts/generated/runtime-wire-v1.json`, with package generated types as a
consumer. Its event set is:

`run.admitted`, `run.started`, `run.created`, `message.delta`,
`message.completed`, `tool.invoked`, `tool.called`, `tool.completed`,
`tool.result`, `tool.failed`, `approval.required`, `approval.resolved`,
`worker.dispatched`, `worker.completed`, `run.completed`, `run.failed`,
`run.cancelled`.

Compatibility mapping is grouped by lifecycle: `run.*` remains lifecycle
state; `message.*` becomes text/reply state; `tool.*` becomes tool call/result
state; `approval.*` becomes an explicit approval state; `worker.*` becomes
background work state. Adapters may translate these to legacy SSE/UI shapes,
but unknown event names remain observable and can never imply success or a
terminal result. The contract identity is `runtime-wire.v1.0.0`; the contract
digest in `packages/agent-chat/contract.json` is
`sha256-de254c9c95a74bb1a3e13f21b33527cbd993a45a7cca40bdac36eedd9a79f84a`.

The package absorbed the original `284a06a` source/tests diff before the
follow-up fixes. Distribution is produced with `npm run pack:agent-chat`; the
Trading consumer pins the resulting vendor `.tgz`. The full runtime/package suite passed 821 tests, and the root build generated runtime contracts and package declarations. Trading frontend production build, six stream tests, and 17 focused backend tests passed.

## Caller inventory and deletion gates

| Caller | Parser / reducer | Runtime client | Cancel | Approval | Replay | Terminal | Owner | Deletion gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Trading strategy chat (`trading-client/app/routers/chat/stream.py`, `app/chat/runtime_strategy.py`) | Legacy SSE reducer plus canonical `runtime_event` forwarding; frontend `frontend/src/lib/api.ts` gates canonical UI with `NEXT_PUBLIC_AGENT_CHAT_ENABLED` | `lazycat.client.RuntimeClient` through `strategy_runtime_stream` when `STRATEGY_CHAT_RUNTIME_ENABLED=true` | Disconnect cancels the active run; no replay fallback | Runtime approval events remain explicit; progress is never approval | No request retry after an admitted run | `run.completed`, `run.failed`, or `run.cancelled`, with legacy persistence unchanged | Trading client | UI/observation parity and full cancel/steer/reconnect evidence; the separate Trading execution migration owns the 20-case/7-day evidence gate |
| Notes (`HTML-Notes/app/routes/message.py`, `app/services/runtime_chat_adapter.py`, `app/static/index.js`) | `RuntimeChatAdapter` maps canonical events to application SSE; browser reducer is in `app/static/index.js` | Runtime adapter owns the `RuntimeClient` boundary and local executor | Adapter cancellation must be idempotent | Permission denial and `approval.*` are distinct from completion | Receipt, nonce, ownership, and executor journal must provide replay-prevention evidence | Exactly one terminal SSE event, including outage/refusal/cancel | HTML-Notes | Complete readiness/auth/receipt/replay evidence and active UI acceptance; local completion shortcuts remain separately classified |
| Music (`music-player/apps/api/app/agent/runtime_adapter.py`, web `ChatBox.tsx`) | Runtime adapter plus Music UI stream reader; legacy `harness.py` remains while flag is off | Runtime adapter owns the runtime transport and local music executor | Persisted job cancellation and queue reuse | Tool approval/denial must remain explicit | Durable job IDs and mutation deduplication; never retry an ambiguous run | Runtime terminal event and durable job result | Music player | Controlled persisted runtime workflow, UI payload/result/handoff parity, and mutation deduplication before `MUSIC_RUNTIME_ENABLED` rollout |
| Obsidian (`LLMSortObsidian/obsidian_plugin/agent/agent.ts`, `agent/runtime_client.ts`) | Plugin reducer and runtime client converge on generated fixtures | `ObsidianRuntimeClient`; vault execution stays local | Stop/expiry must cancel without replaying vault writes | Approval state is explicit and scoped to the vault | Scoped write receipts and conflict/root/dry-run checks must provide replay-prevention evidence | Runtime terminal state plus local vault result | LLMSortObsidian / `llm-autoresearch-wiki` plugin | Provisioning/refresh, active-vault, expiry, Stop, approval, steering, conflict/root/dry-run acceptance, then intended vault switch |
| Wallgarden (`youtube-wallgarden/app/app.js` and backend completion routes) | Completion response parsers; no agent event reducer required | Direct completion/provider resolver | Request cancellation follows completion endpoint semantics | Not an agent approval workflow | Preserve idempotent mining/cache behavior | Completion-only response | youtube-wallgarden | Resolver, topic/feedback thresholds, mining idempotency, cache, nonblocking schedule, model discovery, and stale-hint evidence |

## Legacy event mapping

| Caller legacy family | Canonical event(s) | Compatibility note |
| --- | --- | --- |
| Trading `init` | `run.admitted` / `run.started` | Metadata remains adapter/UI state. |
| Trading `token` | `message.delta` | Text reducer input. |
| Trading `tool_call` | `tool.invoked` / `tool.called` | Preserve call identity and arguments. |
| Trading `done` | `message.completed` then `run.completed` | Only the run terminal event means success. |
| Trading `error` | `tool.failed` or `run.failed` / `run.cancelled` | Select from the canonical source event. |
| Trading `status`, `thinking` | `worker.dispatched` / `worker.completed` where applicable; otherwise observable adapter status | No invented canonical event. |
| Trading `approval_required` | `approval.required` / `approval.resolved` | Approval is never inferred from progress. |
| Music `text` | `message.delta` / `message.completed` | Preserve partial versus final text. |
| Music `thought` | No direct canonical equivalent; observable adapter field | Do not relabel as user-visible text. |
| Music `tool_start`, `tool_result` | `tool.invoked` / `tool.completed` or `tool.result` | Keep result/error distinction. |
| Music `warning`, `error` | `run.failed` or observable adapter warning | Warning alone is not success. |
| Notes `chunk`, `status`, `progress`, `tool_call`, `done`, `error` | `message.delta`, `worker.*`, `tool.*`, `run.completed`, `run.failed` / `run.cancelled` | Current browser names are adapter output; preserve unknown names as observable. |
| Any unknown legacy name | No mapping | Surface it and never treat it as success or terminal completion. |

## Rollback and remaining work

For Trading, rebuild the frontend with `NEXT_PUBLIC_AGENT_CHAT_ENABLED=false`
to preserve the legacy stream representation; this is a build-time setting.
The backend runtime switch is the existing
`STRATEGY_CHAT_RUNTIME_ENABLED` check in `trading-client/app/routers/chat/stream.py`;
disable it to return to the legacy provider. There is no replay-request
fallback after a canonical run has been admitted.

Migration is explicitly **not complete**. Trading's separate execution
migration still requires 20 genuine cases at >=95% concordance, zero
schema/policy/receipt violations, and seven clean days. This chat migration
still has full UI cancel, steer, reconnect, and mutation application
parity/auth gates outstanding. The original history was archived locally as `.archives/lazy-agent-chat-284a06a.bundle` and verified with `git bundle verify`. The original checkout and registered developer worktree remain intact; local Git configuration marks the package archived and records its successor.

## Release evidence

- Runtime package commit: `dae3d2b`, pushed to `origin/main`.
- Trading pinned consumer commit: `6d0e14ba`, pushed to `origin/main`.
- Runtime deployed through `deploy-kit --only=lazy-tool-service --skip-pull`.
  NAS container `lazy-agent-service` reports revision `dae3d2b`, running/healthy,
  image `sha256:16ef08047b2e4649a6c326829af471e47f2fc7e97a7072457fb4b98d145b96d9`;
  `http://10.0.0.16:5591/health` returned `{"status":"ok"}`.
- No static secrets were staged. This Git build rejects inline `(?i)` in
  `git diff -G`; the required scan was followed by the equivalent explicit
  case-insensitive character-class pattern. Matching changes were usage fields
  and documentation, not credential assignments.
- Trading deployment and real browser workflow evidence are recorded below
  when validated. A healthy runtime alone is not domain acceptance.

Trading consumer deployment used `deploy-kit --only=trading-client --skip-pull`.
NAS container `trading-client` reports revision `6d0e14ba`, running/healthy,
image `sha256:33ee710748d4d4c883f275d750d6c54515b0d0b28725bb8c2fdd10976639d62c`.
`http://10.0.0.16:3030/health` returned status `ok`.
The consumer and runtime vendor artifact SHA-256 hashes both equal
`a424eb7b9605eeaf747940b12c19df4b6c5e12696d3293b3177a18e99bb4554b`.

An initial muted headless-browser request completed and persisted a 1,387-character
assistant reply at `2026-09-20T17:28:48.654000`. The browser harness could not
retrieve the completed response body through CDP, so that run alone does not
prove canonical frame delivery or transient UI behavior. It was not replayed.

A second, distinct read-only request used corrected in-page stream capture.
Canonical frames and transient tool progress were observed without an approval
popup. The runtime failed on iteration 3 with
`Canonical token budget cannot cover the next prompt`; persisted outcome was
`failed`, and the UI displayed the error plus `Response failed.`. The harness's
final duplication heuristic also failed because appended failure text exceeded
its partial-response length assumption. This is evidence for truthful failure
rendering, not complete happy-path or duplicate-render acceptance. No automatic
request retry occurred. Both test-owned muted browsers were closed, and a
post-run read-only inspection submitted zero further chat requests.
Sanitized evidence: `docs/evidence/agent-chat-ui-20260920.json`.

TinyModels follow-up is committed on Trading `master` as `83271441`: missing or
drifting served versions fail closed, and specialist model IDs and versions
survive projection. The focused suite passed 109 tests; after removing the
remaining ID-as-version fallback, the 35 affected tests passed. The warm
five-document GLiNER diagnostic took 2.56 seconds; CNN and RNN took 49 ms and
86 ms. These are synthetic-input service checks, not historical trading cases.
The five-second production deadline remains unchanged. Cold GLiNER latency is
unmeasured because the service reported it loaded throughout; no unload,
restart, or model promotion was performed. See the Trading report
`docs/tinymodels-specialist-latency-20260920.md` for the reproduction command.

Trading service was redeployed through `deploy-kit --only=trading-service --skip-pull`.
Its idle-cycle gate passed before transfer and restart. Container `trading-service`
is running/healthy at `83271441`, image
`sha256:4f47d448f98c70bad7d74cf9a2454cf2aaa87c5eb878988155f690c942c8ec5b`;
`http://10.0.0.16:3031/health` returned status `ok`.
The synthetic-only diagnostic also ran inside that deployed container: warm
GLiNER singles 694/588 ms, five-document batch 2,667 ms, CNN 25 ms, RNN 45 ms.
Reported model IDs/versions are retained in
`docs/evidence/tinymodels-postdeploy-20260920.json`. All calls completed under the
unchanged five-second deadline; these measurements do not establish calibration,
cold latency, or authorization to trade.

The deployed V3 runner's exact environment expression was checked:
`USE_V2_SDK=False`. No production SDK cutover was enabled.

The browser budget error originated at `CanonicalProviderBudget.ts`, which
charges each model turn against the unchanged 49,152-token strategy profile.
It was not a browser reducer error. Review found verbatim application context
was sometimes supplied both inside the assembled prompt and again in overrides.
Trading fix `262e1ca2` removes only complete nonempty values of the four known
context-text fields already present verbatim in the prompt. It retains ticker
and other metadata, incomplete/truncated/different context, the original system
prompt, and all history/current messages. Fifteen focused chat tests passed.
This removes redundant input without widening the budget or claiming that any
arbitrarily long conversation must complete.

The independent final live workflow on `262e1ca2` completed: exactly one stream
request, 155 canonical frames (151 deltas and one tool completion), authoritative
`run.completed` and outer `done`, one observed tool-status update, and no approval
popup. Canonical and persisted assistant content matched exactly (2,106 characters
and SHA-256), with no repeated halves. The completed response and sources were
visually checked in the screenshot. The harness Markdown word-order heuristic
still failed (source Markdown and rendered text differ); this is recorded as
`applicationWorkflowPassed=true`, `harnessAssertionPassed=false`, not a blanket
UI-suite pass. The browser was closed and no further live request was issued.
Evidence: `docs/evidence/agent-chat-ui-final-20260920.json`.

The successful context-fix deployment reported `262e1ca2`, image
`sha256:a8aeb90eddd61d905578339553f0c494683273a474025b2dcbc288dc59ec80b8`,
and HTTP health status `ok`.

## Package 0.2.1 release record

Runtime package fix commit `cd7f1c1` was pushed with fixes for expected-run
replay binding, terminal-history contamination and current-incomplete
precedence, and error-valued tool results. The release artifact is
`vendor/lazycat-agent-chat-0.2.1.tgz` with SHA-256
`6050c31f7e7b0615b956724bd01ed3dec5633491ddf7589ea542f757d23eaace`.

Validation recorded 826 runtime/package tests passing, including 19 package
tests; six consumer tests were directly executed and passed. Consumer pin
commit `753af6fc` was pushed. Package-only fixes were deployed through the
frontend/library path. The runtime backend is already healthy at
`dae3d2b`; the `cd7f1c1` changes are client-library-only and require no backend
redeploy.

The final frontend release is running/healthy at `753af6fc`, image
`sha256:f3f9f266ef9f93efd7dc4319693e8e11e32b24ff31ed0f7b5280a9b52b4800b3`.
HTTP health returned `ok`; deploy-kit completed transfer/restart with exit 0.

The final deployed 0.2.1 UI regression passed with one intercepted stream
request and zero real chat/model requests. A duplicate canonical event ID plus
a legacy duplicate token rendered the response exactly once; historical
assistant text from the terminal payload was not injected, no approval popup
appeared, and successful completion rendered correctly. The muted browser
closed cleanly. Evidence: `docs/evidence/agent-chat-ui-mocked-021-20260920.json`.
This mocked check supplements the earlier real workflow; it does not clear
the outstanding reconnect, steering, cancellation, or mutation replay gates.
