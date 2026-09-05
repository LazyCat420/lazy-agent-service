import { describe, it, expect } from "vitest";
import { VllmShimService } from "../vllm/VllmShimService.js";

describe("VllmShimService.normalizeToolCalls", () => {
  it("converts a single DeepSeek DSML tool call in content to standard OpenAI tool_calls", () => {
    const rawResponse = {
      id: "chatcmpl-test1",
      object: "chat.completion",
      created: 1725500000,
      model: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "<｜tool calls｜><｜tool_call｜>{\"name\": \"get_stock_price\", \"arguments\": {\"ticker\": \"SWBI\"}}<｜end of tool call｜>",
          },
          finish_reason: "stop",
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(rawResponse);
    expect(normalized.choices[0].message.tool_calls).toBeDefined();
    expect(normalized.choices[0].message.tool_calls.length).toBe(1);
    expect(normalized.choices[0].message.tool_calls[0].type).toBe("function");
    expect(normalized.choices[0].message.tool_calls[0].function.name).toBe("get_stock_price");
    expect(JSON.parse(normalized.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      ticker: "SWBI",
    });
    expect(normalized.choices[0].message.content).toBeNull();
  });

  it("converts multiple tool calls in a single turn", () => {
    const rawResponse = {
      id: "chatcmpl-test2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "<｜tool calls｜><｜tool_call｜>{\"name\": \"fetch_news\", \"arguments\": {\"query\": \"SWBI\"}}<｜end of tool call｜><｜tool_call｜>{\"name\": \"get_quote\", \"arguments\": {\"ticker\": \"SWBI\"}}<｜end of tool call｜>",
          },
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(rawResponse);
    expect(normalized.choices[0].message.tool_calls.length).toBe(2);
    expect(normalized.choices[0].message.tool_calls[0].function.name).toBe("fetch_news");
    expect(normalized.choices[0].message.tool_calls[1].function.name).toBe("get_quote");
  });

  it("handles markdown code block fences inside the tool_call block", () => {
    const rawResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "<｜tool calls｜><｜tool_call｜>```json\n{\"name\": \"whiteboard_post\", \"arguments\": {\"key\": \"thesis\", \"val\": \"bullish\"}}\n```<｜end of tool call｜>",
          },
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(rawResponse);
    expect(normalized.choices[0].message.tool_calls.length).toBe(1);
    expect(normalized.choices[0].message.tool_calls[0].function.name).toBe("whiteboard_post");
    expect(JSON.parse(normalized.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      key: "thesis",
      val: "bullish",
    });
  });

  it("preserves preceding narration prose in content while extracting tools", () => {
    const rawResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "I am beginning the fundamental audit for SWBI.\n<｜tool calls｜><｜tool_call｜>{\"name\": \"get_financials\", \"arguments\": {\"ticker\": \"SWBI\"}}<｜end of tool call｜>",
          },
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(rawResponse);
    expect(normalized.choices[0].message.tool_calls.length).toBe(1);
    expect(normalized.choices[0].message.content).toBe("I am beginning the fundamental audit for SWBI.");
  });

  it("handles ASCII pipe tags (<|tool calls|>)", () => {
    const rawResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "<|tool calls|><|tool_call|>{\"name\": \"execute_query\", \"arguments\": {\"q\": 1}}<|end of tool call|>",
          },
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(rawResponse);
    expect(normalized.choices[0].message.tool_calls.length).toBe(1);
    expect(normalized.choices[0].message.tool_calls[0].function.name).toBe("execute_query");
  });

  it("leaves standard responses with already-populated tool_calls untouched", () => {
    const standardResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_existing",
                type: "function",
                function: { name: "test_tool", arguments: "{}" },
              },
            ],
          },
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(standardResponse);
    expect(normalized).toEqual(standardResponse);
  });

  it("leaves regular prose responses without tool calls untouched", () => {
    const proseResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Based on the technical patterns, SWBI is consolidating.",
          },
        },
      ],
    };

    const normalized = VllmShimService.normalizeToolCalls(proseResponse);
    expect(normalized.choices[0].message.tool_calls).toBeUndefined();
    expect(normalized.choices[0].message.content).toBe(
      "Based on the technical patterns, SWBI is consolidating.",
    );
  });
});
