# Adapting the trading desk to the prism build of 2026-09-27

prism-service was redeployed at 2026-09-27 19:36 PDT (image built 19:35 PDT). The image it replaced
was built on 2026-08-21, so five weeks of prism changes reached the trading desk at once. The
2026-09-28 market-open cycle (`cycle-v3-1790602200`) and the four order-trigger cycles after it
showed four new failure classes. Every fix below is on our side: the proxy and MCP adapter in this
service. Audit with the full evidence: `trading-service/docs/audits/2026-09-28-cycle-audit-prism-upgrade.md`.

## 1. Approval cards nobody answers (fixed: `markUnattended`)

prism now asks for approval before an MCP call whose arguments repeat text the run read from a tool
result (its taint check). Full auto does not answer that ask, and the gate has no timeout. A
trading run has no person, so the run waited until trading-service's 1,800 s agent timeout:

| When (PDT) | Agent | Tool | Cost |
|---|---|---|---|
| 06:37:38 | BA junior analyst | `scrape_url` | 30 min, ticker aborted |
| 06:37:44 | PLTR junior analyst | `scrape_url` | 30 min, ticker aborted |
| 07:13:30 | CRH valuation analyst | `whiteboard_annotate` | 30 min, Board decided without valuation |

prism's log line is `[AutoApproval] 0 auto-approved, 1 need approval: mcp__lazy-agent-service__scrape_url`.
`PrismProxyService` now sends `unattended: true` on every trading `/agent` request. That is prism's
own field for runs with no person (its scheduled tasks and benchmarks send it); the same ask becomes
an immediate denial the model reads as a tool result.

Still open: annotating our MCP tools (`readOnlyHint` for read-only tools, `openWorldHint: false` for
the whiteboard) would let these calls run instead of being denied. prism fingerprints annotations,
so that change quarantines every tool until `POST /mcp-servers/<id>/tools/approve`; do it outside
market hours and approve in the same step.

## 2. Tool results replaced by an empty preview (fixed: `ModelVisibleToolResult.ts`)

prism now passes a tool result whole only while `JSON.stringify(result)` is at most 8,000
characters and no top-level array (or an array under `events`, `products`, `trends`, `articles`,
`earnings`, `predictions`, `commodities`) holds more than 10 items. Anything else is offloaded; the
model gets whole leading lines of the pretty-printed result and a pointer to
`retrieve_offloaded_content`.

The trading bridge answered as an OpenAI tool message, `{role, tool_call_id, name, content,
service_source}`, with the whole result as one escaped string. The pretty print was seven lines,
so the preview was the four wrapper keys and nothing else. On 2026-09-28: 13 of 13
`get_finnhub_news` results and 7 of 22 `whiteboard_read` results reached the model as that stub
(0 of 249 tool results on 2026-09-25).

`McpAdapter` now sends a bridge result's `content` itself (no wrapper, no second escape) and cuts it
to 7,600 characters as prism measures it, keeping whole lines (text) or shortening the longest
strings, then lists (JSON), with a note saying what went. It also pre-empts the 10-item list cap.
Every other result is unchanged. On the stored 2026-09-28 results: news 10,743 → 7,205 characters,
15 of 22 lines kept; the whiteboard section 9,103 → 7,600 with its identity fields intact.

## 3. A refused tool call now fails the pass (removed at its source by 2)

The model obeyed the offload pointer and called `retrieve_offloaded_content`. No trading role is
granted it, so `TradingToolStream` refused the call and ended the stream. The new prism build
(its change dated 2026-09-23) fails a stream that ends without a `finish_reason` ("The vllm stream
ended before the response completed (no finish_reason)") where the old build accepted it. Five junior passes died this way
(CRH once, VZ twice, ALLY twice), two tickers aborted by the circuit breaker. With 2 in place the
pointer no longer appears for bridge results; a refused call from any other cause still ends the
stream, which prism now counts as a failed pass.

## 4. The forced final turn changed shape (fixed: `isForcedFinalTurn`)

prism now keeps the tool catalog on its `<iteration-limit>` turn and sends `tool_choice: "none"`
instead of removing the tools. `FINAL_TURN_DIRECTIVE` (b645d4f) only fired when the catalog was
gone, so it fired on 0 of 6 wall turns on 2026-09-28 and every nemotron wall answer was still empty
(bull, bear, bull defense, junior; each rebuilt by a repair call). The directive now also fires
when the catalog is kept but `tool_choice` is `"none"`. Replay of the stored new-shape wall turns
(trading-service `scripts/benchmarks/turn_wall_replay.py --since 2026-09-28T02:40:00 --wall-only
--arms asis,wallmsg --repeats 2`, 5 nemotron and 1 GLM case): nemotron as sent 0 of 10 artifacts
(calibration: production was empty on all of them), with the directive 10 of 10 complete artifacts,
quality 75–88 (production's repaired answers scored 85–87); the GLM judge 2 of 2 either way.
