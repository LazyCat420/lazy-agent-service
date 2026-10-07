import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import logger from "../utils/logger.ts";
import { effectClass } from "./PermissionModes.ts";
import { classifyToolResult } from "./ToolResult.ts";

/**
 * WriteSyntaxGuard — SWE-agent-style lint-guarded writes.
 *
 * After a successful write to a locally available .json / JS / TS file, the
 * written content is re-parsed. If it does not parse, the write is REVERTED
 * (the pre-write content, captured before dispatch, is restored) and the model
 * receives a rejection observation instead of a silent success, so it can fix
 * the syntax without a broken file poisoning later steps.
 *
 * LIMITATION (canonical run path): local tools in RunExecutionEngine are
 * admitted and executed by app-owned services (RunExecutionEngine →
 * LocalToolContinuation → the owning app). Their file content is not locally
 * available in this container, so the guard only engages when the write
 * target resolves to a file that actually exists in THIS container's
 * filesystem (e.g. sessions whose paths map here, such as orchestrator
 * worktrees). When the target is not locally readable the guard captures
 * nothing and never reverts — reverting a path we cannot read would be
 * guessing. A previously nonexistent local file is likewise not captured:
 * the guard never deletes files it did not see.
 *
 * `checkSyntax` is pure (no filesystem access) and exported for tests and
 * any other integration point that already holds the file content.
 */

/** Extensions whose writes are syntax-checked (static string-keyed lookup). */
const GUARDED_WRITE_EXTENSIONS: Record<string, true> = {
  ".json": true,
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".mjs": true,
  ".cjs": true,
  ".mts": true,
  ".cts": true,
};

/** Argument/observation keys tools use for the target path (same convention as ValidationInterceptor). */
const PATH_KEYS = ["path", "filePath", "file", "newPath"] as const;

/** Extract the target file path from a tool-args/observation record, if any. */
export function extractFilePath(record: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Syntax-check `content` as `fileName` claims to be. Returns the first error
 * message, or null when the content parses. For .json this is JSON.parse; for
 * the JS/TS family it is the `typescript` package's transpileModule with
 * reportDiagnostics — syntax-level only (transpileModule never type-checks).
 */
export function checkSyntax(fileName: string, content: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (GUARDED_WRITE_EXTENSIONS[ext]) {
    const result = ts.transpileModule(content, {
      fileName,
      reportDiagnostics: true,
    });
    const error = (result.diagnostics ?? []).find(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (!error) return null;
    return typeof error.messageText === "string"
      ? error.messageText
      : ts.flattenDiagnosticMessageText(error.messageText, "\n");
  }
  return null; // unguarded extension — not our concern
}

/** The previous content of a write target, captured before dispatch. */
export interface WriteGuardCapture {
  /** Resolved local path of the write target. */
  filePath: string;
  /** Content the file had before the tool was dispatched. */
  previous: string;
}

/**
 * Capture the pre-write content of a write-classified tool call's target, so
 * a later syntax failure can revert. Returns null (no guard) when the tool is
 * not write-classified, has no guarded path argument, or the path is not a
 * locally readable file — see the module-level limitation note.
 */
export function captureWriteSyntaxGuard(
  args: Record<string, unknown>,
  effect: unknown,
): WriteGuardCapture | null {
  if (effectClass(effect) !== "write") return null;
  const target = extractFilePath(args);
  if (!target) return null;
  if (!GUARDED_WRITE_EXTENSIONS[path.extname(target).toLowerCase()]) return null;
  const resolved = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  try {
    if (!fs.statSync(resolved).isFile()) return null;
    return { filePath: resolved, previous: fs.readFileSync(resolved, "utf8") };
  } catch {
    return null; // not locally available — no revert is possible
  }
}

export const WRITE_REJECTION_PREFIX = "Write rejected: ";

export function writeRejectionObservation(filePath: string, error: string): string {
  return `${WRITE_REJECTION_PREFIX}${filePath} does not parse (${error}). Fix the syntax and retry.`;
}

/**
 * Chokepoint step: given a capture (may be null) and the tool's observation,
 * re-parse the written file. On a syntax error, revert to the captured
 * content and return a rejection observation; otherwise pass the observation
 * through untouched. Failed/error observations are never guarded — the tool
 * reported the write did not happen.
 */
export function enforceWriteSyntaxGuard(
  capture: WriteGuardCapture | null,
  observation: unknown,
): unknown {
  if (!capture) return observation;
  if (!classifyToolResult(observation).success) return observation;
  let content: string;
  try {
    content = fs.readFileSync(capture.filePath, "utf8");
  } catch {
    return observation; // file went away; nothing to validate or revert
  }
  const error = checkSyntax(capture.filePath, content);
  if (!error) return observation;
  try {
    fs.writeFileSync(capture.filePath, capture.previous);
  } catch (revertErr) {
    logger.warn(
      `[WriteSyntaxGuard] Revert of ${capture.filePath} failed: ${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
    );
  }
  return writeRejectionObservation(capture.filePath, error);
}
