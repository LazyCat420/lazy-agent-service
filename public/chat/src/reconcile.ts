/**
 * Reconnect/reconcile logic for the first-party chat UI.
 *
 * Pure functions over the @lazycat/agent-chat ChatState so they are unit
 * testable without a DOM (vitest, test/chat-ui/reconcile.test.ts).
 */

export type ReconcileRole = "user" | "assistant";

/** Minimal persisted message shape from GET /conversations/:id (`doc.messages`). */
export interface PersistedMessage {
  role: string;
  content: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface ConversationSnapshotDoc {
  messages?: PersistedMessage[];
  [key: string]: unknown;
}

/** Minimal structural slice of ChatState this module touches. */
export interface ReconcilableState {
  transcript: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    status: string;
    [key: string]: unknown;
  }>;
  pendingRun: { runId: string; status: string; startedAt: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  connectionStatus: string;
  [key: string]: unknown;
}

// Stable id for a persisted message: role+content hash plus its timestamp.
function stableHash(json: string): string {
  let hash = 0;
  for (let i = 0; i < json.length; i++) hash = (hash * 31 + json.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function toTranscriptMessages(doc: ConversationSnapshotDoc) {
  return (doc.messages ?? [])
    .filter(
      (m): m is PersistedMessage =>
        !!m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    )
    .map((m) => ({
      id: `persisted_${stableHash(`${m.role}\u0000${m.content}`)}_${m.timestamp ?? ""}`,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp ?? new Date().toISOString(),
      status: "completed",
    }));
}

/**
 * Merge a persisted conversation snapshot into the live state.
 *
 * - Persisted messages become completed transcript entries (server truth).
 * - Optimistic local user messages are kept only if not already persisted
 *   (deduped by role + content).
 * - The streaming assistant message is kept unless the server already
 *   persisted an assistant message with the same content (finalizer ran).
 */
export function mergeConversationSnapshot(state: ReconcilableState, doc: ConversationSnapshotDoc): ReconcilableState {
  const persisted = toTranscriptMessages(doc);

  const localKeep = state.transcript.filter((m) => {
    if (m.role === "user") {
      return !persisted.some((p) => p.role === "user" && p.content === m.content);
    }
    if (m.role === "assistant" && m.status === "streaming") {
      return !persisted.some((p) => p.role === "assistant" && p.content === m.content);
    }
    // Already-completed local assistant messages would duplicate the snapshot.
    return false;
  });

  return { ...state, transcript: [...persisted, ...localKeep] };
}

/**
 * Reconcile after the SSE closed without a terminal event (or on tab re-focus).
 *
 * The server runs persistOnDisconnect: true, so a dropped connection does not
 * abort the turn — the refetched snapshot is authoritative. pendingRun is
 * cleared (the client-side turn is over from the UI's perspective), any
 * STREAM_CLOSED error is cleared, and the connection returns to idle so the
 * queued sends can drain.
 */
export function reconcileAfterStreamClose(state: ReconcilableState, doc: ConversationSnapshotDoc): ReconcilableState {
  const merged = mergeConversationSnapshot(state, doc);
  return {
    ...merged,
    pendingRun: null,
    error: merged.error?.code === "STREAM_CLOSED" ? null : merged.error,
    connectionStatus: "idle",
  };
}

/**
 * Drain the queued user sends: oldest-first items to submit now.
 * Returns [] when the session cannot send (a turn is still in flight).
 */
export function drainSendQueue(queue: string[], canSend: boolean): string[] {
  if (!canSend || queue.length === 0) return [];
  return [...queue];
}
