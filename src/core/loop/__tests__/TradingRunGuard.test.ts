import { beforeEach, describe, expect, it } from "vitest";
import { runToolBatch } from "../ToolRunner.ts";
import { resetGuard } from "../../../services/ToolCallGuard.ts";
import { STOP_DO_NOT_RETRY_SCRAPE } from "../../../services/UnscrapableDomains.ts";
import type { CoreTool, CoreToolCall, ToolBatchOptions } from "../types.ts";

let idCounter = 0;

const makeCall = (name: string, args: Record<string, unknown> = {}): CoreToolCall => {
  idCounter += 1;
  return { id: `call_${idCounter}`, name, args };
};

const makeTool = (
  name: string,
  execute: (args: Record<string, unknown>) => Promise<unknown>,
  extra: Partial<CoreTool> = {},
): CoreTool => ({
  name,
  description: `${name} description`,
  parameters: { type: "object", properties: {}, required: [] },
  execute,
  ...extra,
});

const SCRAPE = "mcp__lazy-agent-service__scrape_url";

/** One batch options object per run: the failureStreak map is the run identity. */
const runOptions = (
  tools: CoreTool[],
  over: Partial<ToolBatchOptions> = {},
): ToolBatchOptions => ({
  tools: new Map(tools.map((tool) => [tool.name, tool] as const)),
  hooks: {},
  signal: new AbortController().signal,
  defaultToolTimeoutMs: 1000,
  toolOutputCap: 16000,
  toolErrorCap: 2048,
  maxConsecutiveToolErrors: 3,
  failureStreak: new Map<string, number>(),
  tradingRun: true,
  now: () => 0,
  ...over,
});

const refusalText = (content: string): string => {
  const parsed = JSON.parse(content) as { error?: string };
  return parsed.error ?? "";
};

