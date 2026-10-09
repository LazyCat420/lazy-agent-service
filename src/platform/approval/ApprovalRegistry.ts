/**
 * ApprovalRegistry — minimal in-memory, per-run registry of pending approval
 * asks. Approve/deny/timeout, keyed by ask id. `retireOrphaned(runId)`
 * supersedes asks left behind by a dead turn so they can never hang a later
 * one. No persistence: a process restart lapses every pending ask, matching
 * prism's turn-cleanup semantics (AgenticLoopService finally block).
 */

export type AskStatus = "pending" | "approved" | "denied" | "timeout" | "retired";

export type AskRecord = {
  runId: string;
  tool: string;
  status: AskStatus;
  /** Who/what settled the ask, when it was not a timeout. */
  decidedBy?: "user" | "policy";
  decidedAt?: number;
};

const asks = new Map<string, AskRecord>();
const waiters: Map<string, (record: AskRecord) => void> = new Map();

const isSettled = (record: AskRecord): boolean => record.status !== "pending";

function settle(askId: string, status: "timeout" | "retired"): AskRecord | undefined {
  const record = asks.get(askId);
  if (!record || record.status !== "pending") return undefined;
  record.status = status;
  record.decidedAt = Date.now();
  waiters.get(askId)?.(record);
  waiters.delete(askId);
  return record;
}

/** Register a pending ask; resolves when it is settled or times out. */
export function register(
  askId: string,
  record: { runId: string; tool: string },
  timeoutMs?: number,
): Promise<AskRecord> {
  let resolveAdapter!: (record: AskRecord) => void;
  const promise = new Promise<AskRecord>((resolve) => { resolveAdapter = resolve; });
  asks.set(askId, { status: "pending", ...record });
  waiters.set(askId, resolveAdapter);
  if (timeoutMs !== undefined) setTimeout(() => settle(askId, "timeout"), timeoutMs).unref?.();
  return promise;
}

/** Resolve a pending ask by id; returns the record or undefined if unknown/settled. */
export function decide(
  askId: string,
  decision: "approved" | "denied",
  decidedBy: "user" | "policy" = "user",
): AskRecord | undefined {
  const record = asks.get(askId);
  if (!record || isSettled(record)) return undefined;
  record.status = decision;
  record.decidedBy = decidedBy;
  record.decidedAt = Date.now();
  waiters.get(askId)?.(record);
  waiters.delete(askId);
  return record;
}

export function get(askId: string): AskRecord | undefined {
  return asks.get(askId);
}

/**
 * Supersede every pending ask belonging to a run (its turn is over or died):
 * they lapse as `retired` and their waiters resolve instead of hanging.
 */
export function retireOrphaned(runId: string): AskRecord[] {
  const retired: AskRecord[] = [];
  for (const [askId, record] of asks) {
    if (record.runId === runId && record.status === "pending") {
      const settled = settle(askId, "retired");
      if (settled) retired.push(settled);
    }
  }
  return retired;
}
