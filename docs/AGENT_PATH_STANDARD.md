# Agent Execution Path Standard

**Status:** Adopted 2026-10-02. This is the ecosystem-wide answer to "which path
should an agent consumer use?" — superseding per-repo comments and scattered
audit notes.

## The standard

**All new agent consumers MUST integrate through the canonical run API:
`POST /v1/runs` on lazy-agent-service (:5591), with a profile and the
lazycat-sdk `RuntimeClient` (or `ObsidianRuntimeClient` for browser
contexts).** Admission, capability resolution, context receipts, evidence
records, and contract-version negotiation are properties of that path and of
no other.

Legacy `/agent` and `/chat` are **deprecated for new consumers** and remain
supported for existing ones until each completes the adoption checklist
(`docs/contracts/consumer-adoption-checklist.md`).

`/prism-proxy` is **reserved for workloads bound to prism-owned guardrails**
(currently: trading-service V3 desks — approval gate, tool catalog, forced
final turn). Do not route new workloads through the proxy to avoid adopting
the canonical path.

Direct prism (:7777) and raw vLLM endpoints are **out of scope for the
harness contract**: they never had admission, and standardizing them is each
owner's call (lupos-bot's contract tests are its own standard; bittle-agent
has no loop at all).

## The five paths, ranked

| Rank | Path | Verdict |
|---|---|---|
| 1 | `/v1/runs` (canonical) | **Required for new consumers.** Profiles, receipts, evidence, contract negotiation. |
| 2 | `/prism-proxy` (decorated → prism) | **Approved, narrow use.** When prism's approval gate/catalog is the requirement. |
| 3 | Legacy `/agent`/`/chat` (:5591) | **Deprecated for new consumers; migrate existing.** |
| 4 | Direct prism :7777 | **Legacy; owner's discretion** (lupos-bot, music-player). |
| 5 | Raw vLLM endpoints | **Out of scope** (bittle-agent, model discovery). |

## Current consumer register (post-standardization, 2026-10-02)

| Consumer | Path | Profile | Flag/default | Status |
|---|---|---|---|---|
| html-notes | canonical | `html-notes-canvas-v1@1.2.0` | `USE_SHARED_RUNTIME=true` **live** | ✅ standardized |
| html-notes news pipeline | `/execute/news_search` (capability call, no loop) | n/a | always | ✅ correct — capability calls need no run |
| html-notes prism-mode fallback | direct prism | persona-less | when runtime fails | ⚠️ accepted fallback |
| LLMSortObsidian foreground | canonical → prism → local | `obsidian-vault-agent-v1@1.0.0` | `useSharedRuntime=true` | ✅ standardized |
| LLMSortObsidian background | canonical (same tiering) | `obsidian-vault-agent-v1@1.0.0` | same flag | ✅ standardized (`55197fb`) |
| lazy-agent-service timers | canonical admission (`InternalLoopRunner`) | `internal-agent-v1@1.0.0` | `INTERNAL_AGENT_PROFILE` | ✅ standardized (`73e04ac`) |
| lazy-agent-service scheduled tasks | canonical admission | `internal-agent-v1@1.0.0` | same | ✅ |
| lazy-agent-service orchestrator sub-agents | canonical admission | `internal-agent-v1@1.0.0` | same | ✅ |
| trading-service V3 desks | `/prism-proxy` → prism | persona `CUSTOM_V3_*` | — | ✅ intentional (prism guardrails) |
| trading-service junior analyst | canonical (SDK adapter) | `trading-junior-analyst-v1` | `USE_V2_SDK` (off) | ⚠️ gated pending canary |
| trading-client strategy chat | canonical | `trading-strategy-chat-v1@1.2.0` | `STRATEGY_CHAT_RUNTIME_ENABLED` (off) | ⚠️ gated pending canary |
| music-player | direct prism | persona `CUSTOM_MUSIC_PLAYER` | — | owner's discretion |
| scraper-service | direct prism | none (own identity) | — | ✅ identity fixed (`c97fe420`) |
| lupos-bot | direct prism | agent LUPOS, budget-pinned | — | owner's discretion (contract-tested) |
| bittle-agent | raw vLLM | none | — | out of scope |

## Rules

1. **New consumer → canonical path first.** The adoption checklist defines
   the steps; html-notes is the reference implementation.
2. **No silent flag flips.** A consumer migrating paths must verify both
   surfaces produce comparable outcomes before flipping the default (the
   html-notes A/B of 2026-10-02 is the template), and the flip must be
   announced in the repo's handoff notes.
3. **One project identity per consumer.** `x-project`/`x-username` (prism)
   and `app_id`/`session_id` (runtime) must name the consumer, never a
   sibling. scraper-service's `vllm-trading-bot` default was the cautionary
   example.
4. **Fallbacks must be explicit and observable.** A silent degradation
   (scraper's prism filter) is a defect; a graceful tiered fallback
   (Obsidian) is the pattern.
5. **Internal callers of lazy-agent-service go through `InternalLoopRunner`,
   not raw `AgenticLoopService`.** The loop façade stays available for
   non-admission contexts, but anything wanting receipts goes through
   admission.
6. **Contract-version pinning:** clients pin `HTML_NOTES_CONTRACT_VERSION`-
   style constants; the runtime negotiates by the documented compatibility
   rule (same major, minor ≥ required).

## Explicitly NOT being standardized (and why)

- **trading-service V3 desks stay on `/prism-proxy`.** The approval gate
  (unattended + 24-char copy detection), the curated tool catalog, and the
  forced final turn are prism-owned enforcement for an unattended
  money-adjacent agent. Reimplementing them on our side would duplicate —
  and likely weaken — a safety boundary. Lazy-agent-service's role is
  signing (`TradingToolContext`) and annotations (`McpToolAnnotations`);
  experiment arms can use the canonical path via the trading profiles
  without moving production desks.
- **lupos-bot stays direct-prism.** It is the most disciplined consumer:
  budget-pinned, contract-tested, deliberate.
- **bittle-agent stays raw-vLLM.** It has no agent loop; there is nothing
  to standardize.
- **drift-king, braindeadbot, portal:** no LLM/agent traffic (portal reads
  prism Mongo for dashboards only).
