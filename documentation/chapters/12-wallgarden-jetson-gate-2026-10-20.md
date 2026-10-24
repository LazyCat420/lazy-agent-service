---
part: Models and routing
status: shipped
updated: 2026-10-20
review-by: 2026-11-03
type: record
---

# Chapter 12 — Wallgarden Jetson (`nemotron35`) Priority Gate & Candidate Classification Cutoff (2026-10-20)

## Context & Root Cause
The `youtube-wallgarden` Discovery Feed calls `lazy-agent-service` (`/api/wallgarden/*`), which routes local LLM requests to the Jetson vLLM instance (`http://10.0.0.30:8000/v1`, serving `nemotron35` / `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` with `max_num_seqs = 2`).

Audit findings on `2026-10-20`:
1. `EXPECTED_JETSON_MODEL` in `src/services/wallgarden/WallgardenService.ts` was still hardcoded to `"cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit"`, causing a false warning on every request before runtime fallback selected `nemotron35`.
2. Unbounded concurrent browser requests—dominated by `POST /wallgarden/classify-candidates` firing on every feed batch—queued up to 24 requests on the 2-slot Jetson vLLM (`ttg` 60–77s), causing browser timeouts (`AbortError` after 12s) and starving high-value topic generation (`extract-topics`, `brainstorm`, `similar`).

## Changes (`320bd24`)
1. **Pinned `EXPECTED_JETSON_MODEL = "nemotron35"`** in `src/services/wallgarden/WallgardenService.ts`.
2. **In-Process 2-Slot Priority Semaphore (`runWithJetsonGate`)**:
   - Caps concurrent Jetson LLM calls from Wallgarden at `MAX_IN_FLIGHT = 2`.
   - Enforces strict priority ordering (FIFO within each tier):
     - **Priority 0 (Interactive / Creative Generation)**: `brainstorm`, `similar`, `extract-topics`
     - **Priority 1 (Curation)**: `judge-topics`
     - **Priority 2 (Background)**: `taste-profile`, `recommend-channels`
   - Rejects queued requests with `priority >= 1` after `90,000ms` with `JetsonGateQueueTimeoutError` (`HTTP 503`) so background traffic fails fast instead of saturating the Jetson queue.
   - Exposes live gate telemetry (`maxInFlight`, `inFlight`, `queued`, `rejected`) on `GET /api/wallgarden/models`.
3. **Disabled `POST /api/wallgarden/classify-candidates`**:
   - Route in `src/routes/WallgardenRoutes.ts` immediately returns `HTTP 200` with `{ classifications: [], disabled: true }` and **zero** LLM calls. Candidate filtering is handled deterministically by the client-side rules and the NAS `brain_graph.py` grounding scorer.
4. **Verified `/no_think` on `nemotron35`**:
   - Live probe against `http://10.0.0.30:8000/v1/chat/completions` confirmed `reasoning_content: null` and `completion_tokens: 5`, so no extra template flags were required.

## Verification
- Unit tests in `src/services/wallgarden/__tests__/WallgardenJetsonGate.test.ts` and `src/services/wallgarden/__tests__/WallgardenService.test.ts` (`61/61` tests passing via `testrun`).
- Deployed to Synology NAS (`10.0.0.16:5591`) and verified `GET /api/wallgarden/models`.
