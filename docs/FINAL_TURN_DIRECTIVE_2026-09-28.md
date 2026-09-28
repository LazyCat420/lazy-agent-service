# The forced final turn answered with a tool call (2026-09-28)

prism's agentic loop takes `maxIterations` tool turns and then forces one more
answer: it strips the tools and appends

    <iteration-limit>
    Maximum tool-call iterations reached for this turn. Summarize progress so far,
    report partial results, and state what remains to be done.
    </iteration-limit>

A trading agent's contract is a JSON artifact, not a progress summary. On
nemotron35 that turn came back empty on **169 of 170 bull and 166 of 168 bear
runs** that reached it (trading-service traces, 09-13 → 09-27), and 103 of 188
junior runs; every one then cost trading-service a second, tool-less repair
call. GLM answers it badly too (valuation 8 artifacts in 27, Board 6 in 20).

## Why it was empty

Replayed the stored forced turn of cycle-v3-1790464211 NSC `v3_bull_agent`
against the Jetson with logprobs: 35 completion tokens, content `""`, no
`tool_calls`. The tokens were

    <tool_call> <function=mcp__lazy-agent-service__get_market_data>
    <parameter=ticker> NSC </parameter> </function> </tool_call> <|im_end|>

— one more tool call, which a request with no tools returns as empty content.
The model did not accept that its tools were gone, and the notice asked for
something the contract forbids.

## The fix (this repo; prism is read-only upstream)

`applyTradingToolProtocol` appends `FINAL_TURN_DIRECTIVE` to prism's
`<iteration-limit>` turn when it is the last message and no tool is offered
(after the role filter). Only that turn changes, so every earlier turn keeps its
cached prefix. The request's receipt records `final_turn_directed`, which lands
in the trading `provider.payload` trace attributes.

## Evidence

Replayed on stored production forced turns (trading-service
`scripts/benchmarks/turn_wall_replay.py`: the exact traced payloads, the live
models on this shim, the production parser; the unchanged turn matched
production's outcome on 46 of 54 runs). Complete artifacts on the forced turn:

| Agent × model | unchanged | directive in the system prompt | **directive on the forced turn** |
|---|---|---|---|
| bull × nemotron35 | 0/12 | 11/12 (7 narrate the process) | **12/12** |
| bear × nemotron35 | 0/12 | 8/11 | **10/11** (the miss lacked `confidence`) |
| defense × nemotron35 | 7/11 | 11/11 (10 narrate) | **11/11** |
| junior × nemotron35 | 9/11 | 10/10 | **10/10** |
| Board / judge / valuation × GLM | 2/7 | 6/7 | **7/7** |

The production quality score of the artifacts was unchanged (bull 87.0 in
production after the repair, 87.1 written on the forced turn).

The same sentence placed in the tool contract (system prompt) instead of on the
forced turn also produced artifacts, but most of their summaries narrated the
process ("I have completed initial research…") — prism's "summarize progress"
leaking into the artifact. On the forced turn itself it did not.

## Verify in production

```js
// trading_bot: forced turns that got the directive, and what came back
db.pipeline_trace_events.find({stage: "provider.payload", "attributes.final_turn_directed": true})
```

Join each to the same run's `model.output` and `v3_agent_telemetry.artifact_repaired`;
compare with the baseline above. Tests: `src/services/__tests__/TradingToolProtocol.test.ts`
("prism's forced final turn", 3 of 5 go red with the directive disabled).
