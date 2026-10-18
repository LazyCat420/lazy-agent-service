/**
 * Basic happy-path tests for runCoreLoop (fault handling lives in the stress suite).
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../types/ProviderTypes.ts";
import type { CoreLoopEvent, CoreLoopOptions, CoreLoopResult } from "../types.ts";
import { runCoreLoop } from "../CoreLoop.ts";
import { okTool, scriptedModel } from "./fakes.ts";

const signal = new AbortController().signal;

const runLoop = async (options: CoreLoopOptions): Promise<{ result: CoreLoopResult; events: CoreLoopEvent[] }> => {
  const events: CoreLoopEvent[] = [];
  const generator = runCoreLoop(options);
  for (;;) {
    const step = await generator.next();
    if (step.done) return { result: step.value, events };
    events.push(step.value);
  }
};

const baseOptions = (overrides: Partial<CoreLoopOptions>): CoreLoopOptions => ({
  model: scriptedModel([]),
  tools: [],
  messages: [{ role: "user", content: "hi" }],
  signal,
  maxSteps: 8,
  ...overrides,
});

describe("runCoreLoop", () => {
  it("T1: completes on a text-only reply", async () => {
    const model = scriptedModel([["Hello world"]]);
    const { result, events } = await runLoop(baseOptions({ model }));

    expect(result).toMatchObject({ status: "completed", text: "Hello world", modelCalls: 1, toolCalls: 0, answerSource: "model" });
    expect(events.filter((event) => event.type === "model.start")).toHaveLength(1);
  });

  it("T2: runs a tool turn, then a text turn, with paired messages", async () => {
    const model = scriptedModel([
      [{ type: "toolCall", id: "t1", name: "lookup", args: { q: "x" } }],
      ["The answer is 4."],
    ]);
    const { result } = await runLoop(
      baseOptions({ model, tools: [okTool("lookup", "the answer is 4")] }),
    );

    expect(result).toMatchObject({ status: "completed", text: "The answer is 4.", modelCalls: 2, toolCalls: 1, answerSource: "model" });
    const roles = result.messages.map((message: ChatMessage) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    const toolMessage = result.messages[2];
    expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "t1", name: "lookup", content: "the answer is 4" });
    const assistantCalls = result.messages[1]?.toolCalls;
    expect(assistantCalls).toEqual([{ id: "t1", name: "lookup", args: { q: "x" } }]);
  });

  it("T3: beforeModelCall hooks feed every model call and leave the caller's array untouched", async () => {
    const model = scriptedModel([[""], ["second"]]);
    const input: ChatMessage[] = [{ role: "user", content: "hi" }];
    const { result } = await runLoop(
      baseOptions({
        model,
        messages: input,
        hooks: {
          beforeModelCall: [
            (messages) => [...messages, { role: "system", content: "app-context-line" }],
          ],
        },
      }),
    );

    expect(model.calls).toHaveLength(2);
    for (const call of model.calls) {
      const last = call.messages[call.messages.length - 1];
      expect(last).toMatchObject({ role: "system", content: "app-context-line" });
    }
    expect(input).toEqual([{ role: "user", content: "hi" }]);
    expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("T4: emits model.start, tool.start, tool.end, model.start, text.delta in order", async () => {
    const model = scriptedModel([
      [{ type: "toolCall", id: "t1", name: "lookup", args: {} }],
      ["done"],
    ]);
    const { events } = await runLoop(baseOptions({ model, tools: [okTool("lookup", "out")] }));

    expect(events.map((event) => event.type)).toEqual([
      "model.start",
      "tool.start",
      "tool.end",
      "model.start",
      "text.delta",
    ]);
    expect(events[0]).toMatchObject({ type: "model.start", step: 0, finalPass: false });
  });

  it("T5: the final pass streams text.delta whose concatenation equals result.text", async () => {
    const model = scriptedModel([
      [{ type: "toolCall", id: "t1", name: "lookup", args: {} }],
      ["final ", "answer"],
    ]);
    const { result, events } = await runLoop(
      baseOptions({ model, tools: [okTool("lookup", "out")], maxSteps: 1 }),
    );

    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "finalize")).toBe(true);
    const finalDeltas = events.filter((event) => event.type === "text.delta").map((event) => event.text);
    expect(finalDeltas.join("")).toBe("final answer");
    expect(result.text).toBe(finalDeltas.join(""));
  });

  it("T6: a failing final pass after a successful tool call synthesizes the tool output", async () => {
    const model = scriptedModel([
      [{ type: "toolCall", id: "t1", name: "lookup", args: {} }],
      { throw: new Error("500") },
      { throw: new Error("500") },
      { throw: new Error("500") },
      { throw: new Error("500") },
      { throw: new Error("500") },
    ]);
    const { result } = await runLoop(baseOptions({ model, tools: [okTool("lookup", "the widget output: 42")] }));

    expect(result.status).toBe("completed");
    expect(result.answerSource).toBe("synthetic");
    expect(result.text).toContain("the widget output: 42");
  });

  it("T7: retries exhausted with no usable tools ends failed with an error code and no crash", async () => {
    const model = scriptedModel([
      { throw: new Error("500") },
      { throw: new Error("500") },
      { throw: new Error("500") },
      { throw: new Error("500") },
      { throw: new Error("500") },
    ]);
    const { result } = await runLoop(baseOptions({ model }));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBeTruthy();
  });
});
