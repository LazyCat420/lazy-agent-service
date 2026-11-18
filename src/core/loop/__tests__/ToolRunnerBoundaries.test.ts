/**
 * Boundary and error-path behaviour of runToolBatch that ToolRunner.test.ts does not reach:
 * the "never throws, one result per call" invariant (types.ts I2/I3), output capping and the
 * spill buffer, per-tool timeouts and cancellation bookkeeping, the concurrency cap and
 * exclusive ordering, the duplicate/oscillation guard, and malformed argument shapes.
 * No real timers: timeouts use the `timeoutSignalFor` seam, clocks are injected.
 */
import { describe, expect, it } from "vitest";
import { createToolCallHistory, runToolBatch } from "../ToolRunner.ts";
import { SpillBuffer } from "../SpillBuffer.ts";
import type { CoreTool, CoreToolCall, CoreToolContext, ToolBatchOptions } from "../types.ts";

let idCounter = 0;

const makeCall = (name: string, args: Record<string, unknown> = {}): CoreToolCall => {
  idCounter += 1;
  return { id: `bcall_${idCounter}`, name, args };
};

const makeTool = (
  name: string,
  execute: (args: Record<string, unknown>, ctx: CoreToolContext) => Promise<unknown>,
  extra: Partial<CoreTool> = {},
): CoreTool => ({
  name,
  description: `${name} description`,
  parameters: { type: "object", properties: {}, required: [] },
  execute,
  ...extra,
});

const toolMap = (...tools: CoreTool[]) => new Map(tools.map((t) => [t.name, t] as const));

const baseOptions = (over: Partial<ToolBatchOptions> = {}): ToolBatchOptions => ({
  tools: new Map<string, CoreTool>(),
  hooks: {},
  signal: new AbortController().signal,
  defaultToolTimeoutMs: 1000,
  toolOutputCap: 16000,
  toolErrorCap: 2048,
  maxConsecutiveToolErrors: 3,
  failureStreak: new Map<string, number>(),
  now: () => 0,
  ...over,
});

/** A tool that records the args of every execution and returns `value`. */
const recordingTool = (name: string, value: unknown = "ok", extra: Partial<CoreTool> = {}) => {
  const executed: Record<string, unknown>[] = [];
  const tool = makeTool(name, async (args) => {
    executed.push(args);
    return value;
  }, extra);
  return { tool, executed };
};

/**
 * The `timeoutSignalFor` seam with a hand-held trigger: `started(name)` resolves with the
 * timeout controller of the FIRST execution of that tool, once the runner has asked for it.
 */
const manualTimeouts = () => {
  const ready = new Map<string, PromiseWithResolvers<AbortController>>();
  const waiter = (name: string) => {
    let entry = ready.get(name);
    if (!entry) {
      entry = Promise.withResolvers<AbortController>();
      ready.set(name, entry);
    }
    return entry;
  };
  return {
    timeoutSignalFor: (toolName: string, _ms: number) => {
      const controller = new AbortController();
      waiter(toolName).resolve(controller);
      return controller.signal;
    },
    started: (name: string) => waiter(name).promise,
  };
};

