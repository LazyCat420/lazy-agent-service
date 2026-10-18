import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextAssembly, type AssemblyOptions } from "../context/ContextAssembly.ts";

let repoRoot: string;

function baseOptions(overrides: Partial<AssemblyOptions> = {}): AssemblyOptions {
  return {
    agentRole: "tester",
    project: "test",
    roleRules: "role",
    outputContract: "contract",
    toolProtocol: "protocol",
    selectedToolSchemas: [{ name: "shell", description: "run", parameters: {} }],
    userTask: "do the thing",
    repoRoot,
    ...overrides,
  };
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctxassembly-"));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("cite sources prompt", () => {
  it("asks for named sources when a web tool is callable", () => {
    const result = new ContextAssembly().assemble(
      baseOptions({
        selectedToolSchemas: [
          { name: "global.web.search", description: "s", parameters: {} },
        ],
      }),
    );
    expect(result.layerTexts.projectScope).toContain("# Sources");
    expect(result.layerTexts.projectScope).toContain("name where each fact came from");
  });

  it("does not ask for sources when no web tool is callable", () => {
    const result = new ContextAssembly().assemble(
      baseOptions({
        selectedToolSchemas: [{ name: "shell", description: "run", parameters: {} }],
      }),
    );
    expect(result.layerTexts.projectScope).not.toContain("# Sources");
  });
});
