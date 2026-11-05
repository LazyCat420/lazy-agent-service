/**
 * 2026-11-05, cycle-v3-lead-news-lead-b73f063a… / PRI v3_valuation_analyst, Qwen3.8 on
 * vllm-4: both attempts ended on a call whose function opener was written as
 * `<parameter=screener_query>`. The block was not recovered, no tool ran, and the
 * attempt was booked UNPARSED_TOOL_CALL. The blocks below are the model's own text.
 */
import { describe, expect, it } from "vitest";
import { extractMarkupToolCalls, parseSSEStream, type SSEStreamChunk } from "../openai-compat.ts";

const COLUMNS = ["ticker", "name", "sector", "industry", "market_cap", "pe_ratio", "forward_pe", "ev_to_ebitda", "ev_to_sales", "price_to_book", "price_to_fcf", "oper_margin", "roe", "revenue_growth", "eps_growth_next_y", "target_upside_pct", "recom_score"];

const PRI_ATTEMPT_1 =
  '<tool_call>\n<parameter=screener_query>\n<parameter=filters>\n["ticker:eq:PRI"]\n</parameter>\n<parameter=columns>\n' +
  JSON.stringify(COLUMNS).replace(/","/g, '", "') +
  "\n</parameter>\n</function>\n</tool_call>";

const PRI_ATTEMPT_2 =
  "<tool_call>\n<parameter=screener_query>\n<parameter=ticker>\nPRI\n</parameter>\n<parameter=columns>\n" +
  '["ticker", "name", "sector", "industry", "market_cap", "pe_ratio", "forward_pe", "ev_to_ebitda", "ev_to_sales", "price_to_book", "price_to_fcf", "oper_margin", "roe", "revenue_growth", "eps_growth_next_y", "target_price", "recom_score", "debt_to_equity", "dividend_yield"]' +
  "\n</parameter>\n</function>\n</tool_call>";

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

async function toolCalls(contents: string[]) {
  const chunks: SSEStreamChunk[] = [];
  for await (const chunk of parseSSEStream(sseStream(contents), { label: "test" })) chunks.push(chunk);
  return chunks.filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => typeof c !== "string" && c.type === "toolCall");
}

describe("Qwen call whose function opener is written as a parameter", () => {
  it("recovers the PRI attempt-1 screener call streamed in two pieces", async () => {
    const cut = PRI_ATTEMPT_1.indexOf("<parameter=columns>");
    expect(await toolCalls([PRI_ATTEMPT_1.slice(0, cut), PRI_ATTEMPT_1.slice(cut)])).toEqual([
      { type: "toolCall", id: "call_markup_0", name: "screener_query", args: { filters: ["ticker:eq:PRI"], columns: COLUMNS } },
    ]);
  });

  it("recovers the PRI attempt-2 call with a plain string argument", () => {
    const [call] = extractMarkupToolCalls(PRI_ATTEMPT_2);
    expect(call.name).toBe("screener_query");
    expect(call.args.ticker).toBe("PRI");
    expect(call.args.columns).toHaveLength(19);
  });

  it("still drops a block that is only a parameter with a value", async () => {
    expect(await toolCalls(["<tool_call>\n<parameter=query>\nnvda price\n</parameter>\n</tool_call>"])).toEqual([]);
  });
});
