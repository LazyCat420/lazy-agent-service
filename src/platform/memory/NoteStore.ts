import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────
//  NoteStore — persistent agent note-taking (Anthropic pattern)
//
//  Pure filesystem, no DB: notes append to per-run markdown files
//  under `<repoRoot>/data/notes/<runId>.md` (dir configurable).
// ─────────────────────────────────────────────────────────────

/** Thrown when a runId would escape the notes directory. */
export class InvalidRunIdError extends Error {}

/** Validate a runId as a single safe path segment (no separators, no `..`). */
function assertSafeRunId(runId: string): string {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId.length > 128 ||
    runId !== runId.trim() ||
    path.isAbsolute(runId) ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("\0") ||
    runId.startsWith(".") ||
    runId.split("..").length > 1
  ) {
    throw new InvalidRunIdError(
      `Refused note runId ${JSON.stringify(runId)}: must be a single safe path segment (no separators, no '..').`,
    );
  }
  return runId;
}

export interface NoteStoreOptions {
  /** Notes directory override (default: `<repoRoot>/data/notes`). */
  notesDir?: string;
  /** Workspace root used to derive the default notes directory (default: cwd). */
  repoRoot?: string;
}

export interface WriteNoteResult {
  /** Absolute path of the run's notes file. */
  path: string;
  /** Byte offset the note was appended at. */
  bytes: number;
  /** Human-readable confirmation returned by the take_note tool. */
  confirmation: string;
}

export class NoteStore {
  private readonly notesDir: string;

  constructor(options: NoteStoreOptions = {}) {
    this.notesDir =
      options.notesDir ?? path.join(options.repoRoot ?? process.cwd(), "data", "notes");
  }

  /** Absolute path of a run's notes file (validates the runId first). */
  notePath(runId: string): string {
    return path.join(this.notesDir, `${assertSafeRunId(runId)}.md`);
  }

  /**
   * Append a titled note to the run's notes file, creating the
   * directory and file on demand. Returns a confirmation for the
   * take_note tool result.
   */
  async writeNote(runId: string, title: string, body: string): Promise<WriteNoteResult> {
    const safeRunId = assertSafeRunId(runId);
    const safeTitle = String(title ?? "").replace(/\s+/g, " ").trim() || "untitled";
    const safeBody = String(body ?? "").replace(/\r\n/g, "\n");
    const notePath = path.join(this.notesDir, `${safeRunId}.md`);

    await fsp.mkdir(this.notesDir, { recursive: true });

    const header = fs.existsSync(notePath)
      ? ""
      : `# Notes for run ${safeRunId}\n`;
    const entry =
      `${header}\n## ${safeTitle} — ${new Date().toISOString()}\n\n${safeBody.trimEnd()}\n\n`;
    await fsp.appendFile(notePath, entry, "utf8");
    const { size } = await fsp.stat(notePath);

    return {
      path: notePath,
      bytes: size,
      confirmation: `Note "${safeTitle}" saved to ${notePath}`,
    };
  }

  /** Concatenated notes for a run (empty string when none exist). */
  async readNotes(runId: string): Promise<string> {
    assertSafeRunId(runId);
    try {
      return await fsp.readFile(path.join(this.notesDir, `${runId}.md`), "utf8");
    } catch {
      return "";
    }
  }
}

/** Schema for the built-in `take_note` internal tool. */
export const TAKE_NOTE_TOOL_SCHEMA = {
  name: "take_note",
  description:
    "Persist a titled note for this run to the per-run notes store. Use for durable observations, decisions, and state that must survive compaction.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short note title.",
      },
      body: {
        type: "string",
        description: "Note body (markdown).",
      },
    },
    required: ["title", "body"],
  },
} as const;

/** Execute the take_note internal tool against a NoteStore. */
export async function executeTakeNote(
  args: Record<string, unknown>,
  runId: string,
  store: NoteStore = new NoteStore(),
): Promise<Record<string, unknown>> {
  const title = typeof args.title === "string" ? args.title : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!title.trim() || !body.trim()) {
    return {
      success: false,
      error: "invalid_arguments",
      message: "take_note requires non-empty `title` and `body` strings.",
    };
  }
  try {
    const written = await store.writeNote(runId, title, body);
    return {
      success: true,
      path: written.path,
      confirmation: written.confirmation,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof InvalidRunIdError ? "invalid_run_id" : "write_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
