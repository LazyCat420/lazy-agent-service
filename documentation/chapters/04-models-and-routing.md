---
part: Runtime & Pipeline
type: spec
status: verified
updated: 2026-11-14
last-verified: 2026-11-14
review-by: 2026-12-14
covers: lazy-agent-service:src/services/DynamicModelResolver.ts, lazy-agent-service:src/services/vllm/VllmShimService.ts, lazy-agent-service:src/services/wallgarden/JetsonGate.ts, lazy-agent-service:src/services/wallgarden/WallgardenService.ts, lazy-agent-service:src/services/CanonicalProviderBudget.ts, lazy-agent-service:src/services/VllmModelSyncService.ts, spark-console:console.py, spark-console:boxes.json, spark-console:dsv41-start.sh
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

## The `/vllm-shim/<box>` proxy & live model-swap auto-heal (`S-10`, `TCK-4016`)

`lazycat-sdk` direct harness streaming calls local LAN engines through
`/vllm-shim/:box/v1/*` (`src/services/vllm/VllmShimService.ts`) rather than hardcoding box IPs or
model names in caller containers:

- **Enabled upstreams:** `gold-spark` (`vllm-2`), `gold-spark-vision`, `jetson` (`vllm`), `dell1`
  (`qwen-dell1`), and `dell2` (`qwen-dell2`). Retired `jetson-2` (`10.0.0.61`) is disabled by
  default behind `ENABLE_JETSON_2=1` (`TCK-4016`, `e916932`), returning a fast `404` JSON without
  connect-timeout stalls and staying excluded from `GET /health` probes (`S-13`).
- **Dynamic `/v1/models` discovery & probe circuit-breaker:** `GET /vllm-shim/:box/v1/models`
  strips non-LLM entries (`gliner`, `market_cnn`, `timeseries_rnn`), populates missing
  `max_model_len` from TensorFold `/metrics` (`tensorfold_health:context_length`), and caches the
  live model ID per upstream. Failed probes (`502`/`503`/`504`) mark the upstream unreachable for
  60 s (`503` + `Retry-After` without hanging every turn on TCP timeouts).
- **`404` model-swap auto-heal (`S-10`, `f10b64d`):** when `spark-console` switches serving modes
  and an upstream answers `POST /v1/chat/completions` with HTTP `404` (`model does not exist`) for
  a caller's cached model name, `maybeAutoHealModel404` re-queries `/v1/models`, rewrites
  `body.model` to the live served ID, retries transparently, stamps response header
  `X-Vllm-Shim-Live-Model: <liveModel>` (flushed before SSE chunks as well as non-stream replies),
  and rewrites `"model"` in non-stream JSON bodies (`ReadLedgerAndShimLiveModel.test.ts`).

## Token budgets

- Compaction pressure fires at a configurable fraction (default **0.6**) of the model's
  context budget before overflow; a 24k output cap guards harness2 improver replies
  (`a3993ea`).
- Per-conversation budgets (`ConversationBudgetRegistry`, `CanonicalProviderBudget`,
  `BudgetPauseRegistry`) let callers pause/resume a run at budget close;
  `CanonicalProviderBudget` releases speculative reservations in full on zero-byte
  pre-telemetry stream failures so retries can proceed (ch.03). Trading runs get a tool
  budget whose close also closes tool offering (ch.03).
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

## Who decides what the Sparks serve: spark-console

The router above picks among models that are **up**; spark-console (`agents/spark-console`,
goldspark `:8800`) decides which one is up on the DGX Spark pair. Its box table
(`boxes.json`):

| Box | Address | Model endpoint | Managed how |
|---|---|---|---|
| `head` (Gold Spark, goldspark) | `10.0.0.141`, fabric `192.168.177.11` | engine `127.0.0.1:8001`; clients use the bench proxy on `:8000` | serving mode (below) |
| `worker` (MSI Spark, msi-spark) | fabric `192.168.177.12` | none of its own — the TP=2 second rank | serving mode; ComfyUI `:8188` |
| `dell1` / `dell2` | `10.0.0.37` / `10.0.0.131` | `:8888`, container `qwen38-flash-next-tf` | standalone: auto-launched by the reconciler |
| `jetson` | `10.0.0.30` | `:8000` (`nemotron35`) | not managed; watched for telemetry only |

Every deployment serves on `:8001`; `bench-proxy.py` owns `:8000` and forwards to it, recording
every request in the throughput ledger (ch.07). Console health probes the engine on `:8001`
directly, so a proxy that only returns its own 503 can never be reported as "LLM running".

### Serving modes (`MODE_CONFIG` in `console.py`)

