import { createHash } from "node:crypto";
import { classifyToolResult } from "./ToolResult.ts";
import { extractFilePath, WRITE_REJECTION_PREFIX } from "./WriteSyntaxGuard.ts";

/**
 * SessionState — ambient per-run session state, the SWE-agent "state_command"
 * pattern: a compact JSON snapshot of what the agent has been touching,
 * injected into the model context each turn so it can act on durable facts
 * (which files are open, what ran last, what failed last) without re-reading
 * them.
 *
 * Pure module: `applyObservation` returns a new state; nothing here touches
 * the filesystem or the network. Serialization is deterministic — fixed key
 * order, no whitespace — so the hash in receipts/spans is stable.
 *
 * Injection: RunExecutionEngine owns a per-run state (context.sessionState),
 * updates it in the runtime tool executor from every observation, and
 * BaseAgenticHarness.createProviderStream appends the serialized block as an
 * ephemeral trailing context message around each model call (never persisted,
 * so the persisted prefix stays append-only for KV-cache reuse).
 */

export interface SessionState {
  /** Most-recently-touched files first (MRU order). */
  openFiles: string[];
  lastTool: string;
  lastError: string | null;
  toolCallCount: number;
  startedAt: string;
}

const MAX_OPEN_FILES = 20;
const MAX_ERROR_LENGTH = 300;

export function createSessionState(
  startedAt: string = new Date().toISOString(),
): SessionState {
  return {
    openFiles: [],
    lastTool: "",
    lastError: null,
    toolCallCount: 0,
    startedAt,
  };
}

/**
 * Fold one tool observation into the state. The path is taken from the
 * observation's path-ish fields (write/read results echo the target path);
 * errors come from the shared tool-result classification. MRU-capped so the
 * serialized block stays bounded.
 */
export function applyObservation(
  state: SessionState,
  toolName: string,
  observation: unknown,
): SessionState {
  const openFiles = state.openFiles.slice();
  const observedPath =
    typeof observation === "object" && observation !== null
      ? extractFilePath(observation as Record<string, unknown>)
      : null;
  if (observedPath) {
    const existing = openFiles.indexOf(observedPath);
    if (existing >= 0) openFiles.splice(existing, 1);
    openFiles.push(observedPath);
    while (openFiles.length > MAX_OPEN_FILES) openFiles.shift();
  }
  const verdict = classifyToolResult(observation);
  const lastError =
    typeof observation === "string" && observation.startsWith(WRITE_REJECTION_PREFIX)
      ? observation.slice(0, MAX_ERROR_LENGTH) // a reverted write is an error the model must see in state
      : verdict.success
        ? null
        : (verdict.errorMessage ?? "tool_returned_error").slice(0, MAX_ERROR_LENGTH);
  return {
    openFiles,
    lastTool: toolName,
    lastError,
    toolCallCount: state.toolCallCount + 1,
    startedAt: state.startedAt,
  };
}

/** Compact, deterministic serialization: fixed key order, no whitespace. */
export function serializeSessionState(state: SessionState): string {
  return JSON.stringify({
    openFiles: state.openFiles.slice(),
    lastTool: state.lastTool,
    lastError: state.lastError,
    toolCallCount: state.toolCallCount,
    startedAt: state.startedAt,
  });
}

/** Short stable hash of the serialized state (receipts / span attributes). */
export function sessionStateHash(state: SessionState): string {
  return createHash("sha256")
    .update(serializeSessionState(state))
    .digest("hex")
    .slice(0, 16);
}

/** The exact per-turn context block injected before each model call. */
export function sessionStateContextBlock(state: SessionState): string {
  return `<session_state>\n${serializeSessionState(state)}\n</session_state>`;
}
