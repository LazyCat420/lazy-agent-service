import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateTool, type AgenticLoopRunner } from "../DelegateTool.ts";
import { SubagentRegistry } from "../SubagentRegistry.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delegate-"));
}

/** Minimal loop-result for the mock runner: one assistant reply. */
function loopResult(text: string) {
  return {
    messages: [
      { role: "user", content: "task" },
      { role: "assistant", content: text },
    ],
  };
}

describe("DelegateTool", () => {
  let dir: string;
  const runners: AgenticLoopRunner[] = [];

  function useRunner(returnValue: unknown): AgenticLoopRunner {
    const runner = (async () => returnValue) as unknown as AgenticLoopRunner;
    runners.push(runner);
    return runner;
  }

  beforeEach(() => {
    dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "explore.md"),
      [
        "---",
        "name: explore",
        "description: Read-only researcher.",
        "tools: read, grep, glob",
        "---",
        "",
        "Be concise.",
      ].join("\n"),
    );
    SubagentRegistry.reload(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the subagent's final message text and passes its allowlist", async () => {
    let captured: Record<string, unknown> | undefined;
    const runner = (async (context: Record<string, unknown>) => {
      captured = context;
      return loopResult("found it in src/foo.ts:42");
    }) as unknown as AgenticLoopRunner;

    const result = await DelegateTool.execute({ agent: "explore", task: "where is foo?" }, { runner });

    expect(result).toBe("found it in src/foo.ts:42");
    const options = (captured?.options ?? {}) as Record<string, unknown>;
    expect(options.isSubAgent).toBe(true);
    expect(options.enabledTools).toEqual(["read", "grep", "glob"]);
    expect(captured?.agent).toBe("explore");
    // system prompt + user task are seeded as the subagent's messages
    const messages = captured?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(messages[1]).toEqual({ role: "user", content: "where is foo?" });
  });

  it("returns a structured error with available agents for an unknown agent", async () => {
    const result = await DelegateTool.execute(
      { agent: "ghost", task: "x" },
      { runner: useRunner(loopResult("should not run")) },
    );
    expect(result).toMatchObject({ error: true });
    expect((result as { message: string }).message).toContain("ghost");
    expect((result as { availableAgents: string[] }).availableAgents).toContain("explore");
  });

  it("refuses nested delegation", async () => {
    const result = await DelegateTool.execute(
      { agent: "explore", task: "x" },
      { runner: useRunner(loopResult("should not run")), recursionDepth: 1 },
    );
    expect(result).toMatchObject({
      error: true,
      message: "nested delegation is not allowed",
    });
  });

  it("rejects missing arguments", async () => {
    const noAgent = await DelegateTool.execute({ task: "x" }, { runner: useRunner(undefined) });
    expect(noAgent).toMatchObject({ error: true });
    const noTask = await DelegateTool.execute({ agent: "explore" }, { runner: useRunner(undefined) });
    expect(noTask).toMatchObject({ error: true });
  });

  it("surfaces loop failures as structured errors instead of throwing", async () => {
    const failing = (async () => {
      throw new Error("provider down");
    }) as unknown as AgenticLoopRunner;
    const result = await DelegateTool.execute({ agent: "explore", task: "x" }, { runner: failing });
    expect(result).toMatchObject({ error: true });
    expect((result as { message: string }).message).toContain("provider down");
  });
});
