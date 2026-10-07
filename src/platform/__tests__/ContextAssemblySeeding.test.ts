import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextAssembly, seedFromReplayManifest, type AssemblyOptions } from "../context/ContextAssembly.ts";
import type { ReplayManifest } from "../contracts/manifest.ts";

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

describe("memory @import approval", () => {
  it("includes in-root imports inline", () => {
    fs.mkdirSync(path.join(repoRoot, "memory"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "rules"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "rules", "extra.md"), "in-root rule body");
    fs.writeFileSync(
      path.join(repoRoot, "memory", "main.md"),
      "top section\n@../rules/extra.md\nbottom section",
    );

    const result = new ContextAssembly().assemble(baseOptions());
    expect(result.fullPrompt).toContain("in-root rule body");
    expect(result.fullPrompt).toContain("top section");
    expect(result.unapprovedImports).toEqual([]);
  });

  it("excludes and reports imports escaping the workspace root", () => {
    fs.mkdirSync(path.join(repoRoot, "memory"), { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      const outsideFile = path.join(outsideDir, "secret.md");
      fs.writeFileSync(outsideFile, "TOP SECRET ESCAPED CONTENT");
      // Relative path that climbs out of the repo root.
      const relative = path.relative(path.join(repoRoot, "memory"), outsideFile);
      fs.writeFileSync(
        path.join(repoRoot, "memory", "escape.md"),
        `safe line\n@${relative}\nanother safe line`,
      );

      const seen: Array<{ file: string; importPath: string }> = [];
      const result = new ContextAssembly().assemble(
        baseOptions({ onUnapprovedImport: (u) => seen.push(u) }),
      );

      expect(result.fullPrompt).not.toContain("TOP SECRET ESCAPED CONTENT");
      expect(result.fullPrompt).toContain("safe line");
      expect(result.unapprovedImports).toEqual([
        { file: "escape.md", importPath: relative },
      ]);
      expect(seen).toEqual([{ file: "escape.md", importPath: relative }]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("never follows absolute import paths", () => {
    fs.mkdirSync(path.join(repoRoot, "memory"), { recursive: true });
    const outsideFile = path.join(repoRoot, "..", "sibling-secret.md");
    fs.writeFileSync(outsideFile, "ABSOLUTE SECRET");
    try {
      fs.writeFileSync(
        path.join(repoRoot, "memory", "abs.md"),
        `@${outsideFile}`,
      );
      const result = new ContextAssembly().assemble(baseOptions());
      expect(result.fullPrompt).not.toContain("ABSOLUTE SECRET");
      expect(result.unapprovedImports).toHaveLength(1);
      expect(result.unapprovedImports[0].importPath).toBe(outsideFile);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("honors configured allowedRoots beyond the repo root", () => {
    const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "allowed-"));
    try {
      fs.mkdirSync(path.join(repoRoot, "memory"), { recursive: true });
      fs.writeFileSync(path.join(extraRoot, "ok.md"), "allowed-root content");
      fs.writeFileSync(
        path.join(repoRoot, "memory", "main.md"),
        `@${path.join(extraRoot, "ok.md")}`,
      );
      const result = new ContextAssembly().assemble(
        baseOptions({ allowedRoots: [extraRoot] }),
      );
      // Absolute paths are never followed, even when inside an allowed root.
      expect(result.fullPrompt).not.toContain("allowed-root content");
      expect(result.unapprovedImports).toHaveLength(1);

      // A relative path resolving into the allowed root is followed.
      fs.writeFileSync(
        path.join(repoRoot, "memory", "main.md"),
        `@${path.relative(path.join(repoRoot, "memory"), path.join(extraRoot, "ok.md"))}`,
      );
      const relativeResult = new ContextAssembly().assemble(
        baseOptions({ allowedRoots: [extraRoot] }),
      );
      expect(relativeResult.fullPrompt).toContain("allowed-root content");
      expect(relativeResult.unapprovedImports).toEqual([]);
    } finally {
      fs.rmSync(extraRoot, { recursive: true, force: true });
    }
  });
});

describe("seededToolResults", () => {
  it("renders seeded pairs with provenance comments before dynamicTail", () => {
    const result = new ContextAssembly().assemble(
      baseOptions({
        seededToolResults: [
          { toolName: "bash", content: "vitest: 12 passed" },
          { toolName: "read_file", content: "export const x = 1;" },
        ],
      }),
    );

    const evidence = result.layerTexts.retrievedEvidence;
    expect(evidence).toContain("<!-- seeded: replayed prior run -->");
    expect(evidence).toContain("[assistant tool_call] bash");
    expect(evidence).toContain("[tool result]\nvitest: 12 passed");
    expect(evidence).toContain("[assistant tool_call] read_file");

    // Seeded history appears in the evidence layer, i.e. before the tail.
    const tail = result.layerTexts.dynamicTail;
    expect(tail).not.toContain("seeded: replayed prior run");
    const evidenceIdx = result.fullPrompt.indexOf("seeded: replayed prior run");
    const tailIdx = result.fullPrompt.indexOf("# Task Instruction");
    expect(evidenceIdx).toBeGreaterThan(-1);
    expect(tailIdx).toBeGreaterThan(evidenceIdx);
  });

  it("omits the seeded section when empty", () => {
    const result = new ContextAssembly().assemble(baseOptions());
    expect(result.layerTexts.retrievedEvidence).not.toContain("seeded");
  });
});

describe("seedFromReplayManifest", () => {
  function makeManifest(): ReplayManifest {
    return {
      manifest_version: "1",
      run_id: "r1",
      trace_id: "t1",
      harness_version: "hv",
      model: "m",
      agent_role: "tester",
      environment: "test",
      context_receipt: {} as ReplayManifest["context_receipt"],
      ordered_tool_events: [
        {
          turn: 2,
          call_id: "c2",
          tool_name: "read_file",
          arguments: {},
          arguments_hash: "ah2",
          result_hash: "rh2",
          status: "success",
          duration_ms: 1,
          side_effect: "READ_ONLY",
        },
        {
          turn: 1,
          call_id: "c1",
          tool_name: "bash",
          arguments: {},
          arguments_hash: "ah1",
          result_hash: "rh1",
          status: "success",
          duration_ms: 2,
          side_effect: "MUTATING",
        },
        {
          turn: 3,
          call_id: "c3",
          tool_name: "bash",
          arguments: {},
          arguments_hash: "ah3",
          result_hash: "rh-missing",
          status: "error",
          duration_ms: 3,
          side_effect: "READ_ONLY",
        },
      ],
      cached_tool_results: [
        {
          tool_name: "bash",
          arguments_hash: "ah1",
          result_hash: "rh1",
          is_error: false,
          result_payload: "vitest: 5 passed",
        },
        {
          tool_name: "read_file",
          arguments_hash: "ah2",
          result_hash: "rh2",
          is_error: false,
          result_payload: { lines: 42 },
        },
      ],
      state_snapshots: [],
      artifact_references: [],
      stop_reason: "end_turn",
      verifier_outcomes: [],
    };
  }

  it("maps ordered_tool_events to seeded shape, ordered by turn", () => {
    const seeded = seedFromReplayManifest(makeManifest());
    expect(seeded.map((s) => s.toolName)).toEqual(["bash", "read_file", "bash"]);
    expect(seeded[0].content).toBe("vitest: 5 passed");
    expect(JSON.parse(seeded[1].content)).toEqual({ lines: 42 });
    // No cached payload → provenance kept, error status surfaced.
    expect(seeded[2].content).toContain("[error]");
    expect(seeded[2].content).toContain("rh-missing");
  });

  it("surfaces is_error from cached results", () => {
    const manifest = makeManifest();
    manifest.cached_tool_results[0].is_error = true;
    const seeded = seedFromReplayManifest(manifest);
    expect(seeded[0].content).toBe("[error] vitest: 5 passed");
  });
});
