import { describe, expect, it } from "vitest";
import { runToolBatch } from "../ToolRunner.ts";
import type { CoreTool, CoreToolCall, CoreToolResult, ToolBatchOptions } from "../types.ts";

let idCounter = 0;

const makeCall = (name: string, args: Record<string, unknown> = {}): CoreToolCall => {
  idCounter += 1;
  return { id: `call_${idCounter}`, name, args };
};

const makeTool = (
  name: string,
  execute: (args: Record<string, unknown>, ctx: { toolCallId: string; signal: AbortSignal }) => Promise<unknown>,
  extra: Partial<CoreTool> = {},
): CoreTool => ({
  name,
  description: `${name} description`,
  parameters: { type: "object", properties: {}, required: [] },
  execute,
  ...extra,
});

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

describe("runToolBatch", () => {
  it("R1+R7: returns exactly one result per call in input order with mixed outcomes", async () => {
    const okTool = makeTool("ok", async () => "fine");
    const throwingTool = makeTool("boom", async () => {
      throw new Error("kaboom");
    });
    const exclusiveTool = makeTool("solo", async () => "solo ran", { exclusive: true });
    const argTool = makeTool("argy", async () => "nope", {
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });
    const tools = new Map(
      [okTool, throwingTool, exclusiveTool, argTool].map((t) => [t.name, t] as const),
    );
    const calls = [
      makeCall("ok"),
      makeCall("boom"),
      makeCall("missing_tool"),
      makeCall("argy", { q: 5 }),
      makeCall("solo"),
      makeCall("ok"),
    ];
    const results = await runToolBatch(calls, baseOptions({ tools }));
    expect(results).toHaveLength(6);
    expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.id));
    expect(results.map((r) => r.name)).toEqual(calls.map((c) => c.name));
    expect(results[0]).toMatchObject({ isError: false, content: "fine" });
    expect(results[1]).toMatchObject({ isError: true, errorCode: "TOOL_THREW" });
    expect(results[1].content).toContain("kaboom");
    expect(results[2]).toMatchObject({ isError: true, errorCode: "TOOL_NOT_FOUND" });
    expect(results[3]).toMatchObject({ isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(results[4]).toMatchObject({ isError: false, content: "solo ran" });
    expect(results[5]).toMatchObject({ isError: false, content: "fine" });
    expect(results.every((r) => typeof r.durationMs === "number")).toBe(true);
  });

  it("R2: unknown tool lists available names and suggests a close match", async () => {
    const readPage = makeTool("read_page", async () => "x");
    const globalSearch = makeTool("global.web.search", async () => "x");
    const tools = new Map([
      [readPage.name, readPage],
      [globalSearch.name, globalSearch],
    ] as const);
    const results = await runToolBatch([makeCall("web_serch")], baseOptions({ tools }));
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_NOT_FOUND" });
    expect(results[0].content).toContain('Tool "web_serch" not found');
    expect(results[0].content).toContain("global.web.search, read_page");
    expect(results[0].content).not.toContain("Did you mean");

    const near = await runToolBatch([makeCall("read_pag")], baseOptions({ tools }));
    expect(near[0].errorCode).toBe("TOOL_NOT_FOUND");
    expect(near[0].content).toContain('Did you mean "read_page"?');
  });

  it("R2b: a bare name dispatches to its unique mcp__-namespaced tool (cycle-v3-1792387891)", async () => {
    let received: unknown;
    const whiteboardRead = makeTool("mcp__lazy-agent-service__whiteboard_read", async (args) => {
      received = args;
      return "market_context: ok";
    });
    const fundamentals = makeTool("mcp__lazy-agent-service__get_finviz_fundamentals", async () => "x");
    const tools = new Map([
      [whiteboardRead.name, whiteboardRead],
      [fundamentals.name, fundamentals],
    ] as const);
    const results = await runToolBatch(
      [makeCall("whiteboard_read", { section: "market_context" })],
      baseOptions({ tools }),
    );
    expect(results[0]).toMatchObject({
      isError: false,
      content: "market_context: ok",
      name: "mcp__lazy-agent-service__whiteboard_read",
    });
    expect(received).toEqual({ section: "market_context" });
  });

  it("R2c: a bare name matching two namespaced tools stays TOOL_NOT_FOUND", async () => {
    let executed = 0;
    const a = makeTool("mcp__lazy-agent-service__whiteboard_read", async () => { executed += 1; return "a"; });
    const b = makeTool("mcp__lazy-tools__whiteboard_read", async () => { executed += 1; return "b"; });
    const tools = new Map([
      [a.name, a],
      [b.name, b],
    ] as const);
    const results = await runToolBatch([makeCall("whiteboard_read")], baseOptions({ tools }));
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_NOT_FOUND", name: "whiteboard_read" });
    expect(executed).toBe(0);
  });

  it("R3: missing required arg reports TOOL_BAD_ARGS and does not run the tool", async () => {
    let executed = 0;
    const tool = makeTool(
      "search",
      async () => {
        executed += 1;
        return "ran";
      },
      { parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    );
    const tools = new Map([[tool.name, tool]] as const);
    const results = await runToolBatch([makeCall("search", {})], baseOptions({ tools }));
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(results[0].content).toBe('Invalid arguments for "search": missing required "query".');
    expect(executed).toBe(0);
  });

  it("R3: wrong type and non-integer values are reported per property", async () => {
    const search = makeTool("search", async () => "ran", {
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" }, flag: { type: "boolean" } },
        required: [],
      },
    });
    const tools = new Map([[search.name, search]] as const);
    const results = await runToolBatch(
      [makeCall("search", { query: 42, limit: 1.5, flag: "yes" })],
      baseOptions({ tools }),
    );
    expect(results[0].errorCode).toBe("TOOL_BAD_ARGS");
    expect(results[0].content).toBe('Invalid arguments for "search": "query" must be string; "limit" must be integer; "flag" must be boolean.');
  });

  it("R3: __raw with fenced/trailing-comma JSON repairs and runs", async () => {
    let received: unknown;
    const search = makeTool(
      "search",
      async (args) => {
        received = args;
        return "ran";
      },
      { parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    );
    const tools = new Map([[search.name, search]] as const);
    const raw = '```json\n{"query": "cats",\n}\n```';
    const results = await runToolBatch([makeCall("search", { __raw: raw })], baseOptions({ tools }));
    expect(results[0]).toMatchObject({ isError: false, content: "ran" });
    expect(received).toEqual({ query: "cats" });
  });

  it("R3: __raw that cannot be repaired reports the raw prefix", async () => {
    let executed = 0;
    const search = makeTool(
      "search",
      async () => {
        executed += 1;
        return "ran";
      },
      { parameters: { type: "object", properties: {}, required: [] } },
    );
    const tools = new Map([[search.name, search]] as const);
    const raw = '```json\n{"query": "cats",,,\n';
    const results = await runToolBatch([makeCall("search", { __raw: raw })], baseOptions({ tools }));
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(results[0].content).toBe(`Arguments were not valid JSON: ${raw.slice(0, 200)}`);
    expect(executed).toBe(0);
  });

  it("R4: a tool at the failure-streak cap is not executed; success clears the streak", async () => {
    let executed = 0;
    const flaky = makeTool(
      "flaky",
      async () => {
        executed += 1;
        throw new Error("nope");
      },
    );
    const tools = new Map([[flaky.name, flaky]] as const);
    const failureStreak = new Map([["flaky", 3]]);
    const opts = baseOptions({ tools, failureStreak, maxConsecutiveToolErrors: 3 });

    const blocked = await runToolBatch([makeCall("flaky")], opts);
    expect(blocked[0]).toMatchObject({ isError: true, errorCode: "TOOL_REPEATED_FAILURE" });
    expect(blocked[0].content).toBe(
      '"flaky" failed 3 times in a row; stop calling it and answer with what you have or use another tool.',
    );
    expect(executed).toBe(0);

    failureStreak.set("flaky", 1);
    const failing = await runToolBatch([makeCall("flaky")], opts);
    expect(failing[0].errorCode).toBe("TOOL_THREW");
    expect(executed).toBe(1);
    expect(failureStreak.get("flaky")).toBe(2);

    const healing = makeTool("healing", async () => "ok");
    const tools2 = new Map([[healing.name, healing]] as const);
    const streak2 = new Map([["healing", 2]]);
    const opts2 = baseOptions({ tools: tools2, failureStreak: streak2, maxConsecutiveToolErrors: 3 });
    const ok = await runToolBatch([makeCall("healing")], opts2);
    expect(ok[0].isError).toBe(false);
    expect(streak2.has("healing")).toBe(false);
  });

  it("R5: beforeToolCall deny, throwing hook, and allow-with-args behave as specified", async () => {
    let executedWith: unknown;
    const tool = makeTool(
      "cap",
      async (args) => {
        executedWith = args;
        return "ran";
      },
      { parameters: { type: "object", properties: {}, required: [] } },
    );
    const tools = new Map([[tool.name, tool]] as const);

    const denied = await runToolBatch(
      [makeCall("cap")],
      baseOptions({ tools, hooks: { beforeToolCall: [() => ({ action: "deny", reason: "not today" })] } }),
    );
    expect(denied[0]).toMatchObject({ isError: true, errorCode: "TOOL_DENIED" });
    expect(denied[0].content).toBe("Tool call denied: not today");

    const throwing = await runToolBatch(
      [makeCall("cap")],
      baseOptions({
        tools,
        hooks: {
          beforeToolCall: [
            () => {
              throw new Error("policy exploded");
            },
          ],
        },
      }),
    );
    expect(throwing[0].errorCode).toBe("TOOL_DENIED");
    expect(throwing[0].content).toBe("Tool call denied: policy check failed: policy exploded");

    let seenBySecondHook: unknown;
    const allowed = await runToolBatch(
      [makeCall("cap", { original: true })],
      baseOptions({
        tools,
        hooks: {
          beforeToolCall: [
            () => ({ action: "allow", args: { rewritten: true } }),
            (call) => {
              seenBySecondHook = call.args;
              return { action: "allow" };
            },
          ],
        },
      }),
    );
    expect(allowed[0]).toMatchObject({ isError: false, content: "ran" });
    expect(executedWith).toEqual({ rewritten: true });
    expect(seenBySecondHook).toEqual({ rewritten: true });
  });

  it("R6: timeout abandons a tool that ignores its signal; siblings still resolve", async () => {
    const { promise: signalReady, resolve: signalResolve } = Promise.withResolvers<AbortController>();
    const slow = makeTool("slow", () => new Promise(() => {})); // never resolves, ignores signal
    const fast = makeTool("fast", async () => "quick");
    const tools = new Map([
      [slow.name, slow],
      [fast.name, fast],
    ] as const);
    const opts: ToolBatchOptions = {
      ...baseOptions({ tools, defaultToolTimeoutMs: 50 }),
      timeoutSignalFor: (_toolName, _ms) => {
        const controller = new AbortController();
        signalResolve(controller);
        return controller.signal;
      },
    };
    const pending = runToolBatch([makeCall("slow"), makeCall("fast")], opts);
    const controller = await signalReady;
    controller.abort();
    const results = await pending;
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_TIMEOUT" });
    expect(results[0].content).toBe('{"error":"timed out after 50 ms"}');
    expect(results[1]).toMatchObject({ isError: false, content: "quick" });
  });

  it("R6: run-level abort mid-run yields TOOL_CANCELLED", async () => {
    const controller = new AbortController();
    const { promise: started, resolve: startResolve } = Promise.withResolvers<void>();
    const hanging = makeTool("hanging", async () => {
      startResolve();
      return new Promise(() => {});
    });
    const tools = new Map([[hanging.name, hanging]] as const);
    const pending = runToolBatch([makeCall("hanging")], baseOptions({ tools, signal: controller.signal }));
    await started;
    controller.abort();
    const results = await pending;
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_CANCELLED" });
    expect(results[0].content).toBe('{"error":"cancelled"}');
  });

  it("R6: an already-aborted run signal cancels calls without executing them", async () => {
    let executed = 0;
    const tool = makeTool("tool", async () => {
      executed += 1;
      return "ran";
    });
    const tools = new Map([[tool.name, tool]] as const);
    const controller = new AbortController();
    controller.abort();
    const results = await runToolBatch([makeCall("tool")], baseOptions({ tools, signal: controller.signal }));
    expect(results[0]).toMatchObject({ isError: true, errorCode: "TOOL_CANCELLED" });
    expect(results[0].durationMs).toBe(0);
    expect(executed).toBe(0);
  });

  it("R8: huge output is head+tail capped; errors capped at toolErrorCap", async () => {
    const big = makeTool("big", async () => "a".repeat(5_000_000));
    const loud = makeTool("loud", async () => {
      throw new Error("e".repeat(3000));
    });
    const tools = new Map([
      [big.name, big],
      [loud.name, loud],
    ] as const);
    const results = await runToolBatch(
      [makeCall("big"), makeCall("loud")],
      baseOptions({ tools, toolOutputCap: 16000, toolErrorCap: 2048 }),
    );
    expect(results[0].content.length).toBeLessThanOrEqual(16120);
    expect(results[0].content).toContain("cut");
    expect(results[0].content).toContain("chars of 5000000");
    expect(results[0].content.startsWith("a")).toBe(true);
    expect(results[0].content.endsWith("a")).toBe(true);
    expect(results[1].content.length).toBe(2048);
    expect(results[1].errorCode).toBe("TOOL_THREW");
  });

  it("R9: afterToolCall may rewrite results; a throwing hook leaves them unchanged", async () => {
    const tool = makeTool("t", async () => "original");
    const tools = new Map([[tool.name, tool]] as const);
    const rewrite = (call: CoreToolCall, result: CoreToolResult): CoreToolResult => ({
      ...result,
      content: `rewritten:${call.name}:${result.content}`,
    });
    const results = await runToolBatch(
      [makeCall("t")],
      baseOptions({ tools, hooks: { afterToolCall: [rewrite] } }),
    );
    expect(results[0].content).toBe("rewritten:t:original");

    const throwing = await runToolBatch(
      [makeCall("t")],
      baseOptions({
        tools,
        hooks: {
          afterToolCall: [
            () => {
              throw new Error("hook down");
            },
          ],
        },
      }),
    );
    expect(throwing[0]).toMatchObject({ isError: false, content: "original" });
  });

  it("F1: string-encoded JSON and numeric-string args are coerced per schema before validation; invalid strings still rejected", async () => {
    const executed: Record<string, unknown>[] = [];
    const screener = makeTool("screener", async (args) => {
      executed.push(args);
      return "ok";
    }, {
      parameters: {
        type: "object",
        properties: {
          filters: { type: "array" },
          columns: { type: "array" },
          limit: { type: "integer" },
        },
        required: ["filters", "columns", "limit"],
      },
    });
    const tools = new Map([[screener.name, screener] as const]);

    const results = await runToolBatch(
      [
        makeCall("screener", {
          filters: '[{"field":"pe","op":"<","value":20}]',
          columns: '["ticker"]',
          limit: "10",
        }),
      ],
      baseOptions({ tools }),
    );
    expect(results[0]).toMatchObject({ isError: false, content: "ok" });
    expect(executed[0]).toEqual({
      filters: [{ field: "pe", op: "<", value: 20 }],
      columns: ["ticker"],
      limit: 10,
    });

    const rejected = await runToolBatch(
      [makeCall("screener", { filters: "[]", columns: "[]", limit: "abc" })],
      baseOptions({ tools }),
    );
    expect(rejected[0]).toMatchObject({ isError: true, errorCode: "TOOL_BAD_ARGS" });
    expect(rejected[0].content).toContain('"limit"');
  });
});
