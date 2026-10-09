/**
 * TurnMailbox — per-run mailbox for input that arrives WHILE a turn is
 * running.
 *
 * Ported from prism-service's harness_next work (§2.1 of
 * `docs/harness_next_2026-09.md`). A caller posts an input for a run that is
 * mid-turn; the loop drains the box at its next boundary (before every model
 * call, after each tool batch) instead of the input blocking or being lost.
 * The drained entries are surfaced to the model as ONE system/user notice on
 * the next turn — see `formatTurnNotice`.
 *
 * The box is bounded (max 50 pending per run) so a runaway producer cannot
 * grow the run's context unboundedly. A post with no open run is refused
 * (`no_active_run`) so the caller can take its after-the-turn path — exactly
 * prism's 409 contract.
 */
import crypto from "node:crypto";

export type TurnInputKind =
  | "user_update"
  | "question_answer"
  | "task_completion"
  | "agent_message"
  | "notice";

export interface TurnMailboxPost {
  kind: TurnInputKind;
  /** Plain text of the input. For notices, the already-formatted block. */
  text: string;
  images?: string[];
  /** Producer-specific metadata, copied verbatim onto the injected entry. */
  meta?: Record<string, unknown>;
}

export interface TurnMailboxEntry {
  id: string;
  runId: string;
  kind: TurnInputKind;
  text: string;
  images?: string[];
  meta?: Record<string, unknown>;
  receivedAt: number;
}

export type TurnMailboxPostResult =
  | { accepted: true; id: string; position: number }
  | { accepted: false; reason: "no_active_run" | "mailbox_full" | "empty_input" };

/** Hard cap so a runaway producer cannot grow a run's context unboundedly. */
export const TURN_MAILBOX_MAXIMUM_PENDING = 50;
/** A single input is bounded like a normal prompt would be. */
export const TURN_MAILBOX_MAXIMUM_TEXT_LENGTH = 20_000;

interface Box {
  entries: TurnMailboxEntry[];
  openedAt: number;
  /** Total accepted over the life of the run (for diagnostics / acks). */
  acceptedCount: number;
}

/**
 * Format drained entries as ONE system/user notice block for the next model
 * turn. The loop injects the returned string as a user (or system) message —
 * mid-turn input never blocks, it simply rides the next boundary. Entry text
 * is minimally escaped so the block stays well-formed.
 */
export function formatTurnNotice(entries: TurnMailboxEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    const escapedText = entry.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const attrs = ` kind="${entry.kind}" id="${entry.id}" received-at="${entry.receivedAt}"`;
    const images = entry.images?.length ? ` images="${entry.images.length}"` : "";
    return `<entry${attrs}${images}>${escapedText}</entry>`;
  });
  return `<turn-input count="${entries.length}">\n${lines.join("\n")}\n</turn-input>`;
}

/**
 * Per-run mailbox. Instantiate once (per process or per orchestrator) and
 * share it with the question registry — non-blocking question answers and
 * expiry notices ride the same box.
 */
export class TurnMailbox {
  #runs = new Map<string, Box>();

  /**
   * Open the mailbox for a run. Idempotent; re-opening keeps pending
   * entries (prism's open() semantics).
   */
  open(runId: string): void {
    if (!runId || this.#runs.has(runId)) return;
    this.#runs.set(runId, { entries: [], openedAt: Date.now(), acceptedCount: 0 });
  }

  /** Whether a run currently has an open mailbox. */
  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  /**
   * Post input to a running turn. Returns `accepted: false` when no run is
   * open (`no_active_run`) — the caller then queues it as the next turn —
   * or when the box is full (`mailbox_full`).
   */
  post(runId: string, input: TurnMailboxPost): TurnMailboxPostResult {
    const box = this.#runs.get(runId);
    if (!box) return { accepted: false, reason: "no_active_run" };
    if (box.entries.length >= TURN_MAILBOX_MAXIMUM_PENDING) {
      return { accepted: false, reason: "mailbox_full" };
    }
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim() && !(input.images && input.images.length > 0)) {
      return { accepted: false, reason: "empty_input" };
    }
    const entry: TurnMailboxEntry = {
      id: `input-${crypto.randomUUID().slice(0, 8)}`,
      runId,
      kind: input.kind,
      text: text.slice(0, TURN_MAILBOX_MAXIMUM_TEXT_LENGTH),
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      receivedAt: Date.now(),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    box.entries.push(entry);
    box.acceptedCount++;
    return { accepted: true, id: entry.id, position: box.entries.length };
  }

  /**
   * Take every pending entry, in arrival order, clearing the box. Empty when
   * nothing is pending.
   */
  drain(runId: string): TurnMailboxEntry[] {
    const box = this.#runs.get(runId);
    if (!box || box.entries.length === 0) return [];
    const drained = box.entries;
    box.entries = [];
    return drained;
  }

  /** Number of entries waiting for the next boundary. */
  pendingCount(runId: string): number {
    return this.#runs.get(runId)?.entries.length ?? 0;
  }

  /**
   * Close the mailbox at the end of the run. Returns whatever was still
   * pending so the caller can decide what to do with it (the loop drains
   * right before finalize, so this is normally empty).
   */
  close(runId: string): TurnMailboxEntry[] {
    const box = this.#runs.get(runId);
    if (!box) return [];
    this.#runs.delete(runId);
    return box.entries;
  }
}
