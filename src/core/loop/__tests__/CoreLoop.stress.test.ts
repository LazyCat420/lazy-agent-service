/**
 * Stress suite for `runCoreLoop` (S1–S18). Contract: ../types.ts; fakes: ./fakes.ts.
 *
 * No real timers anywhere: every abort is driven by `AbortController`s the test owns and
 * `Promise.withResolvers()` promises. Tests consume the generator with a manual `next()` loop to
 * capture the return value. `CoreLoop.ts` is implemented by another agent on this branch; until it
 * lands these tests fail to import — that is expected.
 */
import { describe, expect, it } from "vitest";
import { runCoreLoop } from "../CoreLoop.ts";
import type { CoreLoopEvent, CoreLoopOptions, CoreLoopResult, CoreModel, CoreModelRequest, CoreTool } from "../types.ts";
import type { ChatMessage } from "../../../types/ProviderTypes.ts";
import type { StreamChunk } from "../../../types/provider.ts";
import {
  alwaysThrowingModel,
  countingTool,
  deafHangingTool,
  hangingTool,
  hugeTool,
  okTool,
  scriptedModel,
  throwingTool,
} from "./fakes.ts";

async function collect(options: CoreLoopOptions): Promise<{ events: CoreLoopEvent[]; result: CoreLoopResult }> {
  const events: CoreLoopEvent[] = [];
  const generator = runCoreLoop(options);
  let step = await generator.next();
  while (!step.done) {
    events.push(step.value);
    step = await generator.next();
  }
  return { events, result: step.value };
}

/** Invariant I3: every tool call id appears in exactly one later `role:"tool"` message. */
function expectToolPairing(messages: ChatMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || message.toolCalls === undefined) {
      continue;
    }
    for (const call of message.toolCalls) {
      if (typeof call.id !== "string") {
        continue;
      }
      const paired = messages
        .slice(index + 1)
        .filter((m) => m.role === "tool" && m.tool_call_id === call.id);
      expect(paired, `tool call ${call.id} (${call.name}) must have exactly one later tool message`).toHaveLength(1);
    }
  }
}

function toolMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "tool");
}

