import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubagentRegistry, MAX_TOTAL_DESCRIPTION_CHARS, parseSubagentMarkdown } from "../SubagentRegistry.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
}

describe("SubagentRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("discovers markdown subagents with frontmatter", () => {
    fs.writeFileSync(
      path.join(dir, "explore.md"),
      [
        "---",
        "name: explore",
        "description: Read-only codebase researcher.",
        "tools: read, grep, glob",
        "model: glm-5",
        "---",
        "",
        "You are a read-only researcher.",
      ].join("\n"),
    );

    SubagentRegistry.reload(dir);

    expect(SubagentRegistry.list()).toEqual([
      { name: "explore", description: "Read-only codebase researcher." },
    ]);

    const definition = SubagentRegistry.get("explore");
    expect(definition?.tools).toEqual(["read", "grep", "glob"]);
    expect(definition?.model).toBe("glm-5");
    expect(definition?.systemPrompt).toContain("read-only researcher");
  });

  it("treats tools: all as unrestricted and defaults name to the filename", () => {
    fs.writeFileSync(
      path.join(dir, "worker.md"),
      ["---", "description: Does everything.", "tools: all", "---", "Body."].join("\n"),
    );

    SubagentRegistry.reload(dir);

    expect(SubagentRegistry.get("worker")?.tools).toBe("all");
    // name omitted → falls back to the .md filename
    expect(SubagentRegistry.get("worker")?.name).toBe("worker");
  });

  it("returns null for unknown agents and reports isEnabled", () => {
    SubagentRegistry.reload(dir);
    expect(SubagentRegistry.get("nope")).toBeNull();
    expect(SubagentRegistry.isEnabled()).toBe(false);

    fs.writeFileSync(
      path.join(dir, "a.md"),
      ["---", "name: a", "description: x", "---", "b"].join("\n"),
    );
    SubagentRegistry.reload(dir);
    expect(SubagentRegistry.isEnabled()).toBe(true);
  });

  it("flags description payload over the 15000-char threshold", () => {
    const bigDescription = "x".repeat(MAX_TOTAL_DESCRIPTION_CHARS + 1);
    fs.writeFileSync(
      path.join(dir, "big.md"),
      ["---", `name: big`, `description: ${bigDescription}`, "---", "b"].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "small.md"),
      ["---", "name: small", "description: tiny", "---", "b"].join("\n"),
    );

    SubagentRegistry.reload(dir);
    expect(SubagentRegistry.totalDescriptionChars()).toBeGreaterThan(MAX_TOTAL_DESCRIPTION_CHARS);
    expect(SubagentRegistry.warnIfDescriptionsTooLarge()).toBe(true);

    // Under the threshold: no warning.
    const smallDir = makeTempDir();
    fs.writeFileSync(
      path.join(smallDir, "small.md"),
      ["---", "name: small", "description: tiny", "---", "b"].join("\n"),
    );
    SubagentRegistry.reload(smallDir);
    fs.rmSync(smallDir, { recursive: true, force: true });
    expect(SubagentRegistry.warnIfDescriptionsTooLarge()).toBe(false);
  });

  it("parses frontmatter and rejects files without it", () => {
    const parsed = parseSubagentMarkdown(
      ["---", "name: n", "description: d", "---", "body"].join("\n"),
      "fallback",
    );
    expect(parsed?.name).toBe("n");
    expect(parsed?.description).toBe("d");
    expect(parseSubagentMarkdown("no frontmatter", "fallback")).toBeNull();
    // description is mandatory — a definition without one is rejected
    expect(parseSubagentMarkdown(["---", "name: n", "---", "body"].join("\n"), "fallback")).toBeNull();
  });
});
