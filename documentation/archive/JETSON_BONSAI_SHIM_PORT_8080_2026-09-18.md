---
part: Archive
status: superseded
type: record
updated: 2026-10-23
---

> **Archived 2026-10-23.** The page itself is marked superseded 2026-10-19: the Bonsai llama.cpp server on :8080 is gone and vLLM `nemotron35` serves on :8000. Current: [12 - Wallgarden Jetson gate](../chapters/12-wallgarden-jetson-gate-2026-10-20.md).
> Kept for history; do not use as current.

# Jetson Bonsai Port Alignment & VLLM Shim Routing (2026-09-18)

> **Superseded 2026-10-19.** The Bonsai llama.cpp server on `:8080` is gone
> (connection refused); vLLM `nemotron35` serves on `:8000`. The shim's
> `jetson` upstream defaults to `http://10.0.0.30:8000` again, and the
> 8080/8000 dual-port fallback was removed — it sent every Jetson call to the
> dead port first (957 fallbacks in trading cycle `cycle-v3-1792387891`).
> Override with `VLLM_SHIM_JETSON_URL` if the LLM moves.

## 1. Context & Problem

The Jetson Orin (`10.0.0.30`) hosts two distinct model-serving containers:
1. **Port 8000**: `jetson-inference-service` — a FastAPI/Uvicorn microservice providing specialized extractors (`gliner`, `market_cnn`, `timeseries_rnn`). It does **not** host an LLM or implement `/v1/chat/completions`.
2. **Port 8080**: `llama-bonsai-orin:latest` (`bonsai-ptq1`) — serving `prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0` with 262,144 context tokens on llama.cpp server with OpenAI-compatible routes.

Previously, `VllmShimService.ts` in `lazy-agent-service` hardcoded `UPSTREAMS["jetson"]` to `http://10.0.0.30:8000`.
When AI Strategy Chat in `trading-client` initiated an agent session targeting `prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0`, Prism routed through `http://10.0.0.16:5591/vllm-shim/jetson/v1/chat/completions`.
The shim forwarded the request to `10.0.0.30:8000`, causing Uvicorn to return `404 {"detail":"Not Found"}` and crashing iteration 1 of the agent chat loop.

## 2. Changes Applied

### A. Default Upstream & Dynamic Lookup (`VllmShimService.ts`)
- Updated `UPSTREAMS["jetson"]` default from `http://10.0.0.30:8000` to `http://10.0.0.30:8080`.
- Enhanced `resolveUpstream()` to read `process.env.VLLM_SHIM_JETSON_URL` dynamically with fallback to port 8080.
- Updated `docker-compose.yml` to supply `- VLLM_SHIM_JETSON_URL=${VLLM_SHIM_JETSON_URL:-http://10.0.0.30:8080}`.

### B. Non-LLM Model Filtering (`VllmShimService.ts`)
- Introduced `NON_LLM_MODELS = new Set(["gliner", "market_cnn", "timeseries_rnn"])`.
- Added `filterModels()` to intercept `/v1/models` responses through the shim. Any non-LLM feature models are automatically stripped from `data` and `models` arrays, preventing them from polluting Prism's LLM registry or client dropdowns.

### C. Unit Test Verification (`VllmShimService.test.ts`)
- Updated upstream resolution assertions for Jetson to `http://10.0.0.30:8080`.
- Added test verifying dynamic override via `VLLM_SHIM_JETSON_URL`.
- Added tests verifying `filterModels()` correctly prunes `gliner`, `market_cnn`, and `timeseries_rnn` while keeping `prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0`.