function optionsWith(overrides: Partial<CoreLoopOptions> & { model: CoreModel }): CoreLoopOptions {
  return {
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    maxSteps: 8,
    ...overrides,
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): StreamChunk => ({
  type: "toolCall",
  id,
  name,
  args,
});

describe("core loop stress (S1–S18)", () => {
  it("S1: tool error message reaches the model, run completes with next turn's text", async () => {
    const model = scriptedModel([
      [toolCall("c1", "boom")],
      ["all recovered"],
    ]);
    const { events, result } = await collect(
      optionsWith({ model, tools: [throwingTool("boom", "kaboom exploded")] }),
    );

    expect(result.status).toBe("completed");
    expect(result.text).toBe("all recovered");
    const secondCallMessages = model.calls[1]?.messages ?? [];
    const toolMsg = toolMessages(secondCallMessages).find((m) => m.tool_call_id === "c1");
    expect(String(toolMsg?.content)).toContain("kaboom exploded");
    expect(events.some((e) => e.type === "tool.end" && e.result.errorCode === "TOOL_THREW")).toBe(true);
    expectToolPairing(result.messages);
  });

  it("S2: per-tool timeout fires via injected timeoutSignalFor, run completes", async () => {
    const controllers = new Map<string, AbortController>();
    const deaf: CoreTool = {
      ...deafHangingTool("deaf"),
      timeoutMs: 50,
      execute: async () => {
        controllers.get("deaf")?.abort();
        const { promise } = Promise.withResolvers<void>();
        await promise;
      },
    };
    const model = scriptedModel([[toolCall("c1", "fine"), toolCall("c2", "deaf"), toolCall("c3", "fine2")], ["done"]]);
    const { result } = await collect(
      optionsWith({
        model,
        tools: [okTool("fine", "ok"), deaf, okTool("fine2", "ok too")],
        timeoutSignalFor: (toolName: string) => {
          if (toolName === "deaf") {
            const controller = new AbortController();
            controllers.set(toolName, controller);
            return controller.signal;
          }
          return new AbortController().signal;
        },
      }),
    );

    expect(result.status).toBe("completed");
    const msgs = toolMessages(result.messages);
    expect(msgs).toHaveLength(3);
    const deafMsg = msgs.find((m) => m.tool_call_id === "c2");
    expect(String(deafMsg?.content)).toContain("timed out");
    expectToolPairing(result.messages);
  });

  it("S3: maxConsecutiveToolErrors stops execution and tells the model to stop calling the tool", async () => {
    let ran = 0;
    const flaky: CoreTool = {
      ...throwingTool("flaky", "flaky blew up"),
      execute: async () => {
        ran += 1;
        throw new Error("flaky blew up");
      },
    };
    const model = scriptedModel([
      [toolCall("c1", "flaky")],
      [toolCall("c2", "flaky")],
      [toolCall("c3", "flaky")],
      [toolCall("c4", "flaky")],
      ["gave up gracefully"],
    ]);
    const { result } = await collect(
      optionsWith({ model, tools: [flaky], maxConsecutiveToolErrors: 3 }),
    );

    expect(result.status).toBe("completed");
    expect(ran).toBe(3);
    const fourth = toolMessages(result.messages).find((m) => m.tool_call_id === "c4");
    expect(String(fourth?.content)).toContain("stop calling it");
    expectToolPairing(result.messages);
  });

  it("S4: unknown tool name yields a not-found message listing available tools", async () => {
    const model = scriptedModel([[toolCall("c1", "web_serch")], ["found it eventually"]]);
    const { result } = await collect(optionsWith({ model, tools: [okTool("global.web.search", "results")] }));

    expect(result.status).toBe("completed");
    const msg = toolMessages(result.messages).find((m) => m.tool_call_id === "c1");
    expect(String(msg?.content)).toContain("not found");
    expect(String(msg?.content)).toContain("global.web.search");
    expectToolPairing(result.messages);
  });

  it("S5: __raw args are repaired when parseable and rejected as TOOL_BAD_ARGS otherwise", async () => {
    const counter = countingTool("search");
    const model = scriptedModel([
      [toolCall("c1", "search", { __raw: '{"query":"x",}' })],
      [toolCall("c2", "search", { __raw: '{query:' })],
      ["both handled"],
    ]);
    const { events, result } = await collect(optionsWith({ model, tools: [counter] }));

    expect(result.status).toBe("completed");
    expect(counter.calls[0]?.args).toEqual({ query: "x" });
    const bad = toolMessages(result.messages).find((m) => m.tool_call_id === "c2");
    expect(String(bad?.content)).toMatch(/TOOL_BAD_ARGS|invalid|arguments/i);
    expect(events.some((e) => e.type === "tool.end" && e.call.id === "c2" && e.result.isError)).toBe(true);
    expectToolPairing(result.messages);
  });

  it("S6: cut-off reply with tool calls pairs them REPLY_CUT_OFF and never executes them", async () => {
    const counter = countingTool("counted");
    const model = scriptedModel([
      [toolCall("c1", "counted"), { type: "stopReason", stopReason: "length" }],
      ["after the cut-off"],
    ]);
    const { result } = await collect(optionsWith({ model, tools: [counter] }));

    expect(result.status).toBe("completed");
    expect(counter.calls).toHaveLength(0);
    const msg = toolMessages(result.messages).find((m) => m.tool_call_id === "c1");
    expect(String(msg?.content)).toContain("cut off");
    expectToolPairing(result.messages);
  });

  it("S7: 20 parallel calls produce 20 ordered tool messages before the next model call", async () => {
    const external = new AbortController();
    const names: string[] = [];
    const tools: CoreTool[] = [];
    for (let i = 0; i < 10; i += 1) {
      names.push(`ok${i}`);
      tools.push(okTool(`ok${i}`, `ok ${i}`));
    }
    for (let i = 0; i < 5; i += 1) {
      names.push(`bad${i}`);
      tools.push(throwingTool(`bad${i}`, `bad ${i} failed`));
    }
    for (let i = 0; i < 5; i += 1) {
      names.push(`hang${i}`);
      tools.push({
        name: `hang${i}`,
        description: "hangs until the external controller aborts",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const { promise, resolve } = Promise.withResolvers<string>();
          external.signal.addEventListener("abort", () => resolve("released"), { once: true });
          return promise;
        },
      });
    }
    const ids = names.map((_, i) => `c${i}`);
    const calls: StreamChunk[] = names.map((name, i) => toolCall(`c${i}`, name));
    const model = scriptedModel([calls, ["twenty handled"]]);
    const { result } = await collect(
      optionsWith({
        model,
        tools,
        hooks: {
          afterToolCall: [
            (call, toolResult) => {
              if (!external.signal.aborted) {
                external.abort();
              }
              return toolResult;
            },
          ],
        },
      }),
    );

    expect(result.status).toBe("completed");
    const ordered = toolMessages(model.calls[1]?.messages ?? []).map((m) => m.tool_call_id);
    expect(ordered).toEqual(ids);
    expect(ordered).toHaveLength(20);
    expectToolPairing(result.messages);
  });

  it("S8: huge tool output is capped within toolOutputCap + overhead", async () => {
    const model = scriptedModel([[toolCall("c1", "big")], ["summarized"]]);
    const { result } = await collect(
      optionsWith({ model, tools: [hugeTool("big", 5_000_000)], toolOutputCap: 16_000 }),
    );

    expect(result.status).toBe("completed");
    const msg = toolMessages(result.messages).find((m) => m.tool_call_id === "c1");
    expect(String(msg?.content).length).toBeLessThanOrEqual(16_120);
    expectToolPairing(result.messages);
  });

  it("S9: maxSteps forces one toolless final pass and finalizes STEP_LIMIT", async () => {
    const model = scriptedModel([[toolCall("c1", "looped")], [toolCall("c2", "looped")], [toolCall("c3", "looped")], [toolCall("c4", "looped")]]);
    const { events, result } = await collect(optionsWith({ model, tools: [okTool("looped", "busy")], maxSteps: 4 }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("fallback answer");
    expect(result.finalizeReason).toBe("STEP_LIMIT");
    expect(events.some((e) => e.type === "finalize" && e.reason === "STEP_LIMIT")).toBe(true);
    expect(model.calls).toHaveLength(5);
    expect(model.calls.slice(0, 4).every((c) => !c.finalPass && c.toolChoice === "auto")).toBe(true);
    expect(model.calls[4]?.finalPass).toBe(true);
    expect(model.calls[4]?.toolChoice).toBe("none");
    expectToolPairing(result.messages);
  });

  it("S10: TOKEN_BUDGET_FINALIZE error finalizes TOKEN_BUDGET and runs a final pass", async () => {
    const budgetError = Object.assign(new Error("budget"), { code: "TOKEN_BUDGET_FINALIZE" });
    const model = scriptedModel([
      [toolCall("c1", "spender")],
      { throw: budgetError },
      ["budget answer"],
    ]);
    const { events, result } = await collect(optionsWith({ model, tools: [okTool("spender", "spent")] }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("budget answer");
    expect(events.some((e) => e.type === "finalize" && e.reason === "TOKEN_BUDGET")).toBe(true);
    expect(model.calls[2]?.finalPass).toBe(true);
    expectToolPairing(result.messages);
  });

  it("S11: shouldFinalize flipping inside a tool makes the next call the final pass", async () => {
    let deadline = false;
    const flip: CoreTool = {
      name: "flip",
      description: "flips the soft deadline",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        deadline = true;
        return "flipped";
      },
    };
    const model = scriptedModel([[toolCall("c1", "flip")], ["deadline answer"]]);
    const { events, result } = await collect(
      optionsWith({ model, tools: [flip], shouldFinalize: () => (deadline ? "DEADLINE_SOFT" : null) }),
    );

    expect(result.status).toBe("completed");
    expect(result.text).toBe("deadline answer");
    expect(events.some((e) => e.type === "finalize" && e.reason === "DEADLINE_SOFT")).toBe(true);
    expect(model.calls[1]?.finalPass).toBe(true);
    expectToolPairing(result.messages);
  });

  it("S12: abort mid-stream cancels the run with no unhandled rejection", async () => {
    const controller = new AbortController();
    const model: CoreModel = (request) =>
      (async function* () {
        yield "partial text";
        controller.abort();
        const { promise, reject } = Promise.withResolvers<never>();
        const failure = new Error("stream aborted");
        if (request.signal.aborted) {
          reject(failure);
        } else {
          request.signal.addEventListener("abort", () => reject(failure), { once: true });
        }
        await promise;
        yield "unreachable";
      })();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let result: CoreLoopResult;
    try {
      ({ result } = await collect(optionsWith({ model, signal: controller.signal })));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(result.status).toBe("cancelled");
    expect(rejections).toEqual([]);
  });

  it("S13: empty final pass synthesizes an answer from tool results", async () => {
    const counter = countingTool("report", "quarterly widget output: 42 units");
    const model = scriptedModel([
      [toolCall("c1", "report")],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
    const { result } = await collect(optionsWith({ model, tools: [counter] }));

    expect(result.status).toBe("completed");
    expect(result.answerSource).toBe("synthetic");
    expect(result.text).toContain("quarterly widget output: 42 units");
    expect(counter.calls).toHaveLength(1);
    expectToolPairing(result.messages);
  });

  it("S14a: provider errors are retried and the run completes", async () => {
    const model = scriptedModel([{ throw: new Error("500") }, { throw: new Error("500") }, ["third time lucky"]]);
    const { result } = await collect(optionsWith({ model }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("third time lucky");
    expect(model.calls).toHaveLength(3);
    expectToolPairing(result.messages);
  });

  it("S14b: persistent provider failure ends in status failed with an error code", async () => {
    const model = alwaysThrowingModel(new Error("500"));
    const { result } = await collect(optionsWith({ model }));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBeTruthy();
    expect(model.calls.length).toBeGreaterThanOrEqual(2);
    expectToolPairing(result.messages);
  });

  it("S15: a throwing beforeToolCall hook denies execution", async () => {
    const counter = countingTool("guarded");
    const model = scriptedModel([[toolCall("c1", "guarded")], ["policy answer"]]);
    const { result } = await collect(
      optionsWith({
        model,
        tools: [counter],
        hooks: {
          beforeToolCall: [
            () => {
              throw new Error("policy violation");
            },
          ],
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(counter.calls).toHaveLength(0);
    const msg = toolMessages(result.messages).find((m) => m.tool_call_id === "c1");
    expect(String(msg?.content)).toMatch(/denied|policy/i);
    expectToolPairing(result.messages);
  });

  it("S16: aborting the run signal from inside the first tool cancels all pending calls", async () => {
    const controller = new AbortController();
    const switchTool: CoreTool = {
      name: "switch",
      description: "aborts the run signal, then stays pending until its own context aborts",
      parameters: { type: "object", properties: {} },
      execute: async (_args, context) => {
        controller.abort();
        const { promise, resolve } = Promise.withResolvers<string>();
        context.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        return promise;
      },
    };
    const model = scriptedModel([[toolCall("c1", "switch"), toolCall("c2", "hang1"), toolCall("c3", "hang2")]]);
    const { result } = await collect(
      optionsWith({ model, tools: [switchTool, hangingTool("hang1"), hangingTool("hang2")], signal: controller.signal }),
    );

    expect(result.status).toBe("cancelled");
    const msgs = toolMessages(result.messages);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => String(m.content).includes("cancelled"))).toBe(true);
    expectToolPairing(result.messages);
  });

  it("S17: the tool schema list is identical on every model call in a run", async () => {
    const model = scriptedModel([
      [toolCall("c1", "counter")],
      [toolCall("c2", "counter")],
      [toolCall("c3", "counter")],
      [toolCall("c4", "counter")],
      ["five turns done"],
    ]);
    const { result } = await collect(optionsWith({ model, tools: [countingTool("counter")] }));

    expect(result.status).toBe("completed");
    const first = model.calls[0]?.tools;
    expect(first).toBeDefined();
    for (const request of model.calls) {
      expect(request.tools).toEqual(first);
    }
    expectToolPairing(result.messages);
  });

  it("S18: 25 concurrent runs all settle with per-run answers and no cross-talk", async () => {
    const runs: Array<Promise<{ result: CoreLoopResult }>> = [];
    for (let i = 0; i < 25; i += 1) {
      if (i % 2 === 0) {
        const model = scriptedModel([[toolCall("c1", "rough")], [`answer ${i}`]]);
        runs.push(collect(optionsWith({ model, tools: [throwingTool("rough", `boom ${i}`)] })));
      } else {
        const model = scriptedModel([[`answer ${i}`]]);
        runs.push(collect(optionsWith({ model, tools: [okTool("clean", "fine")] })));
      }
    }
    const settled = await Promise.all(runs);

    expect(settled).toHaveLength(25);
    for (const [i, run] of settled.entries()) {
      if (i % 2 === 1) {
        expect(run.result.status).toBe("completed");
        expect(run.result.text).toBe(`answer ${i}`);
      }
      expectToolPairing(run.result.messages);
    }
  });
});

describe("finalize signal", () => {
  /** Model whose first turn streams nothing, then hangs until its request signal aborts. */
  const cutTurnModel = (
    finalizeController: AbortController,
    finalText: string,
  ): CoreModel & { calls: CoreModelRequest[] } => {
    const calls: CoreModelRequest[] = [];
    const model = ((request: CoreModelRequest): AsyncIterable<StreamChunk> => {
      calls.push({ ...request, messages: [...request.messages] });
      if (request.finalPass) {
        return (async function* () {
          yield finalText;
        })();
      }
      return (async function* () {
        finalizeController.abort(new Error("DEADLINE_SOFT"));
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        request.signal.throwIfAborted();
      })();
    }) as CoreModel & { calls: CoreModelRequest[] };
    model.calls = calls;
    return model;
  };

  it("S19: cuts the in-flight model turn and runs the final pass", async () => {
    const finalizeController = new AbortController();
    const model = cutTurnModel(finalizeController, "final answer");
    const { events, result } = await collect(optionsWith({ model, finalizeSignal: finalizeController.signal }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("final answer");
    expect(result.finalizeReason).toBe("DEADLINE_SOFT");
    const finalCall = model.calls.at(-1)!;
    expect(finalCall.finalPass).toBe(true);
    expect(finalCall.toolChoice).toBe("none");
    const finalInstructionIndex = result.messages.findIndex(
      (m) => m.role === "user" && String(m.content).includes("Answer the user now"),
    );
    expect(finalInstructionIndex).toBeGreaterThan(0);
    for (const message of result.messages.slice(0, finalInstructionIndex)) {
      expect(message.role).not.toBe("assistant");
    }
    expect(events.some((e) => e.type === "finalize" && e.reason === "DEADLINE_SOFT")).toBe(true);
  });

  it("S20: cuts the in-flight tool batch and runs the final pass", async () => {
    const finalizeController = new AbortController();
    const cancellable: CoreTool = {
      name: "slow",
      description: "slow tool",
      parameters: { type: "object", properties: {} },
      execute: async (_args, { signal }) => {
        finalizeController.abort(new Error("DEADLINE_SOFT"));
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "tool finished anyway";
      },
    };
    const model = scriptedModel([[toolCall("c1", "slow")], ["final answer"]]);
    const { events, result } = await collect(
      optionsWith({ model, tools: [cancellable], finalizeSignal: finalizeController.signal }),
    );

    expect(result.status).toBe("completed");
    expect(result.text).toBe("final answer");
    expect(result.finalizeReason).toBe("DEADLINE_SOFT");
    const toolEnd = events.find((e) => e.type === "tool.end" && e.call.id === "c1");
    expect(toolEnd && toolEnd.type === "tool.end" && toolEnd.result.isError).toBe(true);
    expect(model.calls.filter((r) => r.finalPass)).toHaveLength(1);
    expect(model.calls.filter((r) => !r.finalPass)).toHaveLength(1);
    expectToolPairing(result.messages);
  });

  it("S21: hard cancel still wins over the finalize signal", async () => {
    const runController = new AbortController();
    const finalizeController = new AbortController();
    const calls: CoreModelRequest[] = [];
    const model = ((request: CoreModelRequest): AsyncIterable<StreamChunk> => {
      calls.push({ ...request, messages: [...request.messages] });
      return (async function* () {
        yield "partial";
        runController.abort(new Error("cancelled"));
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        request.signal.throwIfAborted();
      })();
    }) as CoreModel;
    const generator = runCoreLoop(
      optionsWith({ model, finalizeSignal: finalizeController.signal, signal: runController.signal }),
    );
    let step = await generator.next();
    while (!step.done) {
      step = await generator.next();
    }
    const result = step.value;

    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("RUN_CANCELLED");
    expect(calls.filter((r) => r.finalPass)).toHaveLength(0);
  });

  /** Model whose first turn streams `firstChunk`, then hangs until its request signal aborts. */
  const cutAnswerModel = (
    finalizeController: AbortController,
    firstChunk: string,
    finalPass: (request: CoreModelRequest) => AsyncIterable<StreamChunk>,
  ): CoreModel & { calls: CoreModelRequest[] } => {
    const calls: CoreModelRequest[] = [];
    const model = ((request: CoreModelRequest): AsyncIterable<StreamChunk> => {
      calls.push({ ...request, messages: [...request.messages] });
      if (request.finalPass) return finalPass(request);
      return (async function* () {
        yield firstChunk;
        finalizeController.abort(new Error("DEADLINE_SOFT"));
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        request.signal.throwIfAborted();
      })();
    }) as CoreModel & { calls: CoreModelRequest[] };
    model.calls = calls;
    return model;
  };

  it("S22: cut mid-answer continues it", async () => {
    const finalizeController = new AbortController();
    const model = cutAnswerModel(finalizeController, "Part one. ", function* () {
      yield "Part two.";
    });
    const { result } = await collect(optionsWith({ model, finalizeSignal: finalizeController.signal }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Part one. Part two.");
    const finalCall = model.calls.at(-1)!;
    expect(finalCall.finalPass).toBe(true);
    expect(finalCall.toolChoice).toBe("none");
    expect(finalCall.messages.at(-2)).toEqual({ role: "assistant", content: "Part one. " });
    expect(String(finalCall.messages.at(-1)?.content)).toContain("Continue the answer");
  });

  it("S23: a turn that completes after the cut is kept", async () => {
    const finalizeController = new AbortController();
    const calls: CoreModelRequest[] = [];
    const model = ((request: CoreModelRequest): AsyncIterable<StreamChunk> => {
      calls.push({ ...request, messages: [...request.messages] });
      return (async function* () {
        yield "Full ";
        finalizeController.abort(new Error("DEADLINE_SOFT"));
        yield "answer.";
      })();
    }) as CoreModel & { calls: CoreModelRequest[] };
    const { result } = await collect(optionsWith({ model, finalizeSignal: finalizeController.signal }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Full answer.");
    expect(calls).toHaveLength(1);
  });

  it("S24: final pass fails after a cut answer", async () => {
    const finalizeController = new AbortController();
    const model = cutAnswerModel(finalizeController, "Part one. ", function* () {
      throw new Error("final pass unavailable");
    });
    const { result } = await collect(optionsWith({ model, finalizeSignal: finalizeController.signal }));

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Part one. ");
  });
});
