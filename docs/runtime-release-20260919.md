# Shared runtime repair release — September 19, 2026

This is implementation and acceptance evidence, not a claim that all migration gates have passed. Prism was not edited or deployed.

## Follow-up batch: workflow contracts and Music UI handoff

Runtime commit `4974827` requires an explicit workflow type on every shipped
profile and adds executed lifecycle evidence for context, before-tool,
post-result, and final-validation hooks. The full runtime suite passed 802/802
and the TypeScript build passed. It was deployed to the NAS as image label
`git.sha=4974827`; `lazy-agent-service` reported healthy and
`http://10.0.0.16:5591/health` returned HTTP 200.

Music commit `67a33c5` adds stable UI request identity, preserves current-turn
and tool-result memory, emits `tool_start` before each runtime result so the UI
can render the persisted job, and removes the uncorrelated legacy fallback that
could repeat an ambiguous mutation. The focused API suite passed 53/53, the web
suite passed 130/130, and the production web build passed. It was deployed as
image label `git.sha=67a33c5`; the container was healthy and
`http://10.0.0.16:8002/` returned HTTP 200. `MUSIC_RUNTIME_ENABLED=false`
remains intentional until a controlled persisted mutation workflow is recorded.

The targeted deploy completed two passed / zero failed. Deploy-kit reported an
unrelated edge-DNS reconciliation warning while confirming that both services
deployed successfully.

## Shared implementation

- The executable runtime wire schema generates Python models and a packaged version/digest. Canonical Python consumers verify that identity before starting work. TypeScript transport validates framing, run binding, replay duplicates, and terminal outcomes.
- Runtime authentication binds app/user/session ownership. Desktop clients use expiring scoped bearer sessions, not backend credentials. Local execution requires argument-bound, expiring receipts; required approvals remain distinct from tool execution.
- Actual local results resume the model. Tool admission is not success. Failed tools, interrupted streams, missing guards, and failed admission remain explicit failures. Restart recovery seals interrupted runs and journals their terminal outcome without repeating pending effects.
- All generation attempts share token accounting and cancellation. Unknown usage stays unknown. Input reservation and total run limits are separate from per-call output limits. Full Notes/Music schemas require larger total budgets than their previous output-only limits.
- Durable run storage is mounted on the NAS; existing container-layer data is copied only when the persistent target does not already exist.
- TinyModels has one shared, bounded `semantic.choice.v1` shadow provider. Its result cannot authorize a tool, remove evidence, load a model, train, or retry. The initial hook observes public search/page results only. Profiles explicitly admit capabilities.

## Validation recorded

- Runtime integrated suite: 800 tests passed after the final per-call output-cap change; build passed. Profile validation: 35 passed.
- SDK: 227 passed, including stream cancellation, framing, generated contract identity, and fail-closed compatibility checks.
- Trading chat: 26 focused route/outcome tests passed. Scripted provider plus real runtime dispatch tests prove search results enter the next model request and source text reaches the final answer; empty and failed searches have explicit behavior.
- Notes: 72 focused runtime integration, readiness, and local ownership tests passed after fixing circular-import canvas access and verifying tool-result acknowledgements.
- Music: 53 selected adapter, queue, memory, and truncation tests passed. Real assembled prompt names are canonical; budget checks include its schemas. Local receipts are checked before dispatch, repeated call IDs reuse results, and malformed arguments cannot enqueue jobs.
- Trading adapter: scoped/signature receipt checks, whitelist enforcement, deduplication, and total-budget tests passed. The repaired 20-case benchmark uses synthetic frozen fixtures and the streaming local-tool path. It is **not historical replay evidence**.
- Obsidian: seven production-code plugin tests, typecheck, and build passed. The installed entrypoint is `LLMSortObsidian/obsidian_plugin`, plugin ID `llm-autoresearch-wiki`.

Some HTTP fixture suites stall in this sandbox's restricted networking; bounded reruns with loopback support passed. Interrupted test processes were stopped before replacement.

## Live evidence

| Workflow | Recorded result | Scope |
| --- | --- | --- |
| Canonical news from trading container | `run-d72db108-4547-4a97-b472-6d8102b04b8f`: completed, search plus source-page read, 5,659 measured tokens, 3 model calls, 29.5 seconds | Read-only; actual source observations and provenance retained in runtime |
| Notes canvas read | `run-e8e2e954-7a52-4ba8-a896-2806aad5e207`: actual local executor returned the requested heading, final answer matched | Disposable in-memory canvas; earlier runtime release, rerun after final deployment |
| Obsidian vault write/read | `run-fa34641c-d25a-4438-95d6-2be169dba210`: completed, production vault helpers wrote and read the exact marker | Disposable filesystem vault, then removed; no user notes changed |
| Obsidian installed bundles | Both existing Windows vault plugin directories match source SHA-256 `13a64ce33b5938631ba0b35fcfa995ad865cc6b7f1f1c525ed16d0d26f8c5f34` | Settings preserved; runtime switch remains operator opt-in |