| Mode | Served id (`pi_model`) | Deployment | Uses worker |
|---|---|---|---|
| `dual` | `deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision-Exp, vLLM TP=2 (1M ctx, 6 seqs) | yes |
| `single` | `deepseek-v4-flash-0731` | DeepSeek single-node EXL3 on goldspark (384K ctx, 1 seq) | **no** — msi-spark free for renders |
| `glmtf` | `GLM-5.3-Flash-EXL3-TF` | GLM-5.3-Flash EXL3, TensorFold TP=2 (1M ctx, 4 seqs) | yes |
| `glmtfablit` | `GLM-5.3-Flash-EXL3-TF-Abliterated` | same, abliterated (1M ctx, 1 seq) | yes |
| `qwen` | `qwen3.8-flash-next` | Qwen 3.8 Flash, TP=2 (262K ctx, 8 seqs) | yes |
| `dsv41` | `DeepSeek-V4.1-Flash-1017` | DeepSeek v4.1 Flash 1017, TensorFold TP=2 (512K ctx, 4 streams) | yes |
| `dsv41ablit` | `DeepSeek-V4.1-Flash-1017-Abliterated` | same with the abliteration overlay | yes |

Each mode names its `start`/`stop` scripts (`*-start.sh` / `*-stop.sh` in the spark-console
repo) and its container. `mode()` trusts the running container over `state.json`: if a known
container is up, that is the mode, and `state.json` plus `omp-model` are corrected to match.

### Mode switching — `POST /api/serving-mode/{new_mode}`

Under the operation lock:

1. An unknown mode → `400`; the current mode → `{"unchanged": true}`.
2. If anything is running (`phase != "stopped"` or any owned container exists), the outgoing
   deployment is **fully stopped, containers gone**, before anything else happens. Two
   deployments at once exceed unified memory and OOM the box (ch.10 ADR-16).
3. `state.serving_mode` is saved, and the new mode's `pi_model` is written to `omp-model`. pi
   does not fail on an unknown model id — it sends it and the server 404s — so this file is
   what keeps the omp session talking to the model that is actually up.
4. The omp session is restarted, because the MCP bridge reads `serving_mode` once at startup
   to decide whether worker render tools are safe (only in `single`).
5. If the LLM toggle was on, the new deployment is started in place of the old one.

Callers of this harness see the switch as goldspark going down and coming back with a different
model id; the resolver's real-time probe takes the box out of rotation while it is down, and
`VllmModelSyncService` picks the new id up once it answers. `bench-proxy.py` is a separate
process from the console on purpose: restarting the console never drops an in-flight completion.

### ComfyUI render-permit — `POST /api/render-permit`

ComfyUI's `spark_console_guard` custom node calls this before any prompt queues. The caller is
identified by source IP: the worker's hook arrives over the fabric from `192.168.177.12`, the
head's over loopback.

- **Worker render, mode without worker (`single`)** → `{"concurrent": true}`; the LLM keeps
  answering and nothing is torn down.
- **Any other case** (head render, or a TP=2 mode spanning both boxes) → the LLM is stopped with
  `suspend=True` and the reply carries `llm_was_up`. The render then has the memory.
- **Coming back.** The reconciler (every 30 s) restarts a suspended LLM only when `auto_resume`
  is on, the LLM toggle is on, and every *contending* ComfyUI queue (both boxes in TP=2 modes,
  only the head in `single`) has been empty for `AUTO_RESUME_IDLE_S` = 300 s.

`/api/omp/mcp-render/{onoff}` separately allows or denies the omp session's MCP render tools,
the ones that would queue GPU work on its own box.

### The DeepSeek v4.1 TensorFold deployment (`dsv41`, `dsv41ablit`)

Folded from spark-console's chapter 02. Both modes run `DeepSeek-v4.1-Flash-1017` on
the TensorFold native engine at TP=2 across goldspark and msi-spark, 2.9-bpw EXL3
(`Mia-AiLab/DeepSeek-V4.1-Flash-1017-EXL3-EAQ-v1-2.9-bpw`, pinned 39-shard checkpoint, plus the
unquantized Engram tables), container `dsv41-1017-exl3-tf`, with vision and DSpark speculative
decoding. The abliterated mode applies the gated overlay
`drowzeys/keys-DeepSeek-V4.1-Flash-1017-Abliterated` and serves
`DeepSeek-V4.1-Flash-1017-Abliterated`.

- **Fabric.** Direct ConnectX-7 link `192.168.177.11` ↔ `192.168.177.12` (RoCE, MTU 9000). A
  containerized NFSv4 server (`dsv41-nfs`, `fsid=0`) exports the HF cache to the worker over
  that link. `reclaim-page-cache-nodes.py` frees unified memory and page cache on both nodes
  before launch.
- **Launcher tuning (2026-10-21, 2026-10-29).** `dsv41-start.sh` / `dsv41-ablit-start.sh` export
  `POOL=2097152`, `KV_SHARD=1`, `PREFILL_INTERLEAVE_MS=500` and pass `--prompt-cache-gib 2`.
  Under `KV_SHARD=1` each node owns half the KV pool and every stream's extent must fit in one
  half; with the derived `POOL=1052672`, ~164K-token agent prompts fit only 2–3 streams and the
  rest returned `error.ContextFull` and sat in the queue. `POOL=2097152` gives each node
  1,048,576 positions, enough for all 4 streams. The 500 ms interleave lifts decode's duty
  cycle during 100K+ prefills (250 ms gave ~14%), and the 2 GiB prompt cache stopped the
  cold-prefill thrash on multi-turn agent work (93% cache hits, turn latency 8.5 s → 1.1 s).
  `ROUND_ROWS` stays at 16 — the AOT kernels' CUDA graphs are captured for 16-row batches.
- **Measured.** ~79 tok/s single stream with speculative drafting; 128.8 tok/s aggregate over
  8 concurrent 120-token streams.
- **Boot race (2026-11-03).** If goldspark booted before msi-spark, the start script failed its
  SSH to the worker and the phase stuck at `error`. The scripts now poll the worker's SSH for
  up to 36 s, and the reconciler retries an `error` phase under `can_autoheal_restart()` (at
  most 3 restarts in 15 min).

### The Dell Qwen boxes (standalone)

Folded from spark-console's chapter 03. `dell1` and `dell2` each run
`Qwen3.8-Flash-Next` on a single DGX Spark (TensorFold, `:8888`). `reconcile_remote_llms_locked()`
runs at boot and on every 30 s reconciler pass; `remote_llm_desired(box)` defaults to on for a
configured standalone box and honours an operator stop (`POST /api/box/{box}/llm/off`). Both
Dells serve the same model id, so throughput history sums them per model (ch.07).