describe("runToolBatch invariant: never throws, one result per call", () => {
  // DEFECT (ToolRunner.ts executeToolWithRace): `tool.execute(...)` is called outside a try, so a
  // synchronous throw rejects the whole batch with the tool's error and every sibling result is
  // lost. types.ts documents "Never throws (I2)". Remove `.fails` when fixed.
  it.fails("B1 a tool that throws before returning a promise is reported as TOOL_THREW and its sibling still resolves", async () => {
    const syncThrow = makeTool("sync_throw", () => {
      throw new Error("threw before returning a promise");
    });
    const sibling = recordingTool("sibling", "fine");
    const failureStreak = new Map<string, number>();
    const results = await runToolBatch(
      [makeCall("sync_throw"), makeCall("sibling")],
      baseOptions({ tools: toolMap(syncThrow, sibling.tool), failureStreak }),
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_THREW" });
    expect(results[0].content).toContain("threw before returning a promise");
    expect(results[1]).toMatchObject({ isError: false, content: "fine" });
    expect(failureStreak.get("sync_throw")).toBe(1);
  });

  // DEFECT (ToolRunner.ts capToolOutputContent): `JSON.stringify(rawValue)` is unguarded, so a
  // tool result JSON cannot encode rejects the whole batch ("Do not know how to serialize a
  // BigInt", "Converting circular structure to JSON", or a TypeError on `undefined.length` for
  // a function). Remove `.fails` when fixed.
  it.fails.each([
    ["a BigInt field", () => ({ rows: 3n })],
    ["a circular object", () => {
      const node: Record<string, unknown> = { name: "loop" };
      node.self = node;
      return node;
    }],
    ["a function", () => () => "not data"],
  ])("B2 a tool resolving with %s still yields one result instead of rejecting the batch", async (_label, build) => {
    const odd = makeTool("odd", async () => build());
    const sibling = recordingTool("sibling", "fine");
    const results = await runToolBatch(
      [makeCall("odd"), makeCall("sibling")],
      baseOptions({ tools: toolMap(odd, sibling.tool) }),
    );
    expect(results).toHaveLength(2);
    expect(results[0].toolCallId).toMatch(/^bcall_/);
    expect(typeof results[0].content).toBe("string");
    expect(results[0].content.length).toBeGreaterThan(0);
    expect(results[1]).toMatchObject({ isError: false, content: "fine" });
  });

  it("B3a a rejection with a non-Error value is reported with that value as the error text", async () => {
    const tools = toolMap(
      makeTool("rejects_string", () => Promise.reject("upstream said no")),
      makeTool("rejects_undefined", () => Promise.reject(undefined)),
      makeTool("rejects_object", () => Promise.reject({ status: 502 })),
    );
    const results = await runToolBatch(
      [makeCall("rejects_string"), makeCall("rejects_undefined"), makeCall("rejects_object")],
      baseOptions({ tools }),
    );
    expect(results.map((r) => r.errorCode)).toEqual(["TOOL_THREW", "TOOL_THREW", "TOOL_THREW"]);
    expect(JSON.parse(results[0].content).error).toBe("upstream said no");
    expect(JSON.parse(results[1].content).error).toBe("undefined");
    expect(JSON.parse(results[0].content).retry_guidance).toContain("Attempt 1/3 failed for rejects_string");
  });

  // DEFECT (ToolRunner.ts coerceArgs): `Object.entries(args)` throws "Cannot convert undefined
  // or null to object" when a known tool is called with `args: null`. The provider produces
  // that for a model that emits `"arguments": "null"` (src/utils/openai-compat.ts JSON.parse, no object
  // check) and CoreLoop passes it through. Remove `.fails` when fixed.
  it.fails("B3b args of the wrong top-level shape (null from a model that sent `null`) are a TOOL_BAD_ARGS result, not a rejected batch", async () => {
    const search = recordingTool("search", "ran", {
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });
    const results = await runToolBatch(
      [{ id: "null_args", name: "search", args: null as never }],
      baseOptions({ tools: toolMap(search.tool) }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "null_args", isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(search.executed).toHaveLength(0);
  });
});

describe("runToolBatch output capping and the spill buffer", () => {
  it.each([
    [undefined, "(tool returned no output)"],
    [null, "(tool returned no output)"],
    ["", "(tool returned no output)"],
    [0, "0"],
    [false, "false"],
    [[], "[]"],
    [{ ok: true }, '{"ok":true}'],
  ])("B4 a tool returning %j is shown to the model as %j", async (value, expected) => {
    const results = await runToolBatch(
      [makeCall("t")],
      baseOptions({ tools: toolMap(makeTool("t", async () => value)) }),
    );
    expect(results[0]).toMatchObject({ isError: false, content: expected });
  });

  it("B5 output exactly at the cap is untouched; one char over keeps the head and tail and names the cut", async () => {
    const atCap = "H".repeat(700) + "M".repeat(120) + "T".repeat(180);
    const overCap = "H".repeat(700) + "M".repeat(121) + "T".repeat(180);
    const tools = toolMap(makeTool("at", async () => atCap), makeTool("over", async () => overCap));
    const [at, over] = await runToolBatch(
      [makeCall("at"), makeCall("over")],
      baseOptions({ tools, toolOutputCap: 1000 }),
    );
    expect(at.content).toBe(atCap);
    expect(over.isError).toBe(false);
    expect(over.content.length).toBeLessThanOrEqual(1000);
    expect(over.content.startsWith("H".repeat(700) + "\n")).toBe(true);
    expect(over.content.endsWith("\n" + "T".repeat(180))).toBe(true);
    expect(over.content).toContain("cut 121 chars of 1001");
    expect(over.content).not.toContain("M");
  });

  it("B6a with a spill buffer the cut text is readable through read_tool_spill at any offset", async () => {
    const full = Array.from({ length: 4000 }, (_, i) => `row-${String(i).padStart(5, "0")};`).join("");
    const spillBuffer = new SpillBuffer();
    const options = baseOptions({ tools: toolMap(makeTool("dump", async () => full)), spillBuffer });
    const [dump] = await runToolBatch([makeCall("dump")], options);
    expect(dump.isError).toBe(false);
    expect(dump.content.length).toBeLessThanOrEqual(16000);
    expect(dump.content).toContain('spill_id="spill_1"');

    const [middle, clamped, pastEnd] = await runToolBatch(
      [
        makeCall("read_tool_spill", { spill_id: "spill_1", offset: 20_000, length: 50 }),
        makeCall("read_tool_spill", { spill_id: "spill_1", offset: 0, length: 999_999 }),
        makeCall("read_tool_spill", { spill_id: "spill_1", offset: full.length + 10 }),
      ],
      options,
    );
    expect(JSON.parse(middle.content)).toEqual({
      ok: true,
      spill_id: "spill_1",
      content: full.slice(20_000, 20_050),
      offset: 20_000,
      length: 50,
      totalChars: full.length,
      hasMore: true,
    });
    expect(JSON.parse(clamped.content).content).toBe(full.slice(0, 16_000));
    expect(JSON.parse(pastEnd.content)).toMatchObject({ ok: true, content: "", hasMore: false });
  });

  // DEFECT (ToolRunner.ts tryHandleBuiltInSpillRead): the built-in bypasses coerceArgs, so
  // `offset: "11205"` is silently read as offset 0 and `length: "10"` as 8000: the model asks
  // for the middle and is handed the head again, with no error. Remove `.fails` when fixed.
  it.fails("B6b read_tool_spill takes a numeric-string offset the way every schema-typed integer arg is taken", async () => {
    const full = "0123456789".repeat(3000);
    const spillBuffer = new SpillBuffer();
    const options = baseOptions({ tools: toolMap(makeTool("dump", async () => full)), spillBuffer });
    await runToolBatch([makeCall("dump")], options);
    const [read] = await runToolBatch(
      [makeCall("read_tool_spill", { spill_id: "spill_1", offset: "11205", length: "10" })],
      options,
    );
    expect(JSON.parse(read.content)).toMatchObject({ offset: 11_205, content: full.slice(11_205, 11_215) });
  });

  it("B7a read_tool_spill failures name the problem; without a buffer the tool does not exist", async () => {
    const spillBuffer = new SpillBuffer();
    const options = baseOptions({ tools: toolMap(makeTool("dump", async () => "z".repeat(20_000))), spillBuffer });
    await runToolBatch([makeCall("dump")], options);
    const [unknown, missing, blank] = await runToolBatch(
      [
        makeCall("read_tool_spill", { spill_id: "spill_9" }),
        makeCall("read_tool_spill", {}),
        makeCall("read_tool_spill", { spill_id: "   " }),
      ],
      options,
    );
    expect(unknown).toMatchObject({ isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(unknown.content).toContain('Unknown or expired spill_id \\"spill_9\\"');
    expect(unknown.content).toContain("spill_1");
    expect(missing).toMatchObject({ isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(missing.content).toContain('missing required "spill_id"');
    expect(blank.errorCode).toBe("TOOL_BAD_ARGS");

    const [noBuffer] = await runToolBatch(
      [makeCall("read_tool_spill", { spill_id: "spill_1" })],
      baseOptions({ tools: toolMap(makeTool("dump", async () => "x")) }),
    );
    expect(noBuffer).toMatchObject({ isError: true, errorCode: "TOOL_NOT_FOUND" });
    expect(noBuffer.content).toContain("Available tools: dump.");

    const [typo] = await runToolBatch([makeCall("no_such_tool")], options);
    expect(typo.content).toContain("Available tools: dump, read_tool_spill.");
  });

  it("B7b an output larger than the whole spill buffer is cut without promising a spill id", async () => {
    const spillBuffer = new SpillBuffer(1024);
    const [result] = await runToolBatch(
      [makeCall("dump")],
      baseOptions({ tools: toolMap(makeTool("dump", async () => "q".repeat(5000))), spillBuffer, toolOutputCap: 1000 }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("spill_id");
    expect(result.content).toContain("cut 4120 chars of 5000");
    expect(result.content.length).toBeLessThanOrEqual(1000);
    expect(spillBuffer.size()).toBe(0);
  });
});

describe("runToolBatch timeouts and cancellation", () => {
  const hang = (name: string, extra: Partial<CoreTool> = {}) => {
    const signals: AbortSignal[] = [];
    const tool = makeTool(name, (_args, ctx) => {
      signals.push(ctx.signal);
      return new Promise<unknown>(() => {});
    }, extra);
    return { tool, signals };
  };

  it("B8 a tool's own timeoutMs replaces the default and is the number the model is told", async () => {
    const timeouts = manualTimeouts();
    const custom = hang("custom", { timeoutMs: 7 });
    const plain = hang("plain");
    const pending = runToolBatch(
      [makeCall("custom"), makeCall("plain")],
      baseOptions({ tools: toolMap(custom.tool, plain.tool), defaultToolTimeoutMs: 1000, timeoutSignalFor: timeouts.timeoutSignalFor }),
    );
    (await timeouts.started("custom")).abort();
    (await timeouts.started("plain")).abort();
    const [customResult, plainResult] = await pending;
    expect(customResult).toMatchObject({ errorCode: "TOOL_TIMEOUT", content: '{"error":"timed out after 7 ms"}' });
    expect(plainResult).toMatchObject({ errorCode: "TOOL_TIMEOUT", content: '{"error":"timed out after 1000 ms"}' });
    // The tool was told to stop: its context signal fired with the timeout.
    expect(custom.signals[0].aborted).toBe(true);
  });

  it("B9 timeouts count toward the failure streak; at the cap the tool is refused without running", async () => {
    const slow = hang("slow");
    const failureStreak = new Map<string, number>();
    const options = baseOptions({
      tools: toolMap(slow.tool),
      maxConsecutiveToolErrors: 2,
      failureStreak,
      // Every execution's time limit has already passed.
      timeoutSignalFor: () => AbortSignal.abort(),
    });
    // A different argument each time, so the duplicate guard is not what refuses the call.
    const first = await runToolBatch([makeCall("slow", { n: 1 })], options);
    expect(first[0].errorCode).toBe("TOOL_TIMEOUT");
    expect(failureStreak.get("slow")).toBe(1);
    const second = await runToolBatch([makeCall("slow", { n: 2 })], options);
    expect(second[0].errorCode).toBe("TOOL_TIMEOUT");
    const third = await runToolBatch([makeCall("slow", { n: 3 })], options);
    expect(third[0]).toMatchObject({ isError: true, errorCode: "TOOL_REPEATED_FAILURE" });
    expect(third[0].content).toContain('"slow" failed 2 times in a row');
    expect(slow.signals).toHaveLength(2);
  });

  it("B10 a cancelled call leaves no trace: no failure streak, no history entry, and the same call runs on the next batch", async () => {
    const controller = new AbortController();
    const history = createToolCallHistory();
    const failureStreak = new Map<string, number>();
    const timeouts = manualTimeouts();
    let runs = 0;
    const signals: AbortSignal[] = [];
    const lookup = makeTool("lookup", (_args, ctx) => {
      runs += 1;
      signals.push(ctx.signal);
      return runs === 1 ? new Promise<unknown>(() => {}) : Promise.resolve("second run answered");
    });
    const shared = { tools: toolMap(lookup), callHistory: history, failureStreak, timeoutSignalFor: timeouts.timeoutSignalFor };
    const pending = runToolBatch([makeCall("lookup", { id: 7 })], baseOptions({ ...shared, signal: controller.signal }));
    await timeouts.started("lookup");
    controller.abort();
    const [cancelled] = await pending;
    expect(cancelled).toMatchObject({ isError: true, errorCode: "TOOL_CANCELLED", content: '{"error":"cancelled"}' });
    expect(signals[0].aborted).toBe(true);
    expect(failureStreak.size).toBe(0);
    expect(history.entries).toHaveLength(0);

    const [retried] = await runToolBatch([makeCall("lookup", { id: 7 })], baseOptions(shared));
    expect(retried).toMatchObject({ isError: false, content: "second run answered" });
  });

  it("B11a when the run is cancelled and the tool's timeout fires together, the result is TOOL_CANCELLED", async () => {
    const controller = new AbortController();
    const timeouts = manualTimeouts();
    const slow = hang("slow");
    const failureStreak = new Map<string, number>();
    const pending = runToolBatch(
      [makeCall("slow")],
      baseOptions({ tools: toolMap(slow.tool), signal: controller.signal, failureStreak, timeoutSignalFor: timeouts.timeoutSignalFor }),
    );
    const timeout = await timeouts.started("slow");
    timeout.abort();
    controller.abort();
    const [result] = await pending;
    expect(result.errorCode).toBe("TOOL_CANCELLED");
    expect(failureStreak.size).toBe(0);
  });

  it("B11b a tool that finishes in the same tick the run is cancelled is still reported cancelled, never as a success", async () => {
    const controller = new AbortController();
    const quick = makeTool("quick", async () => {
      controller.abort();
      return "finished anyway";
    });
    const [result] = await runToolBatch([makeCall("quick")], baseOptions({ tools: toolMap(quick), signal: controller.signal }));
    expect(result).toMatchObject({ isError: true, errorCode: "TOOL_CANCELLED" });
    expect(result.content).not.toContain("finished anyway");
  });
});

describe("runToolBatch ordering and concurrency", () => {
  /** Runs `count` calls of one tool that yields to the event loop while "working"; returns the peak overlap. */
  const peakOverlap = async (count: number, cap: number | undefined) => {
    let active = 0;
    let peak = 0;
    const busy = makeTool("busy", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return "done";
    });
    const results = await runToolBatch(
      Array.from({ length: count }, () => makeCall("busy")),
      baseOptions({ tools: toolMap(busy), parallelToolMaxConcurrency: cap }),
    );
    expect(results.every((r) => r.isError === false && r.content === "done")).toBe(true);
    expect(results).toHaveLength(count);
    return peak;
  };

  it.each([
    [2, 2],
    [1, 1],
    [0, 1],
    [-5, 1],
    [undefined, 8],
    [50, 12],
  ])("B12 with parallelToolMaxConcurrency=%s at most %s of 12 calls run at once and all 12 finish", async (cap, expectedPeak) => {
    expect(await peakOverlap(12, cap)).toBe(expectedPeak);
  });

  it("B13 results stay in call order when a later call finishes first", async () => {
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = makeTool("first", async () => {
      await release.promise;
      order.push("first");
      return "first answer";
    });
    const second = makeTool("second", async () => {
      order.push("second");
      release.resolve();
      return "second answer";
    });
    const calls = [makeCall("first"), makeCall("second")];
    const results = await runToolBatch(calls, baseOptions({ tools: toolMap(first, second) }));
    expect(order).toEqual(["second", "first"]);
    expect(results.map((r) => r.content)).toEqual(["first answer", "second answer"]);
    expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.id));
  });

  it("B14 exclusive tools start only after every parallel call has finished, one at a time, in call order", async () => {
    const log: string[] = [];
    const logged = (name: string, exclusive: boolean) =>
      makeTool(name, async () => {
        log.push(`start ${name}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        log.push(`end ${name}`);
        return name;
      }, { exclusive });
    const tools = toolMap(logged("write_a", true), logged("read_1", false), logged("write_b", true), logged("read_2", false));
    const results = await runToolBatch(
      [makeCall("write_a"), makeCall("read_1"), makeCall("write_b"), makeCall("read_2")],
      baseOptions({ tools }),
    );
    expect(log).toEqual([
      "start read_1",
      "start read_2",
      "end read_1",
      "end read_2",
      "start write_a",
      "end write_a",
      "start write_b",
      "end write_b",
    ]);
    expect(results.map((r) => r.content)).toEqual(["write_a", "read_1", "write_b", "read_2"]);
  });
});

describe("runToolBatch duplicate and oscillation guard", () => {
  /** One run: two write-style tools sharing a history; `call` runs a single-call batch. */
  const session = () => {
    const alpha = recordingTool("alpha_op", "alpha result");
    const beta = recordingTool("beta_op", "beta result");
    const failureStreak = new Map<string, number>();
    const history = createToolCallHistory();
    const options = baseOptions({ tools: toolMap(alpha.tool, beta.tool), failureStreak, callHistory: history });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await runToolBatch([makeCall(name, args)], options))[0];
    return { alpha, beta, failureStreak, history, call };
  };

  it("B15a the sixth call of an A,B,A,B,A,B run is refused as TOOL_OSCILLATION without executing or counting as a failure", async () => {
    const run = session();
    for (const name of ["alpha_op", "beta_op", "alpha_op", "beta_op", "alpha_op"]) {
      expect((await run.call(name, { id: 1 })).isError).toBe(false);
    }
    const sixth = await run.call("beta_op", { id: 1 });
    expect(sixth).toMatchObject({ isError: true, errorCode: "TOOL_OSCILLATION" });
    const body = JSON.parse(sixth.content);
    expect(body.code).toBe("TOOL_OSCILLATION");
    expect(body.retry_guidance).toContain('"alpha_op"');
    expect(body.retry_guidance).toContain('"beta_op"');
    expect(run.beta.executed).toHaveLength(2);
    expect(run.failureStreak.size).toBe(0);
    expect(run.history.finalizeNow).toBe(false);

    // Insisting on the refused call ends the tool phase instead of looping forever.
    const seventh = await run.call("beta_op", { id: 1 });
    expect(seventh).toMatchObject({ isError: true, errorCode: "TOOL_STALL" });
    expect(run.beta.executed).toHaveLength(2);
    expect(run.history.finalizeNow).toBe(true);
    expect(run.history.finalizeReason).toBe("repeated_tool_call:beta_op");
  });

  it("B15b calls without arguments oscillate too", async () => {
    const run = session();
    for (const name of ["alpha_op", "beta_op", "alpha_op", "beta_op", "alpha_op"]) await run.call(name);
    expect((await run.call("beta_op")).errorCode).toBe("TOOL_OSCILLATION");
  });

  it("B16 two full A,B cycles are allowed, and alternation with changing arguments is progress, not oscillation", async () => {
    const twoCycles = session();
    for (const name of ["alpha_op", "beta_op", "alpha_op", "beta_op"]) await twoCycles.call(name, { id: 1 });
    expect(await twoCycles.call("alpha_op", { id: 1 })).toMatchObject({ isError: false, content: "alpha result" });
    expect(twoCycles.alpha.executed).toHaveLength(3);

    const paging = session();
    for (let page = 1; page <= 4; page++) {
      expect((await paging.call("alpha_op", { page })).isError).toBe(false);
      expect((await paging.call("beta_op", { id: 1 })).isError).toBe(false);
    }
    expect(paging.alpha.executed).toHaveLength(4);
    expect(paging.beta.executed).toHaveLength(4);
  });

  it("B17 a repeat is recognised by meaning: key order, undefined fields and schema coercion do not hide it", async () => {
    const save = recordingTool("save_note", "saved", {
      parameters: { type: "object", properties: { limit: { type: "integer" }, tags: { type: "array" } }, required: [] },
    });
    const run = (first: Record<string, unknown>, second: Record<string, unknown>) => {
      const options = baseOptions({ tools: toolMap(save.tool), callHistory: createToolCallHistory() });
      return runToolBatch([makeCall("save_note", first)], options).then(() => runToolBatch([makeCall("save_note", second)], options));
    };
    for (const [first, second] of [
      [{ a: 1, b: { y: 2, x: 1 } }, { b: { x: 1, y: 2 }, a: 1 }],
      [{ a: 1 }, { a: 1, note: undefined }],
      [{ limit: "10" }, { limit: 10 }],
      [{ tags: "x,y" }, { tags: ["x", "y"] }],
    ]) {
      const [repeat] = await run(first, second);
      expect(repeat, JSON.stringify([first, second])).toMatchObject({ isError: true, errorCode: "TOOL_STALL" });
      expect(JSON.parse(repeat.content).retry_guidance).toContain("Reuse the existing result");
    }
    // Array order is meaning: a reordered list is a different call.
    const [reordered] = await run({ tags: ["x", "y"] }, { tags: ["y", "x"] });
    expect(reordered).toMatchObject({ isError: false, content: "saved" });
  });

  it("B18 what does NOT count as a repeat: a call after its own failure, a no-argument call, a call with another in between", async () => {
    let attempts = 0;
    const flaky = makeTool("flaky_op", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return "worked";
    });
    const noArgs = recordingTool("refresh_op", "fresh");
    const other = recordingTool("other_op", "other");
    const options = baseOptions({ tools: toolMap(flaky, noArgs.tool, other.tool), callHistory: createToolCallHistory() });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await runToolBatch([makeCall(name, args)], options))[0];

    expect((await call("flaky_op", { id: 1 })).errorCode).toBe("TOOL_THREW");
    expect(await call("flaky_op", { id: 1 })).toMatchObject({ isError: false, content: "worked" });

    for (let i = 0; i < 4; i++) expect((await call("refresh_op")).isError).toBe(false);
    expect(noArgs.executed).toHaveLength(4);

    expect((await call("other_op", { id: 1 })).isError).toBe(false);
    expect((await call("refresh_op")).isError).toBe(false);
    expect((await call("other_op", { id: 1 })).isError).toBe(false);
    expect(other.executed).toHaveLength(2);
  });

  it("B19a the third identical call ends the tool phase; a blocked repeat never counts as a tool failure", async () => {
    const run = session();
    expect((await run.call("alpha_op", { id: 9 })).isError).toBe(false);
    const second = await run.call("alpha_op", { id: 9 });
    expect(second.errorCode).toBe("TOOL_STALL");
    expect(run.history.finalizeNow).toBe(false);
    const third = await run.call("alpha_op", { id: 9 });
    expect(third.errorCode).toBe("TOOL_STALL");
    expect(JSON.parse(third.content).finalizeReason).toBe("repeated_tool_call:alpha_op");
    expect(run.history.finalizeNow).toBe(true);
    expect(run.alpha.executed).toHaveLength(1);
    expect(run.failureStreak.size).toBe(0);
  });

  it("B19b without an explicit history, repeats are tracked per run (per failureStreak map), never across runs", async () => {
    const save = recordingTool("save_note", "saved");
    const runA = baseOptions({ tools: toolMap(save.tool) });
    const runB = baseOptions({ tools: toolMap(save.tool) });
    expect((await runToolBatch([makeCall("save_note", { id: 1 })], runA))[0].isError).toBe(false);
    expect((await runToolBatch([makeCall("save_note", { id: 1 })], runB))[0].isError).toBe(false);
    expect((await runToolBatch([makeCall("save_note", { id: 1 })], runA))[0].errorCode).toBe("TOOL_STALL");
    expect(save.executed).toHaveLength(2);
  });
});

describe("runToolBatch argument boundaries", () => {
  const typed = () =>
    recordingTool("typed", "ran", {
      parameters: {
        type: "object",
        properties: {
          list: { type: "array" },
          map: { type: "object" },
          count: { type: "integer" },
          ratio: { type: "number" },
          flag: { type: "boolean" },
          text: { type: "string" },
        },
        required: [],
      },
    });
  /** Runs one call; returns what the tool received, or the rejection text when it never ran. */
  const send = async (args: Record<string, unknown>) => {
    const tool = typed();
    const [result] = await runToolBatch([makeCall("typed", args)], baseOptions({ tools: toolMap(tool.tool) }));
    return tool.executed.length === 1 ? { received: tool.executed[0] } : { rejected: result.content, code: result.errorCode };
  };

  it.each([
    ["a JSON array of numbers keeps its numbers", "[1, 2]", [1, 2]],
    ["an empty JSON array", "[]", []],
    ["a boolean becomes one item", true, ["true"]],
    ["a boolean string becomes one item", "false", ["false"]],
    ["a negative number string becomes one item", " -3.5 ", ["-3.5"]],
    ["mixed quotes in a CSV", `a, 'b', "c"`, ["a", "b", "c"]],
    ["a Python list with a trailing comma", "['a', 'b', ]", ["a", "b"]],
    ["a single bare word", "AAPL", ["AAPL"]],
  ])("B20 array argument: %s", async (_label, sent, expected) => {
    expect(await send({ list: sent })).toEqual({ received: { list: expected } });
  });

  it.each([
    ["the string null", "null", 'string "null"'],
    ["a real null", null, "null"],
    ["an empty string", "", 'string ""'],
    ["blank text", "   ", 'string "   "'],
    ["an unclosed bracket", "[a, b", 'string "[a, b"'],
    ["an object string", '{"a":1}', 'string "{\\"a\\":1}"'],
    ["an object", { a: 1 }, 'object {"a":1}'],
    ["only separators", " , , ", 'string " , , "'],
  ])("B21 array argument rejected with what was sent: %s", async (_label, sent, described) => {
    expect(await send({ list: sent })).toEqual({
      rejected: `Invalid arguments for "typed": "list" must be array (got ${described}).`,
      code: "TOOL_BAD_ARGS",
    });
  });

  it("B22 object, number and integer arguments: what is converted and what is refused", async () => {
    expect(await send({ map: ' {"a": {"b": 1}} ' })).toEqual({ received: { map: { a: { b: 1 } } } });
    expect(await send({ map: "[1]" })).toMatchObject({ code: "TOOL_BAD_ARGS", rejected: expect.stringContaining('"map" must be object (got string "[1]")') });
    expect(await send({ map: "null" })).toMatchObject({ code: "TOOL_BAD_ARGS" });
    expect(await send({ map: [1] })).toMatchObject({ rejected: expect.stringContaining('"map" must be object (got array [1])') });

    expect(await send({ count: " 12 ", ratio: "1e3" })).toEqual({ received: { count: 12, ratio: 1000 } });
    expect(await send({ count: "-0" })).toEqual({ received: { count: -0 } });
    expect(await send({ count: "1.5" })).toMatchObject({ rejected: expect.stringContaining('"count" must be integer (got number 1.5)') });
    expect(await send({ count: "12abc" })).toMatchObject({ rejected: expect.stringContaining('"count" must be integer (got string "12abc")') });
    expect(await send({ count: "" })).toMatchObject({ rejected: expect.stringContaining('"count" must be integer (got string "")') });
    expect(await send({ count: true })).toMatchObject({ rejected: expect.stringContaining('"count" must be integer (got boolean true)') });
    expect(await send({ ratio: "NaN" })).toMatchObject({ code: "TOOL_BAD_ARGS" });
  });

  it("B23 several bad arguments are all listed, long values are previewed at 40 chars, and unknown properties pass through", async () => {
    const long = "x".repeat(100);
    const many = await send({ count: long, flag: 1, map: 7 });
    expect(many).toEqual({
      rejected:
        `Invalid arguments for "typed": "count" must be integer (got string ${JSON.stringify(long).slice(0, 40)}); ` +
        `"flag" must be boolean (got number 1); "map" must be object (got number 7).`,
      code: "TOOL_BAD_ARGS",
    });
    expect(await send({ count: 10n })).toMatchObject({ rejected: expect.stringContaining('"count" must be integer (got bigint 10)') });
    expect(await send({ extra: { deep: [1] }, text: "kept" })).toEqual({ received: { extra: { deep: [1] }, text: "kept" } });
  });

  it("B24 __raw boundaries: only a lone string __raw is unwrapped; the repaired object is still coerced and validated", async () => {
    expect(await send({ __raw: '```json\n{"count": "5", "list": "a,b",}\n```' })).toEqual({ received: { count: 5, list: ["a", "b"] } });
    expect(await send({ __raw: '{"count": "five"}' })).toMatchObject({
      code: "TOOL_BAD_ARGS",
      rejected: expect.stringContaining('"count" must be integer (got string "five")'),
    });
    for (const raw of ["[1, 2]", '"just text"', "42", "null", "", "{"]) {
      expect(await send({ __raw: raw }), raw).toEqual({ rejected: `Arguments were not valid JSON: ${raw}`, code: "TOOL_BAD_ARGS" });
    }
    const huge = `{"text": "${"y".repeat(500)}`;
    expect(await send({ __raw: huge })).toEqual({ rejected: `Arguments were not valid JSON: ${huge.slice(0, 200)}`, code: "TOOL_BAD_ARGS" });
    // Not the wrapper shape: a second key, or a non-string __raw, is an ordinary argument object.
    expect(await send({ __raw: '{"count": 1}', text: "t" })).toEqual({ received: { __raw: '{"count": 1}', text: "t" } });
    expect(await send({ __raw: 5 })).toEqual({ received: { __raw: 5 } });
  });

  it("B25a the failure streak counts rejected arguments: under the cap a valid call runs and clears it, at the cap it is refused", async () => {
    const tool = recordingTool("strict", "ran", {
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });
    const failureStreak = new Map<string, number>();
    const options = baseOptions({ tools: toolMap(tool.tool), failureStreak, maxConsecutiveToolErrors: 3 });
    const call = async (args: Record<string, unknown>) => (await runToolBatch([makeCall("strict", args)], options))[0];

    expect((await call({})).errorCode).toBe("TOOL_BAD_ARGS");
    expect((await call({ q: null })).errorCode).toBe("TOOL_BAD_ARGS");
    expect(failureStreak.get("strict")).toBe(2);
    expect(await call({ q: "now valid" })).toMatchObject({ isError: false, content: "ran" });
    expect(failureStreak.has("strict")).toBe(false);

    for (let i = 0; i < 3; i++) expect((await call({ n: i })).errorCode).toBe("TOOL_BAD_ARGS");
    const refused = await call({ q: "valid but too late" });
    expect(refused).toMatchObject({ isError: true, errorCode: "TOOL_REPEATED_FAILURE" });
    expect(refused.content).toContain('"strict" failed 3 times in a row');
    expect(tool.executed).toEqual([{ q: "now valid" }]);
  });

  it("B25b a tool registered under both a bare and a namespaced name is called by the exact name asked for", async () => {
    const bare = recordingTool("whiteboard_read", "bare");
    const namespaced = recordingTool("mcp__lazy-agent-service__whiteboard_read", "namespaced");
    const results = await runToolBatch(
      [makeCall("whiteboard_read"), makeCall("mcp__lazy-agent-service__whiteboard_read")],
      baseOptions({ tools: toolMap(bare.tool, namespaced.tool) }),
    );
    expect(results.map((r) => [r.name, r.content])).toEqual([
      ["whiteboard_read", "bare"],
      ["mcp__lazy-agent-service__whiteboard_read", "namespaced"],
    ]);
  });
});
