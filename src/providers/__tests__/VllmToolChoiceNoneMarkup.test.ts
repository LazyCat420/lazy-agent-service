/**
 * A vLLM (Qwen) turn sent with tool_choice "none" that answers with
 * <tool_call> text must not yield a fake tool call. vllm.ts forwards
 * `toolChoiceNone` into parseSSEStream, which skips markup recovery.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVllmProvider } from "../vllm.ts";

const MARKUP = '<tool_call>{"name":"x","arguments":{}}</tool_call>';

function sseResponse(): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: MARKUP }, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function toolCallsFor(toolChoice: "none" | "auto") {
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse()));
  const provider = createVllmProvider("http://vllm.test");
  const calls: Array<{ type: string; name?: string }> = [];
  for await (const chunk of provider.generateTextStream!(
    [{ role: "user", content: "hi" }],
    "m",
    { tools: [{ name: "x", description: "x", parameters: { type: "object", properties: {} } }], toolChoice },
  )) {
    if (typeof chunk === "object" && chunk.type === "toolCall") calls.push(chunk as { type: string; name?: string });
  }
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vLLM streaming tool_choice none vs text markup", () => {
  it("yields no tool call when toolChoice is none", async () => {
    expect(await toolCallsFor("none")).toEqual([]);
  });

  it("yields exactly one tool call named x when toolChoice is auto (control)", async () => {
    const calls = await toolCallsFor("auto");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("x");
  });
});