describe("trading run budget", () => {
  beforeEach(() => resetGuard());

  it("refuses a second scrape_url without executing it", async () => {
    const executed: unknown[] = [];
    const scrape = makeTool(SCRAPE, async (args) => {
      executed.push(args);
      return { text: "page" };
    });
    const options = runOptions([scrape]);

    const first = await runToolBatch([makeCall(SCRAPE, { url: "https://a.example" })], options);
    expect(first[0]).toMatchObject({ isError: false });

    const second = await runToolBatch([makeCall(SCRAPE, { url: "https://b.example" })], options);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({ url: "https://a.example" });
    expect(second[0]).toMatchObject({ isError: true, errorCode: "TOOL_GUARD_REFUSED" });
    expect(JSON.parse(second[0].content)).toEqual({
      error:
        `${STOP_DO_NOT_RETRY_SCRAPE} scrape_url already used in this run (limit 1). ` +
        "Use lazy_web_search snippets or pre-collected data, or record a DataGap.",
      is_error: true,
      guard: "scrape_url_limit",
    });
  });

  it("closes the tool budget after one TOOL_TIMEOUT and refuses every other tool", async () => {
    const slow = makeTool("slow_tool", () => new Promise<unknown>(() => {}));
    let okRuns = 0;
    const ok = makeTool("ok_tool", async () => {
      okRuns += 1;
      return "fine";
    });
    const options = runOptions([slow, ok], {
      defaultToolTimeoutMs: 5,
      timeoutSignalFor: () => AbortSignal.timeout(5),
    });

    const timedOut = await runToolBatch([makeCall("slow_tool")], options);
    expect(timedOut[0]).toMatchObject({ isError: true, errorCode: "TOOL_TIMEOUT" });

    const refused = await runToolBatch([makeCall("ok_tool")], options);
    expect(okRuns).toBe(0);
    expect(refused[0]).toMatchObject({ isError: true, errorCode: "TOOL_GUARD_REFUSED" });
    expect(refusalText(refused[0].content)).toBe(
      "Tool budget closed for this run after a tool timeout. " +
        "Record DataGaps and emit your JSON from the pre-collected data.",
    );
  });

  it("closes the tool budget after two failed tool calls", async () => {
    const boom = makeTool("boom_tool", async () => {
      throw new Error("kaboom");
    });
    let okRuns = 0;
    const ok = makeTool("ok_tool", async () => {
      okRuns += 1;
      return "fine";
    });
    const options = runOptions([boom, ok]);

    const first = await runToolBatch([makeCall("boom_tool")], options);
    expect(first[0]).toMatchObject({ isError: true, errorCode: "TOOL_THREW" });
    const second = await runToolBatch([makeCall("boom_tool")], options);
    expect(second[0]).toMatchObject({ isError: true, errorCode: "TOOL_THREW" });

    const refused = await runToolBatch([makeCall("ok_tool")], options);
    expect(okRuns).toBe(0);
    expect(refused[0].errorCode).toBe("TOOL_GUARD_REFUSED");
    expect(refusalText(refused[0].content)).toContain(
      "Tool budget closed for this run after 2 failed tool calls.",
    );
  });

  it("counts resolved {error, is_error} payloads as failures (trading tools never reject)", async () => {
    const soft = makeTool("soft_fail", async () => ({ error: "HTTP 404", is_error: true }));
    let okRuns = 0;
    const ok = makeTool("ok_tool", async () => {
      okRuns += 1;
      return "fine";
    });
    const options = runOptions([soft, ok]);

    await runToolBatch([makeCall("soft_fail")], options);
    const afterOne = await runToolBatch([makeCall("ok_tool")], options);
    expect(afterOne[0].errorCode).toBeUndefined();
    expect(okRuns).toBe(1);
    await runToolBatch([makeCall("soft_fail")], options);

    const refused = await runToolBatch([makeCall("ok_tool")], options);
    expect(okRuns).toBe(1);
    expect(refused[0].errorCode).toBe("TOOL_GUARD_REFUSED");
    expect(refusalText(refused[0].content)).toContain(
      "Tool budget closed for this run after 2 failed tool calls.",
    );
  });

  it("closes the budget on a resolved bridge-timeout payload", async () => {
    const bridge = makeTool("bridge_tool", async () => ({
      error: "Failed to reach trading-service: bridge timeout after 30000ms",
      is_error: true,
    }));
    const ok = makeTool("ok_tool", async () => "fine");
    const options = runOptions([bridge, ok]);

    await runToolBatch([makeCall("bridge_tool")], options);
    const refused = await runToolBatch([makeCall("ok_tool")], options);
    expect(refused[0].errorCode).toBe("TOOL_GUARD_REFUSED");
    expect(refusalText(refused[0].content)).toContain("after a tool timeout");
  });

  it("still allows whiteboard_write and whiteboard_annotate after the budget closes", async () => {
    const slow = makeTool("slow_tool", () => new Promise<unknown>(() => {}));
    const write = makeTool("mcp__lazy-agent-service__whiteboard_write", async () => ({ ok: true }));
    const annotate = makeTool("whiteboard_annotate", async () => ({ ok: true }));
    const options = runOptions([slow, write, annotate], {
      defaultToolTimeoutMs: 5,
      timeoutSignalFor: () => AbortSignal.timeout(5),
    });

    await runToolBatch([makeCall("slow_tool")], options);
    const results = await runToolBatch(
      [makeCall(write.name, { content: "x" }), makeCall("whiteboard_annotate", { content: "y" })],
      options,
    );
    expect(results.map((r) => r.errorCode)).toEqual([undefined, undefined]);
    expect(results.every((r) => r.isError === false)).toBe(true);
  });

  it("does not count its own refusals as failed calls", async () => {
    const scrape = makeTool(SCRAPE, async () => ({ text: "page" }));
    const boom = makeTool("boom_tool", async () => {
      throw new Error("kaboom");
    });
    const ok = makeTool("ok_tool", async () => "fine");
    const options = runOptions([scrape, boom, ok]);

    await runToolBatch([makeCall(SCRAPE, { url: "https://a.example" })], options);
    const refusedScrape = await runToolBatch([makeCall(SCRAPE, { url: "https://b.example" })], options);
    expect(refusedScrape[0].errorCode).toBe("TOOL_GUARD_REFUSED");

    await runToolBatch([makeCall("boom_tool")], options); // failure 1 of 2
    const stillOpen = await runToolBatch([makeCall("ok_tool")], options);
    expect(stillOpen[0]).toMatchObject({ isError: false, content: "fine" });
  });

  it("leaves non-trading runs unaffected", async () => {
    const executed: unknown[] = [];
    const scrape = makeTool(SCRAPE, async (args) => {
      executed.push(args);
      return { text: "page" };
    });
    const slow = makeTool("slow_tool", () => new Promise<unknown>(() => {}));
    const ok = makeTool("ok_tool", async () => "fine");
    const options = runOptions([scrape, slow, ok], {
      tradingRun: false,
      defaultToolTimeoutMs: 5,
      timeoutSignalFor: () => AbortSignal.timeout(5),
    });

    await runToolBatch([makeCall(SCRAPE, { url: "https://a.example" })], options);
    await runToolBatch([makeCall(SCRAPE, { url: "https://b.example" })], options);
    expect(executed).toHaveLength(2);

    const timedOut = await runToolBatch([makeCall("slow_tool")], options);
    expect(timedOut[0].errorCode).toBe("TOOL_TIMEOUT");
    const afterTimeout = await runToolBatch([makeCall("ok_tool")], options);
    expect(afterTimeout[0]).toMatchObject({ isError: false, content: "fine" });
  });
});
