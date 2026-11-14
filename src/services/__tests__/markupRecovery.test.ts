/**
 * S-06 (LF-02 / LF-22): tool calls written as text markup are recovered honestly on BOTH the
 * stream path (parseSSEStream) and the shim non-stream path (normalizeToolCalls) through the one
 * shared extractMarkupToolCalls; an unterminated tool call is never executed from guessed
 * arguments and never returned as a final answer - it surfaces through the existing CUT_OFF /
 * length handling. Fixtures are stored model outputs (docs plan 2026-11-13-s06 section 2); F7 is
 * the grammar-derived V4.1 head the blob writer capped. The F4 fixture is single-escaped (real
 * newlines) per the S06Build ruling: the plan's stored double-escaped bytes (literal backslash-n
 * between the tags) parse to nothing - no call, no cut - and can never yield the pinned limit: 6.
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractMarkupToolCalls,
  hasUnterminatedToolMarkup,
  hasUnparseableToolMarkup,
  parseSSEStream,
  stripMarkupToolCalls,
  type SSEStreamChunk,
} from "../../utils/openai-compat.ts";
import { runCoreLoop } from "../../core/loop/CoreLoop.ts";
import { okTool } from "../../core/loop/__tests__/fakes.ts";
import type { CoreLoopEvent, CoreLoopResult, CoreModel, CoreTool } from "../../core/loop/types.ts";
import type { StreamChunk } from "../../types/provider.ts";
import { VllmShimService } from "../vllm/VllmShimService.js";

const F1_GLM_RH = "<tool_call>mcp__lazy-agent-service__run_equation<arg_key>code</arg_key><arg_value>\nimport numpy as np, pandas as pd\n\nclose = df['close']\nz_rev = (close / close.rolling(63).mean() - 1.0)\nmom_63 = close.pct_change(63)\nH = 10\nfwd = close.shift(-H) / close - 1.0\n\nmask_dn = (z_rev < -0.10) & (mom_63 < 0)\nmask_up = (z_rev < -0.10) & (mom_63 >= 0)\n\nr_dn = fwd[mask_dn].dropna()\nr_up = fwd[mask_up].dropna()\nbase = fwd.dropna()\n\nn_base = len(base)\nm_base = float(base.mean())\nh_base = float((base > 0).mean())\n\nresult = n_base\n</arg_value><arg_key>ticker</arg_key><arg_value>RH</arg_value></tool_call>"; // pipeline_trace_blobs db6172ee... (2026-10-19), verbatim

const F2_GLM_LMT = "<tool_call>whiteboard_read<arg_key>section</arg_key><arg_value>quant_report</arg_value><arg_key>ticker</arg_key><arg_value>LMT</arg_value></tool_call><tool_call>whiteboard_read<arg_key>section</arg_key><arg_value>fundamental_report</arg_value><arg_key>ticker</arg_key><arg_value>LMT</arg_value></tool_call><tool_call>whiteboard_read<arg_key>section</arg_key><arg_value>valuation_report</arg_value><arg_key>ticker</arg_key><arg_value>LMT</arg_value></tool_call><tool_call>whiteboard_read<arg_key>section</arg_key><arg_value>desk_note</arg_value><arg_key>ticker</arg_key><arg_value>LMT</arg_value></tool_call><tool_call>get_parameters</tool_call>"; // pipeline_trace_blobs 4252210d... (2026-10-22), verbatim; five calls

const F3_QWEN_JPM = "<tool_call>\n<function=get_upcoming_events>\n<parameter=ticker>\nJPM\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=list_scheduled_research>\n</function>\n</tool_call>\n<tool_call>\n<function=list_watches>\n<parameter=ticker>\nJPM\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=screener_query>\n<parameter=filters>\n[\"ticker:eq:JPM\"]\n</parameter>\n<parameter=columns>\n[\"ticker\", \"price\", \"rsi_14\", \"short_float_pct\", \"perf_week_pct\", \"perf_month_pct\", \"target_price\", \"target_upside_pct\", \"recom_score\", \"news_count_7d\", \"funds_net_activity\", \"congress_sells_90d\", \"sma50_dist_pct\", \"w52_high_dist_pct\"]\n</parameter>\n</function>\n</tool_call>"; // pipeline_trace_blobs 3ddf2741... (2026-11-03, Qwen3.8-Flash-Next), verbatim; four calls

const F4_QWEN_NVDA = "<tool_call>\n<function=lazy_web_search>\n<parameter=query>\nNvidia data center partners limit China sales 49% FT November 2026\n</parameter>\n<parameter=limit>\n6\n</parameter>\n</function>\n</tool_call>"; // pipeline_trace_blobs a7a05992... (2026-11-03), single-escaped from the stored double-escaped form

const F5_MINIMAX = "<tool_call>\n{\"name\": \"get_technical_indicators\", \"parameters\": {\"symbol\": \"PNC\", \"indicators\": [\"rsi\", \"macd\", \"bbands\"]}}\n</tool_call>"; // llm_audit_logs.raw_response (MiniMax, PNC), markup portion verbatim; real "parameters" key, which the JSON body parser (openai-compat.ts:822, arguments-only) drops to {}

const F6_DSML_V41_TAIL = "</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"; // pipeline_trace_blobs c2d163cf... (2026-10-27), verbatim stored closing-tag bytes; head capped out by the blob writer

const F7_DSML_V41 = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"whiteboard_write\">\n<｜DSML｜ parameter name=\"ticker\" string=\"true\">SWBI</｜DSML｜ parameter>\n<｜DSML｜ parameter name=\"content\" string=\"false\">{\"thesis\":\"bull\"}</｜DSML｜ parameter>\n</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"; // F6 tail after openers/tag names of the reference grammar DsmlDialect::V41 (tool-parser deepseek_dsml.rs: block ' calls'; invoke/parameter carry a leading space; name=... + string=true|false attrs) — documented grammar, not an invented shape

const F8_DSML_LEGACY = "<｜tool calls｜><｜tool_call｜>{\"name\": \"get_stock_price\", \"arguments\": {\"ticker\": \"SWBI\"}}<｜end of tool call｜>"; // shipped code fixture VllmShimToolParser.test.ts:18 (the shim's own recorded DeepSeek form)

const U1_UNTERM_BAC = "<tool_call>\n<function=emit>\n<parameter=dummy>\nx\n</parameter>\n</function>\n</tool_"; // cycle_audit_log cycle-v3-1794427674 (BAC, Qwen3.8-Flash-Next) at: excerpt, verbatim — the real cut-off call (shim.md F2)

const U2_UNTERM_GLM_CUT = "<tool_call>mcp__lazy-agent-service__run_equation<arg_key>code</arg_key><arg_value>\nimport numpy as np, pandas as pd\n\nclose = df['close']\nz_rev = (close / close.rolling(63).mean() - 1.0)\nmom_63 = close.pct_change(63)\nH = 10\nfwd = close.shift(-H) / close - 1.0\n\nmask_dn = (z_rev < -0.10) & (mom_63 < 0)\nmask_up = (z_rev < -0.10) & (mom_63 >= 0)\n\nr_dn = fwd[mask_dn].dropna()\nr_up = fwd[mask_up].dropna()\nbase = fwd.dropna()\n\nn_base = len(base)\nm_base = float(base.mean())\nh_base = float((base > 0).mean())\n\nresult = n_base\n</arg_value><arg_key>ticker</arg_key><arg_value>RH</arg_va"; // F1 truncated before its final closing tag — same mid-tag cut style as U1

const U3_UNTERM_DSML_CUT = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"whiteboard_write\">\n<｜DSML｜ parameter name=\"ticker\" string=\"true\">SWBI</｜DSML｜ parameter>\n<｜DSML｜ parameter name=\"content\" string=\"false\">{\"thesis\":\"bull\"}</｜DSML｜ parameter>\n</｜DSML｜ param"; // F7 truncated mid-closing-tag; matches the reference parser's partial-tag case (deepseek_dsml.rs partial_parameter_regex / strip_dsml_trailing)

function sseStream(contents: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const body =
    contents.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`).join("") +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  ).body!.getReader();
}

async function streamToolCalls(contents: string[]): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  const chunks: SSEStreamChunk[] = [];
  for await (const chunk of parseSSEStream(sseStream(contents), { label: "test" })) chunks.push(chunk);
  return chunks
    .filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => typeof c !== "string" && c.type === "toolCall")
    .map((c) => ({ name: c.name, args: c.args }));
}

interface ShimToolCall { id: string; type: string; function: { name: string; arguments: string } }
interface ShimResponse {
  choices: Array<{ message: { role: string; content: string | null; tool_calls?: ShimToolCall[] }; finish_reason?: string }>;
}

function shimToolCalls(content: string): Array<{ name: string; args: unknown }> {
  const normalized = VllmShimService.normalizeToolCalls({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  } as ShimResponse);
  return (normalized.choices[0]?.message.tool_calls ?? []).map((call) => ({
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as unknown,
  }));
}

async function runLoop(options: Parameters<typeof runCoreLoop>[0]): Promise<{ result: CoreLoopResult; events: CoreLoopEvent[] }> {
  const events: CoreLoopEvent[] = [];
  const generator = runCoreLoop(options);
  for (;;) {
    const step = await generator.next();
    if (step.done) return { result: step.value, events };
    events.push(step.value);
  }
}

describe("case 1: complete blocks -> exact name + args", () => {
  it("F1: one GLM call with code + ticker", () => {
    const calls = extractMarkupToolCalls(F1_GLM_RH);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("mcp__lazy-agent-service__run_equation");
    const openTag = F1_GLM_RH.indexOf("<arg_value>");
    const code = F1_GLM_RH.slice(openTag + "<arg_value>".length, F1_GLM_RH.indexOf("</arg_value>")).trim();
    expect(calls[0]?.args).toEqual({ code, ticker: "RH" });
  });

  it("F2: five GLM calls, the last a bare name with empty args", () => {
    const calls = extractMarkupToolCalls(F2_GLM_LMT);
    expect(calls.map((c) => c.name)).toEqual([
      "whiteboard_read", "whiteboard_read", "whiteboard_read", "whiteboard_read", "get_parameters",
    ]);
    expect(calls.map((c) => c.args.section)).toEqual([
      "quant_report", "fundamental_report", "valuation_report", "desk_note", undefined,
    ]);
    expect(calls.slice(0, 4).map((c) => c.args.ticker)).toEqual(["LMT", "LMT", "LMT", "LMT"]);
    expect(calls[4]?.args).toEqual({});
  });

  it("F3: four Qwen calls; screener filters parse to an array", () => {
    const calls = extractMarkupToolCalls(F3_QWEN_JPM);
    expect(calls.map((c) => c.name)).toEqual([
      "get_upcoming_events", "list_scheduled_research", "list_watches", "screener_query",
    ]);
    expect(calls[0]?.args).toEqual({ ticker: "JPM" });
    expect(calls[1]?.args).toEqual({});
    expect(calls[2]?.args).toEqual({ ticker: "JPM" });
    expect(calls[3]?.args.filters).toEqual(["ticker:eq:JPM"]);
    expect(calls[3]?.args.columns).toEqual([
      "ticker", "price", "rsi_14", "short_float_pct", "perf_week_pct", "perf_month_pct",
      "target_price", "target_upside_pct", "recom_score", "news_count_7d",
      "funds_net_activity", "congress_sells_90d", "sma50_dist_pct", "w52_high_dist_pct",
    ]);
  });

  it("F4: Qwen call with query + numeric limit", () => {
    expect(extractMarkupToolCalls(F4_QWEN_NVDA)).toEqual([
      { name: "lazy_web_search", args: { query: "Nvidia data center partners limit China sales 49% FT November 2026", limit: 6 } },
    ]);
  });

  it("F5: MiniMax JSON body keeps its real parameters payload", () => {
    expect(extractMarkupToolCalls(F5_MINIMAX)).toEqual([
      { name: "get_technical_indicators", args: { symbol: "PNC", indicators: ["rsi", "macd", "bbands"] } },
    ]);
  });

  it("F6: a stored closers-only tail is not a call", () => {
    expect(extractMarkupToolCalls(F6_DSML_V41_TAIL)).toEqual([]);
  });

  it("F7: DSML V4.1 invoke keeps string-attr raw and parses JSON attr", () => {
    expect(extractMarkupToolCalls(F7_DSML_V41)).toEqual([
      { name: "whiteboard_write", args: { ticker: "SWBI", content: { thesis: "bull" } } },
    ]);
  });

  it("F8: legacy full-width DeepSeek block parses through the shared function", () => {
    expect(extractMarkupToolCalls(F8_DSML_LEGACY)).toEqual([
      { name: "get_stock_price", args: { ticker: "SWBI" } },
    ]);
  });

  it("JSON-body name/args variants (folded shim fallbacks)", () => {
    const [nullArgs] = extractMarkupToolCalls('<tool_call>{"name":"x","arguments":null}</tool_call>');
    expect(nullArgs).toEqual({ name: "x", args: {} });
    expect(nullArgs?.argsParseError).toBeUndefined();
    const [badFn] = extractMarkupToolCalls('<tool_call>{"name":"x","function":"nope"}</tool_call>');
    expect(badFn).toEqual({ name: "x", args: {} });
    const [fnName] = extractMarkupToolCalls('<tool_call>{"function":{"name":"y","arguments":{"a":1}}}</tool_call>');
    expect(fnName).toEqual({ name: "y", args: { a: 1 } });
    const [toolName] = extractMarkupToolCalls('<tool_call>{"tool_name":"z","args":{"b":2}}</tool_call>');
    expect(toolName).toEqual({ name: "z", args: { b: 2 } });
  });

  it("DSML parameter without a string attribute behaves like string false", () => {
    const text = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"t\">\n<｜DSML｜ parameter name=\"ticker\">SWBI</｜DSML｜ parameter>\n<｜DSML｜ parameter name=\"limit\">123</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>";
    expect(extractMarkupToolCalls(text)).toEqual([{ name: "t", args: { ticker: "SWBI", limit: 123 } }]);
  });
});

describe("case 2: unterminated markup is detected and never parsed into calls", () => {
  const unterminated: Array<[string, string]> = [
    ["U1 (real BAC cut-off)", U1_UNTERM_BAC],
    ["U2 (GLM mid-tag cut)", U2_UNTERM_GLM_CUT],
    ["U3 (DSML mid-closer cut)", U3_UNTERM_DSML_CUT],
  ];
  for (const [label, text] of unterminated) {
    it(`${label}: hasUnterminatedToolMarkup true, extractMarkupToolCalls empty`, () => {
      expect(hasUnterminatedToolMarkup(text)).toBe(true);
      expect(extractMarkupToolCalls(text)).toEqual([]);
    });
  }

  it("counter-assertion: the COMPLETE F8 turn is not a cut", () => {
    expect(hasUnterminatedToolMarkup(F8_DSML_LEGACY)).toBe(false);
  });
});

describe("case 3: markup-free text is byte-identical", () => {
  const PLAIN = "SWBI closed at 4.21, up 3.4% on 1.2M shares. RSI(14) sits at 61, the 50-day SMA is 3.90, and nothing notable is on the earnings calendar this week.";
  it("no calls, no cut, strip is the identity", () => {
    expect(extractMarkupToolCalls(PLAIN)).toEqual([]);
    expect(hasUnterminatedToolMarkup(PLAIN)).toBe(false);
    expect(stripMarkupToolCalls(PLAIN)).toBe(PLAIN);
  });
});

describe("case 4: stream and non-stream paths agree (one shared parser)", () => {
  const fixtures: Array<[string, string]> = [
    ["F1", F1_GLM_RH],
    ["F2", F2_GLM_LMT],
    ["F3", F3_QWEN_JPM],
    ["F4", F4_QWEN_NVDA],
    ["F5", F5_MINIMAX],
    ["F6", F6_DSML_V41_TAIL],
    ["F7", F7_DSML_V41],
    ["F8", F8_DSML_LEGACY],
  ];
  for (const [label, fixture] of fixtures) {
    it(`${label}: stream toolCall events deep-equal the shim tool_calls`, async () => {
      const streamCalls = await streamToolCalls([fixture]);
      expect(streamCalls).toEqual(shimToolCalls(fixture));
    });
  }

  it("F1 streamed in two deltas cut mid-block accumulates identically", async () => {
    const cut = F1_GLM_RH.indexOf("<arg_key>ticker</arg_key>");
    expect(cut).toBeGreaterThan(0);
    const split = await streamToolCalls([F1_GLM_RH.slice(0, cut), F1_GLM_RH.slice(cut)]);
    expect(split).toEqual(shimToolCalls(F1_GLM_RH));
    expect(split[0]?.name).toBe("mcp__lazy-agent-service__run_equation");
  });
});

describe("case 5: unterminated end-to-end through runCoreLoop", () => {
  it("the real BAC cut-off executes zero tools and finalizes CUT_OFF / partial", async () => {
    const cut = U1_UNTERM_BAC.indexOf("</tool_");
    expect(cut).toBeGreaterThan(0);
    const spy = vi.fn(async () => "ok");
    const emitTool: CoreTool = { ...okTool("emit", "ok"), execute: spy };
    const model: CoreModel = () =>
      parseSSEStream(sseStream([U1_UNTERM_BAC.slice(0, cut), U1_UNTERM_BAC.slice(cut)]), { label: "test" }) as unknown as AsyncIterable<StreamChunk>;
    const { result } = await runLoop({
      model,
      tools: [emitTool],
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      maxSteps: 8,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.finalizeReason).toBe("CUT_OFF");
    expect(result.answerSource).toBe("partial");
  });
});

describe("case 6: non-stream unterminated reports length without minting tool calls", () => {
  it("U1: finish_reason length, content byte-identical, no tool_calls key", () => {
    const normalized = VllmShimService.normalizeToolCalls({
      choices: [{ message: { role: "assistant", content: U1_UNTERM_BAC }, finish_reason: "stop" }],
    } as ShimResponse);
    expect(normalized.choices[0]?.finish_reason).toBe("length");
    expect(normalized.choices[0]?.message.content).toBe(U1_UNTERM_BAC);
    expect("tool_calls" in normalized.choices[0]!.message).toBe(false);
  });
});

// ── S-06 review fixes (docs/audits/2026-11-las/s06-review.md) ─────────────────────────

const X1_LITERAL_BACKSLASH_F4 = "<tool_call>\\n<function=lazy_web_search>\\n<parameter=query>\\nNvidia data center partners limit China sales 49% FT November 2026\\n</parameter>\\n<parameter=limit>\\n6\\n</parameter>\\n</function>\\n</tool_call>"; // the plan stored double-escaped F4 bytes: a COMPLETE block no parser accepts (review check 2)
const X2_NOT_A_CALL = "<tool_call>not a call</tool_call>"; // prose body
const X3_INVALID_JSON = "<tool_call>{\"name\":</tool_call>"; // invalid JSON body
const X4_DSML_NO_NAME = "<｜DSML｜ calls>\n<｜DSML｜ invoke>\n<｜DSML｜ parameter name=\"ticker\" string=\"true\">SWBI</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"; // DSML invoke without name=
const X5_BROKEN_ARGS = "<tool_call>{\"name\":\"x\",\"arguments\":\"{broken\"}</tool_call>"; // malformed arguments string (review fix 2)

async function streamChunks(contents: string[], toolChoiceNone = false): Promise<SSEStreamChunk[]> {
  const chunks: SSEStreamChunk[] = [];
  for await (const chunk of parseSSEStream(sseStream(contents), { label: "test", toolChoiceNone })) chunks.push(chunk);
  return chunks;
}

function toolCallChunks(chunks: SSEStreamChunk[]): Array<Extract<SSEStreamChunk, { type: "toolCall" }>> {
  return chunks.filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => typeof c !== "string" && c.type === "toolCall");
}

function stopReasons(chunks: SSEStreamChunk[]): string[] {
  return chunks
    .filter((c): c is Extract<SSEStreamChunk, { type: "stopReason" }> => typeof c !== "string" && c.type === "stopReason")
    .map((c) => c.stopReason);
}

function shimChoice(content: string, reportOnly = false): ShimResponse["choices"][number] {
  const normalized = VllmShimService.normalizeToolCalls({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  } as ShimResponse, { reportOnly });
  return normalized.choices[0]!;
}