The legacy strategy HTTP canary returned text claiming a tool call and successful page retrieval without corresponding tool events. That response alone does not prove gateway execution. The canonical canary above records actual executor observations; no claim is made that the legacy production root cause was isolated inside Prism.

Wire identity verified against the NAS:
`runtime-wire.v1.0.0`, `sha256-de254c9c95a74bb1a3e13f21b33527cbd993a45a7cca40bdac36eedd9a79f84a`.
Installed SDK paths and file hashes are verified separately from checkout Git heads because consumers use a shared bind mount.

## Remaining acceptance gates

1. TinyModels live integration is blocked on the deployed System1 implementation. The Jetson reports the older feature-platform capability contract; `/v1/system1/status` and `/v1/training/capabilities` returned 404. GitHub checkout `c0f7f84` lacks the supplied working-tree lifecycle implementation. Existing SSH access to the identified Jetson account was rejected. Obtain the actual source/deployment connection before implementing or claiming guarded training, model loading/unloading, calibration, or shadow comparison results. `TINYMODELS_SHADOW_ENABLED` stays off.
2. Trading financial migration remains gated: 20 **historical** replays, measured route/capacity parity, and seven consecutive production canary days with the required receipt, policy, failure, and fallback evidence. `USE_V2_SDK` stays off. Legacy code is retained until those gates pass.
3. Obsidian production cutover needs provisioned scoped sessions and a refresh/login workflow. The installed bundle and disposable-vault path are validated; an expiring canary credential is not represented as durable user authentication.
4. Music remains opt-in pending complete application/UI handoff parity. Its deployed adapter passed a real library-read canary. Render/job mutations are validated using isolated fixtures rather than replaying user mutations.
5. Notes final route tests, deployment, and actual widget/persistence canary passed. The full plan must not be marked complete while any required acceptance gate above remains open.

## Final deployment checks

Deploy-kit completed `lazy-tool-service,trading-client,trading-service,music-player` with 4 passed / 0 failed at 18:07 PDT. Notes completed separately with 1 passed / 0 failed at 18:09 PDT. Container revisions verified: runtime `93ee284`, trading client `05a869ed`, trading service `4308a7a2`, Music `f5231a7`. Notes revision `a3b86d2` is healthy. All six affected NAS services returned HTTP 200 (the trading-service health request initially timed out during startup and passed on recheck).

The actual strategy HTTP endpoint completed chat `e4ebfd5e-7622-4e52-b387-51ba640bcf91`, correlated to durable run `run-1373a566-a731-4daf-9905-0fccdba226e3`. Its journal contains completed `global.web.search` and `global.web.read_page`; usage was 17,816 measured tokens across 3 model calls, 54.4 seconds. The read-only strategy runtime switch is enabled. Financial trading and Music switches remain off.

Installed SDK client SHA-256 matches the checkout: `4f467b5185e71105a25ebbf0a30ae8fb8e2be29ee31b65d11408125f20772b06`. The wire identity matches the digest above.


Final live application results:

- Music run `run-73778bee-9b8a-4bb2-8485-0a6055ba5cd4` completed after the real `music_list_songs` executor returned its result; no jobs were queued. The initial probe used the wrong container working directory and returned an explicit tool failure. Its empty test-created SQLite file was removed, and the successful probe used `/app/data`, matching the API entrypoint.
- Notes session `runtime-widget-canary-367894214e58473cac238b937c435c54`, runtime run `run-712415a8-a03e-4d29-83ec-47c999fa9681`, reached the actual HTTP agent path. `html_notes.canvas.upsert_widget` emitted a component containing the unique marker. A separate history read verified that marker in the saved **assistant canvas HTML**, not merely in the user's request. The SSE stream ended once with no errors. This used a fresh canary session, not an existing user canvas.
- Simpler Notes read prompts were answered by its existing local reply router and are not counted as shared-runtime acceptance evidence.
- Plugin bundles were installed in both existing vault directories with matching hashes; no user model settings, vault files, or credentials were overwritten. Desktop cutover remains explicitly pending scoped-session provisioning.
