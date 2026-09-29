# Probe faults for trading's boundary contract probe (2026-09-29)

Commit `fb384a2`, deployed 2026-09-29 07:13 UTC. Code: `src/services/ProbeFault.ts`, hooks in
`src/services/vllm/VllmShimService.ts` (the shim) and `src/services/ToolDispatch.ts` (MCP/REST dispatch).
Tests: `src/services/__tests__/ProbeFault.test.ts`.

## Why

trading-service's boundary probe (`app/audit/boundary_probe.py`; guide: trading-client
`documentation/chapters/08-audit-tools.md`) checks, daily and after every prism or lazy-agent-service
redeploy, that the contracts the desk depends on still hold. Two of them only show when something breaks:

- how prism reports a model stream that ends without a `finish_reason` (with the prism build of
  2026-09-27 it became a failed pass: five junior passes on 09-28), and
- whether trading's stream watchdog ends a tool call that hangs (a call parked on an approval cost
  30 minutes per desk on 09-28).

These faults make both happen on demand instead of waiting for production to fail.

## What fires, and when

A fault fires only when the **signed** trading tool context (minted by `/prism-proxy` from the task's
`## Cycle:` line and verified by HMAC in `TradingToolContext.ts`) names a cycle matching
`^probe-boundary-\d+-fault-(cut|toolstall)$`:

| Fault | Where | What happens |
|---|---|---|
| `cut` | the shim, after the trading payload is prepared and recorded | answers `200 text/event-stream` with one delta (`"content": "probe"`, `finish_reason: null`) and ends the response: no `finish_reason`, no `[DONE]`, and no call to the model box |
| `toolstall` | tool dispatch, after authorization | waits `PROBE_TOOL_STALL_MS` (default 240,000 ms), then returns `{"error": "PROBE_TOOL_STALL", "is_error": true}` without running the tool |

Production cycle ids (`cycle-v3-*`) never match; a tool result or a web page cannot set the signed
cycle id; `PROBE_FAULTS_ENABLED=0` turns both off. Each firing logs
`probe fault injected: cut stream|toolstall ...`, which the ops-recorder keeps as a `probe_fault_injected` event.

## First use

`probe-1790666085` (2026-09-29 07:14 UTC, nemotron35): the cut stream ended the call in about a second
(prism: "The vllm stream ended before the response completed (no finish_reason)"; trading classifies it
`RuntimeError`, which it does not retry), and trading's watchdog ended the hung tool after 47 s in the
tool phase and stopped the run in prism.
