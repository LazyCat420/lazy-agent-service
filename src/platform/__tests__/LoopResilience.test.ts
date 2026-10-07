import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactToolResultsForPressure, isContextWindowError } from "../../services/AgenticLoopService.ts";
import { ContextAssembly, type AssemblyOptions } from "../context/ContextAssembly.ts";
import type { ConversationMessage } from "../../services/harnesses/types.ts";

let repoRoot: string;

function bigToolTurn(name: string, filler: string): ConversationMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: `call_${name}`, name, args: {}, result: { success: true, message: filler } },
    ],
  };
}

function baseOptions(overrides: Partial<AssemblyOptions> = {}): AssemblyOptions {
  return {
    agentRole: "tester",
    project: "test",
    roleRules: "role",
    outputContract: "contract",
    toolProtocol: "protocol",
    selectedToolSchemas: [{ name: "shell", description: "run", parameters: {} }],
    userTask: "do the thing",
    ...overrides,
  };
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loopresilience-"));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("compactToolResultsForPressure", () => {
  const small = "x".repeat(50);
  const large = "y".repeat(2000);

  it("leaves small histories untouched", () => {
    const messages: ConversationMessage[] = [
      bigToolTurn("a", small),
      bigToolTurn("b", small),
      bigToolTurn("c", small),
      bigToolTurn("d", small),
      bigToolTurn("e", small),
    ];
    expect(compactToolResultsForPressure(messages)).toBe(messages);
  });

  it("compacts tool results older than the last 3 turns under pressure", () => {
    const messages: ConversationMessage[] = [
      bigToolTurn("turn1", large),
      bigToolTurn("turn2", large),
      bigToolTurn("turn3", large),
      bigToolTurn("turn4", large),
      bigToolTurn("turn5", large),
      { role: "user", content: "continue" },
    ];
    const compacted = compactToolResultsForPressure(messages, {
      totalMaxChars: 5000,
      pressureRatio: 0.6,
    });
    // Last 3 tool turns stay full.
    expect(compacted[4]).toBe(messages[4]);
    expect(compacted[3]).toBe(messages[3]);
    expect(compacted[2]).toBe(messages[2]);
    // Older turns are summarized.
    const compactedCall = (compacted[0].toolCalls as Array<{ result: Record<string, unknown> }>)[0]
      .result;
    expect(compactedCall.compacted).toBe(true);
    expect(String(compactedCall.message)).toContain("[compacted] turn1 result summary:");
    expect(String(compactedCall.message).length).toBeLessThanOrEqual(
      "[compacted] turn1 result summary: ".length + 120,
    );
    // Non-tool messages are untouched.
    expect(compacted[5]).toBe(messages[5]);
  });

  it("force compacts regardless of pressure", () => {
    const messages: ConversationMessage[] = [
      bigToolTurn("a", large),
      bigToolTurn("b", large),
      bigToolTurn("c", large),
      bigToolTurn("d", large),
    ];
    const compacted = compactToolResultsForPressure(messages, { force: true, keepLastNTurns: 1 });
    expect((compacted[0].toolCalls as Array<{ result: Record<string, unknown> }>)[0].result.compacted).toBe(true);
    expect(compacted[3]).toBe(messages[3]);
  });

  it("does not mutate the input array", () => {
    const messages: ConversationMessage[] = [
      bigToolTurn("a", large),
      bigToolTurn("b", large),
      bigToolTurn("c", large),
      bigToolTurn("d", large),
    ];
    const snapshot = JSON.stringify(messages);
    compactToolResultsForPressure(messages, { force: true });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe("isContextWindowError", () => {
  it("recognizes common overflow signatures", () => {
    expect(isContextWindowError(new Error("prompt is too long: 200000 tokens > 128000"))).toBe(true);
    expect(isContextWindowError({ code: "context_length_exceeded" })).toBe(true);
    expect(isContextWindowError(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextWindowError(new Error("HTTP 413 Request Entity Too Large"))).toBe(true);
  });

  it("rejects unrelated failures", () => {
    expect(isContextWindowError(new Error("ECONNRESET"))).toBe(false);
    expect(isContextWindowError(new Error("401 Unauthorized"))).toBe(false);
    expect(isContextWindowError(null)).toBe(false);
  });
});

describe("ContextAssembly memory/skills/rules integration", () => {
  it("auto-loads memory before skills in the projectScope layer", () => {
    fs.mkdirSync(path.join(repoRoot, "memory"));
    fs.writeFileSync(
      path.join(repoRoot, "memory", "conventions.md"),
      "ALWAYS_ON_MEMORY_MARKER",
      "utf8",
    );
    fs.writeFileSync(path.join(repoRoot, "memory", "README.md"), "meta notice", "utf8");
    fs.mkdirSync(path.join(repoRoot, "skills", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill for tests\n---\nDemo body.",
      "utf8",
    );

    const result = new ContextAssembly().assemble(baseOptions({ repoRoot }));
    expect(result.layerTexts.projectScope).toContain("ALWAYS_ON_MEMORY_MARKER");
    expect(result.layerTexts.projectScope).not.toContain("meta notice");
    expect(result.layerTexts.projectScope).toContain("demo");
    expect(result.layerTexts.projectScope).toContain("Demo skill for tests");
    const memoryIdx = result.layerTexts.projectScope.indexOf("ALWAYS_ON_MEMORY_MARKER");
    const skillsIdx = result.layerTexts.projectScope.indexOf("# Available Skills");
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeLessThan(skillsIdx);
  });

  it("appends pathScopedRules to the dynamic tail", () => {
    const result = new ContextAssembly().assemble(
      baseOptions({ pathScopedRules: ["Never edit generated files."] }),
    );
    expect(result.layerTexts.dynamicTail).toContain("# Path-Scoped Rules");
    expect(result.layerTexts.dynamicTail).toContain("Never edit generated files.");
    expect(result.layerTexts.projectScope).not.toContain("Path-Scoped Rules");
  });
});
