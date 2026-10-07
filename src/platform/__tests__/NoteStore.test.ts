import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NoteStore,
  InvalidRunIdError,
  executeTakeNote,
  TAKE_NOTE_TOOL_SCHEMA,
} from "../memory/NoteStore.ts";
import { executeToolBatch } from "../../services/harnesses/lifecycle/ToolExecutor.ts";
import AgentHooks from "../../services/AgentHooks.ts";
import ToolContext from "../../services/ToolContext.ts";
import type { AgenticContext, ResolvedTools } from "../../services/harnesses/types.ts";

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notestore-"));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("NoteStore", () => {
  it("round-trips notes through the per-run file", async () => {
    const store = new NoteStore({ repoRoot });
    await store.writeNote("run-1", "Decision", "Use SQLite for the queue.");
    await store.writeNote("run-1", "Observation", "Tests are green.\nSecond line.");

    const notes = await store.readNotes("run-1");
    expect(notes).toContain("# Notes for run run-1");
    expect(notes).toContain("## Decision — ");
    expect(notes).toContain("Use SQLite for the queue.");
    expect(notes).toContain("## Observation — ");
    expect(notes).toContain("Second line.");
    expect(fs.existsSync(path.join(repoRoot, "data", "notes", "run-1.md"))).toBe(true);
  });

  it("readNotes returns empty string for unknown runs", async () => {
    const store = new NoteStore({ repoRoot });
    expect(await store.readNotes("missing")).toBe("");
  });

  it("refuses runIds that would escape the notes directory", async () => {
    const store = new NoteStore({ repoRoot });
    for (const bad of ["../escape", "a/b", "a\\b", "..", "/abs", ".hidden\t", "."]) {
      await expect(store.writeNote(bad, "t", "b")).rejects.toBeInstanceOf(InvalidRunIdError);
      await expect(store.readNotes(bad)).rejects.toBeInstanceOf(InvalidRunIdError);
    }
    // Nothing was written outside the notes dir.
    expect(fs.existsSync(path.join(repoRoot, "data"))).toBe(false);
  });

  it("honors a configured notes directory", async () => {
    const custom = path.join(repoRoot, "custom-notes");
    const store = new NoteStore({ notesDir: custom });
    await store.writeNote("run-9", "T", "B");
    expect(fs.existsSync(path.join(custom, "run-9.md"))).toBe(true);
  });
});

describe("take_note tool", () => {
  it("schema requires title and body", () => {
    expect(TAKE_NOTE_TOOL_SCHEMA.name).toBe("take_note");
    expect(TAKE_NOTE_TOOL_SCHEMA.parameters.required).toEqual(["title", "body"]);
  });

  it("is intercepted in the harness ToolExecutor path and returns a confirmation", async () => {
    // Minimal AgenticContext for the internal-tool path (test seam).
    const context = {
      agentConversationId: "conv-test",
      project: "test",
      workspaceRoot: repoRoot,
      runId: "run-exec",
    } as unknown as AgenticContext;
    ToolContext.getStore("conv-test");

    const results = await executeToolBatch(
      [
        {
          id: "tn1",
          name: "take_note",
          args: { title: "From harness", body: "wired through ToolExecutor" },
        },
      ],
      context,
      { finalTools: [TAKE_NOTE_TOOL_SCHEMA], resolvedEnabledTools: ["take_note"] } as ResolvedTools,
      new AgentHooks(),
    );

    expect(results[0].name).toBe("take_note");
    const result = results[0].result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(String(result.confirmation)).toContain("run-exec.md");

    const notes = await new NoteStore({ repoRoot }).readNotes("run-exec");
    expect(notes).toContain("wired through ToolExecutor");
    ToolContext.cleanupInMemory("conv-test");
  });

  it("returns a success confirmation pointing at the notes file", async () => {
    const store = new NoteStore({ repoRoot });
    const result = await executeTakeNote(
      { title: "Plan", body: "Step 1: reproduce" },
      "run-42",
      store,
    );
    expect(result.success).toBe(true);
    expect(result.confirmation).toContain('Note "Plan" saved to');
    expect(result.confirmation).toContain("run-42.md");
    const persisted = await store.readNotes("run-42");
    expect(persisted).toContain("Step 1: reproduce");
  });

  it("rejects missing arguments and escaping run ids", async () => {
    const store = new NoteStore({ repoRoot });
    const missing = await executeTakeNote({ title: "", body: "" }, "run-1", store);
    expect(missing.success).toBe(false);
    expect(missing.error).toBe("invalid_arguments");

    const escaping = await executeTakeNote({ title: "t", body: "b" }, "../evil", store);
    expect(escaping.success).toBe(false);
    expect(escaping.error).toBe("invalid_run_id");
    expect(fs.existsSync(path.join(repoRoot, "evil.md"))).toBe(false);
  });
});
