import { beforeEach, describe, expect, it } from "vitest";
import { runCoreLoop } from "../CoreLoop.ts";
import { resetGuard } from "../../../services/ToolCallGuard.ts";
import type { CoreLoopOptions } from "../types.ts";
import { okTool, scriptedModel } from "./fakes.ts";

const signal = new AbortController().signal;
const SCRAPE = "mcp__lazy-agent-service__scrape_url";
const WB = "mcp__lazy-agent-service__whiteboard_write";
const ANN = "mcp__lazy-agent-service__whiteboard_annotate";
const READ = "mcp__lazy-agent-service__get_quote";

const drain = async (options: CoreLoopOptions) => {
  const gen = runCoreLoop(options);
  for (;;) if ((await gen.next()).done) return;
};

const base = (model: CoreLoopOptions["model"], tools: CoreLoopOptions["tools"], tradingRun: boolean): CoreLoopOptions => ({
  model, tools, messages: [{ role: "user", content: "go" }], signal, maxSteps: 8, tradingRun,
});
const names = (call: { tools?: Array<{ name: string }> } | undefined) => (call?.tools ?? []).map((t) => t.name);

describe("tools offered to the model", () => {
  beforeEach(() => resetGuard());

  it("trading run drops scrape_url after its one use", async () => {
    const model = scriptedModel([
      [{ type: "toolCall", id: "a", name: SCRAPE, args: { url: "https://x.com" } }],
      ["done"],
    ]);
    await drain(base(model, [okTool(SCRAPE, "page"), okTool(READ, "q"), okTool(WB, "w")], true));
    expect(names(model.calls[0])).toContain(SCRAPE);
    expect(names(model.calls[1])).not.toContain(SCRAPE);
    expect(names(model.calls[1])).toContain(READ);
  });

  it("trading run offers only whiteboard tools after a tool timeout", async () => {
    const timeoutTool = {
      ...okTool(READ, ""),
      execute: async () => ({ error: "TOOL_TIMEOUT after 60s", is_error: true }),
    };
    const model = scriptedModel([
      [{ type: "toolCall", id: "a", name: READ, args: {} }],
      ["done"],
    ]);
    await drain(base(model, [okTool(SCRAPE, "p"), timeoutTool, okTool(WB, "w"), okTool(ANN, "a")], true));
    expect(names(model.calls[1]).sort()).toEqual([ANN, WB].sort());
  });

  it("non-trading run keeps scrape_url", async () => {
    const model = scriptedModel([
      [{ type: "toolCall", id: "a", name: SCRAPE, args: { url: "https://x.com" } }],
      ["done"],
    ]);
    await drain(base(model, [okTool(SCRAPE, "page"), okTool(READ, "q")], false));
    expect(names(model.calls[1])).toContain(SCRAPE);
  });

  it("closed budget with no output tool left goes to the toolless final pass", async () => {
    const timeoutTool = {
      ...okTool(READ, ""),
      execute: async () => ({ error: "TOOL_TIMEOUT after 60s", is_error: true }),
    };
    const model = scriptedModel([
      [{ type: "toolCall", id: "a", name: READ, args: {} }],
      ["final answer"],
    ]);
    const gen = runCoreLoop(base(model, [okTool(SCRAPE, "p"), timeoutTool], true));
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.finalPass).toBe(true);
    expect(model.calls[1]?.toolChoice).toBe("none");
    expect(step.value.text).toContain("final answer");
  });
});
