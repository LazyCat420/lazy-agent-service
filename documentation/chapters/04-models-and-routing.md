---
part: Runtime & Pipeline
type: spec
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/services/DynamicModelResolver.ts, lazy-agent-service:src/services/wallgarden/JetsonGate.ts, lazy-agent-service:src/services/wallgarden/WallgardenService.ts, lazy-agent-service:src/services/CanonicalProviderBudget.ts, lazy-agent-service:src/services/VllmModelSyncService.ts
---

# Models and routing

The service never hosts a model; it admits every generation to the LAN vLLM cluster through
`DynamicModelResolver`, which queries **all online local instances in real time** and picks a
box per role class. Cloud providers remain configured alternatives; local is simply preferred
and cheaper.

## The boxes

| Box | Serves | Role class | Notes |
|---|---|---|---|
| DGX Spark / Gold Spark (`vllm-2`) | DeepSeek (`DeepSeek-V4.1-Flash-1017`), GLM (`GLM-5.3-Flash-EXL3-TF`) | smart / large roles | also the harness2 improver default (`430d150`); streams `delta.reasoning_content` |
| Dell | Qwen coder/chat models | code + mid roles | openai-compat recovery exists for its malformed tool-call framings (`5cb9ecf`, `55d55ed`) |
| Jetson (`vllm`, `http://10.0.0.30:8000/v1`) | `nemotron35` (NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4, `max_num_seqs = 2`) | light / small roles: compression, summarization, wallgarden | served-ID pinned: `EXPECTED_JETSON_MODEL = "nemotron35"`; `/no_think` verified live (reasoning null) |
| Jetson (`:8001`) | `embeddinggemma-2` | embeddings only | shared queue, ch.06 |

Stale model IDs are normalized to the canonical served ID before admission
(`GLM-5.3-Flash-EXL3` → `GLM-5.3-Flash-EXL3-TF`); `VllmModelSyncService` keeps instance
catalogs in sync with what each box actually serves.

## Routing rules and fallback policy

1. **Class first.** Light/small roles prefer the Jetson; smart/large roles prefer Gold Spark
   (`vllm-2`). Vision needs a capable box; compression/summarization is light work.
2. **Health-gated admission.** Only instances answering the real-time probe are eligible.
3. **Single-box fallback.** If exactly one box is online, it takes all jobs — degraded but
   running, logged.
4. **Provider fallback.** Otherwise the first allowed provider that is online takes the call;
   an empty model reply is surfaced, and prism-style in-loop retry behaviour was ported during
   the cutover (ch.10 ADR-01). Nothing here retries across boxes unboundedly; a box that
   fails its probe is out for the round.

## Token budgets

- Compaction pressure fires at a configurable fraction (default **0.6**) of the model's
  context budget before overflow; a 24k output cap guards harness2 improver replies
  (`a3993ea`).
- Per-conversation budgets (`ConversationBudgetRegistry`, `CanonicalProviderBudget`,
  `BudgetPauseRegistry`) let callers pause/resume a run at budget close; trading runs get a
  tool budget whose close also closes tool offering (ch.03).
- Wallgarden and scheduled tasks resolve their model through the same resolver, so a
  background job can never starve an interactive run for boxes.

## The Jetson wallgarden gate

The Jetson has **two inference slots** (`max_num_seqs = 2`); before the gate, browser-driven
`classify-candidates` batches queued up to 24 requests on it (60–77 s to first token, 12 s
browser aborts) and starved interactive work. The gate (`320bd24`; now the `JetsonGate` class
in `src/services/wallgarden/JetsonGate.ts`, shared instance `wallgardenJetsonGate`):

- caps concurrent Jetson LLM calls from Wallgarden at **2** (`maxInFlight: 2`,
  `maxWaitMs: 90_000`),
- enforces strict priority with FIFO within each tier: **P0 interactive/creative**
  (`brainstorm`, `similar`, `extract-topics`) > **P1 curation** (`judge-topics`) >
  **P2 background** (`taste-profile`, `recommend-channels`),
- rejects queued P1/P2 requests after 90 s with `JetsonGateRejectedError` (HTTP 503) so
  background traffic fails fast,
- publishes live telemetry (`maxInFlight`, `inFlight`, `queued`, `rejected`) on
  `GET /api/wallgarden/models`.

`POST /api/wallgarden/classify-candidates` is **disabled** (returns
`{classifications: [], disabled: true}` with zero LLM calls): candidate filtering is
deterministic client-side plus the NAS grounding scorer. Unit coverage:
`src/services/wallgarden/__tests__/JetsonGate.test.ts` + `WallgardenService.test.ts`
(61/61 via testrun); deployed and verified on the NAS.
