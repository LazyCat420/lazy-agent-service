import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareOpenAICompatMessages } from "../openai-compat.ts";

// DeepSeek thinking-mode-with-tools fixture: the assistant tool turn must
// carry reasoning_content back, or the API answers 400
// (https://api-docs.deepseek.com/guides/thinking_mode/). Audit D10.
const history = [
  { role: "user", content: "What is NVDA's price?" },
  {
    role: "assistant",
    content: "",
    thinking: "I need the latest quote, so call get_market_data.",
    toolCalls: [{ id: "call_1", name: "get_market_data", args: { ticker: "NVDA" } }],
  },
  { role: "tool", tool_call_id: "call_1", content: '{"price": 181.2}' },
];

afterEach(() => vi.unstubAllEnvs());

describe("reasoning_content round-trip (audit D10)", () => {
  it("sends the assistant tool turn's reasoning back", () => {
    const prepared = prepareOpenAICompatMessages(history) as Array<Record<string, unknown>>;
    expect(prepared[1]).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "I need the latest quote, so call get_market_data.",
    });
    expect(prepared[1].tool_calls).toHaveLength(1);
  });

  it("omits the field when there is no reasoning", () => {
    const prepared = prepareOpenAICompatMessages([
      history[0],
      { ...history[1], thinking: undefined },
      history[2],
    ]) as Array<Record<string, unknown>>;
    expect(prepared[1]).not.toHaveProperty("reasoning_content");
  });

  it("can be disabled for a backend that rejects the field", () => {
    vi.stubEnv("ROUND_TRIP_REASONING", "0");
    const prepared = prepareOpenAICompatMessages(history) as Array<Record<string, unknown>>;
    expect(prepared[1]).not.toHaveProperty("reasoning_content");
  });
});
