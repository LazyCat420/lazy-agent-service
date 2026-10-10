import { describe, expect, it } from "vitest";
import { INITIAL_CHAT_STATE } from "../../packages/agent-chat/dist/index.js";
import {
  drainSendQueue,
  mergeConversationSnapshot,
  reconcileAfterStreamClose,
  type ReconcilableState,
} from "../../public/chat/src/reconcile.js";

function baseState(overrides: Partial<ReconcilableState> = {}): ReconcilableState {
  return {
    ...INITIAL_CHAT_STATE,
    transcript: [],
    pendingRun: null,
    error: null,
    connectionStatus: "idle",
    ...overrides,
  } as ReconcilableState;
}

const SNAPSHOT_DOC = {
  id: "conv_1",
  messages: [
    { role: "user", content: "hello", timestamp: "2026-10-10T00:00:00.000Z" },
    { role: "assistant", content: "hi there", timestamp: "2026-10-10T00:00:01.000Z" },
  ],
};

describe("mergeConversationSnapshot", () => {
  it("turns persisted messages into completed transcript entries", () => {
    const merged = mergeConversationSnapshot(baseState(), SNAPSHOT_DOC);
    expect(merged.transcript).toHaveLength(2);
    expect(merged.transcript[0]).toMatchObject({ role: "user", status: "completed", content: "hello" });
    expect(merged.transcript[1]).toMatchObject({ role: "assistant", status: "completed", content: "hi there" });
  });

  it("keeps an optimistic user message not yet persisted", () => {
    const state = baseState({
      transcript: [
        { id: "msg_user_1", role: "user", content: "unsent-persist", timestamp: "t", status: "completed" },
      ],
    });
    const merged = mergeConversationSnapshot(state, SNAPSHOT_DOC);
    expect(merged.transcript.map((m) => m.content)).toEqual([
      "hello",
      "hi there",
      "unsent-persist",
    ]);
  });

  it("does not duplicate a user message already persisted", () => {
    const state = baseState({
      transcript: [{ id: "msg_user_1", role: "user", content: "hello", timestamp: "t", status: "completed" }],
    });
    const merged = mergeConversationSnapshot(state, SNAPSHOT_DOC);
    expect(merged.transcript.filter((m) => m.content === "hello")).toHaveLength(1);
  });

  it("keeps the streaming assistant message when the finalizer has not run", () => {
    const state = baseState({
      transcript: [{ id: "a1", role: "assistant", content: "still stream", timestamp: "t", status: "streaming" }],
      pendingRun: { runId: "run_1", status: "streaming", startedAt: "t" },
    });
    const merged = mergeConversationSnapshot(state, SNAPSHOT_DOC);
    expect(merged.transcript.filter((m) => m.content === "still stream")).toHaveLength(1);
  });

  it("drops the streaming assistant message once identical content is persisted", () => {
    const state = baseState({
      transcript: [{ id: "a1", role: "assistant", content: "hi there", timestamp: "t", status: "streaming" }],
      pendingRun: { runId: "run_1", status: "streaming", startedAt: "t" },
    });
    const merged = mergeConversationSnapshot(state, SNAPSHOT_DOC);
    expect(merged.transcript.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("tolerates a doc without messages", () => {
    const merged = mergeConversationSnapshot(baseState(), { id: "conv_2" });
    expect(merged.transcript).toEqual([]);
  });
});

describe("reconcileAfterStreamClose", () => {
  it("clears pendingRun, the STREAM_CLOSED error, and returns to idle", () => {
    const state = baseState({
      pendingRun: { runId: "run_9", status: "streaming", startedAt: "t" },
      error: { code: "STREAM_CLOSED", message: "eof", retryable: true },
      connectionStatus: "error",
    });
    const reconciled = reconcileAfterStreamClose(state, SNAPSHOT_DOC);
    expect(reconciled.pendingRun).toBeNull();
    expect(reconciled.error).toBeNull();
    expect(reconciled.connectionStatus).toBe("idle");
    expect(reconciled.transcript).toHaveLength(2);
  });

  it("keeps non-STREAM_CLOSED errors", () => {
    const state = baseState({
      error: { code: "POLICY", message: "nope", retryable: false },
    });
    const reconciled = reconcileAfterStreamClose(state, SNAPSHOT_DOC);
    expect(reconciled.error?.code).toBe("POLICY");
  });
});

describe("drainSendQueue", () => {
  it("returns queued sends in order when able to send", () => {
    expect(drainSendQueue(["a", "b"], true)).toEqual(["a", "b"]);
  });

  it("holds the queue while a turn is in flight", () => {
    expect(drainSendQueue(["a", "b"], false)).toEqual([]);
  });

  it("returns [] for an empty queue", () => {
    expect(drainSendQueue([], true)).toEqual([]);
  });
});
