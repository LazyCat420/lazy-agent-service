# Scheduled Task Model Dynamic Resolution & VllmShim Self-Healing (2026-09-18)

## 1. Incident & Root Cause

**Trace ID:** `65e79b19-ee8e-4a2d-b5ae-557712992b64`  
**Run ID:** `run_98cd4e27d964457e`  
**Failure:** `[ERROR] llm.generate:deepseek-v4-flash-0731: The model \`deepseek-v4-flash-0731\` does not exist.`

At 07:00 AM PDT (14:00:00 UTC), the daily scheduled task **"Daily Stock Deep Research"** (`id: 03c1061c-3cec-4b55-b45f-65ffe200059c`) fired.
- The task record in MongoDB (`COLLECTIONS.SCHEDULED_TASKS`) had `provider: "vllm-2"` and `model: "deepseek-v4-flash-0731"`, created on 2026-08-10 when Gold Spark hosted DeepSeek.
- Gold Spark (`10.0.0.141:8000`) was subsequently loaded with `GLM-5.3-Flash-EXL3`.
- `ScheduledTaskService.ts` blindly passed `resolvedModel: task.model` to `AgenticLoopService.runAgenticLoop`.
- `VllmShimService.ts` forwarded the request to `10.0.0.141:8000`, where vLLM returned HTTP 404: `The model 'deepseek-v4-flash-0731' does not exist.`
- The core trading cycle (`vllm-trading-bot`) was unaffected because it uses dynamic discovery (`get_live_model_from_vllm`), but scheduled tasks crashed on model swaps.

## 2. Solutions Implemented

### A. Just-In-Time Dynamic Resolution in `ScheduledTaskService.ts`
- In `executeTask()`, before creating the conversation document or starting the loop:
  - If `isVllmProvider(task.provider)`, probes the provider's `/v1/models` endpoint with a 2.5s bounded timeout.
  - Filters out embedding models and non-LLM models.
  - If `task.model` is not loaded on `task.provider`, auto-heals `resolvedModel` to the live generation model on that instance (e.g. `GLM-5.3-Flash-EXL3`), logs a warning, and asynchronously updates the MongoDB task record.
  - Passes the healed model to `settings`, `AGENT_CONVERSATIONS`, and `AgenticLoopService.runAgenticLoop`.

### B. Background Auto-Healing Daemon in `VllmModelSyncService.ts`
- Added `syncScheduledTasks()` to the 30-second background sync loop.
- Periodically checks enabled scheduled tasks in `COLLECTIONS.SCHEDULED_TASKS`.
- If a task's model is no longer loaded on its vLLM provider:
  - Checks if the model moved to another online vLLM instance and updates `provider`.
  - Otherwise, selects the active generation model on that provider (or global best candidate) and updates `model`.
  - Persists the update to MongoDB so the database and UI reflect live hardware without manual edits.

### C. 404 Auto-Healing Retry Layer in `VllmShimService.ts`
- Added `resolveUpstreamActiveModel(upstreamUrl)` and active model caching per upstream name.
- When proxying `/v1/chat/completions`: if the upstream returns HTTP 404 with body indicating the model does not exist, discovers the live model from `${upstreamUrl}/v1/models`, rewrites `body.model`, caches it, and automatically retries `fetchOnce()`.
- When `/v1/models` is queried, caches the active generation model.

## 3. Verification
- `VllmShimService.test.ts`: Added tests for `resolveUpstreamActiveModel` and model caching.
- `VllmModelSyncService.test.ts`: Added tests for `syncScheduledTasks` healing missing models, migrating providers, and preserving valid models.
- `ScheduledTaskModelSync.test.ts`: Added integration tests verifying `ScheduledTaskService.executeTask` dynamically substitutes live models and updates MongoDB.
- All 35 test files and 714 unit tests pass with zero regressions.
- `pnpm tsc --noEmit` clean.
