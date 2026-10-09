/**
 * NonBlockingQuestionRegistry — the open user questions of every run,
 * answered without parking the loop.
 *
 * Ported from prism-service's harness_next work (§2.2 of
 * `docs/harness_next_2026-09.md`): when the model asks a user question, the
 * loop registers it and CONTINUES (`registerQuestion` returns a question id
 * immediately; nothing awaits). The answer reaches the loop through the run's
 * TurnMailbox — either the caller resolves it here with `answerQuestion`
 * (which posts a `question_answer` entry) or the answer already arrived as a
 * mailbox entry with `meta.questionId` and the loop calls
 * `resolveFromMailbox`.
 *
 * Questions expire (default 10 minutes): the record is marked `expired` and a
 * synthesized "no answer, proceed with best judgment" notice is queued to the
 * mailbox so the next turn knows to move on. Expiry runs on a timer and is
 * also enforced by `sweepExpired()` — a loop can call that at every boundary
 * instead of relying on timers.
 */
import crypto from "node:crypto";
import { TurnMailbox } from "./TurnMailbox.ts";

/** Default wait before a question gives up and the model proceeds. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;

export type QuestionStatus = "pending" | "answered" | "expired" | "cancelled";

export interface QuestionInput {
  /** The question as shown to / asked of the user. */
  text: string;
  /** Producer-specific metadata, copied verbatim onto the record. */
  meta?: Record<string, unknown>;
}

export interface RegisteredQuestion {
  id: string;
  runId: string;
  text: string;
  askedAt: number;
  expiresAt: number;
  status: QuestionStatus;
  meta?: Record<string, unknown>;
  answer?: string;
  answeredAt?: number;
}

export type QuestionAnswerResult =
  | { resolved: true; question: RegisteredQuestion }
  | { resolved: false; reason: "unknown_question" | "already_answered" | "expired" | "cancelled" };

export interface NonBlockingQuestionOptions {
  /** Expiry window; default `DEFAULT_QUESTION_TIMEOUT_MS` (10 minutes). */
  defaultTimeoutMs?: number;
  /** Injectable clock (tests); default `Date.now`. */
  now?: () => number;
}

/**
 * Registry of non-blocking questions, backed by the run's shared TurnMailbox
 * (answers and expiry notices are mailbox entries, so the model sees them at
 * the next drain instead of a blocked await).
 */
export class NonBlockingQuestionRegistry {
  #mailbox: TurnMailbox;
  #defaultTimeoutMs: number;
  #now: () => number;
  #questions = new Map<string, RegisteredQuestion>();
  #timers = new Map<string, NodeJS.Timeout>();

  constructor(mailbox: TurnMailbox, options: NonBlockingQuestionOptions = {}) {
    this.#mailbox = mailbox;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Register a question for a run. Returns the record (with its id)
   * IMMEDIATELY — the loop continues; nothing here blocks.
   */
  registerQuestion(
    runId: string,
    question: QuestionInput,
    timeoutMs?: number,
  ): RegisteredQuestion {
    const text = typeof question?.text === "string" ? question.text.trim() : "";
    if (!text) throw new Error("registerQuestion requires non-empty question text");
    const askedAt = this.#now();
    const expiresAt = askedAt + Math.max(1, Math.min(timeoutMs ?? this.#defaultTimeoutMs, 2_147_483_647));
    const record: RegisteredQuestion = {
      id: `question-${crypto.randomUUID().slice(0, 8)}`,
      runId,
      text,
      askedAt,
      expiresAt,
      status: "pending",
      ...(question.meta ? { meta: question.meta } : {}),
    };
    this.#questions.set(record.id, record);
    const timer = setTimeout(() => this.#expire(record.id), expiresAt - askedAt);
    timer.unref?.();
    this.#timers.set(record.id, timer);
    return record;
  }

  /**
   * Resolve a question with an answer from outside the mailbox (HTTP route,
   * parent agent, ...). Posts a `question_answer` entry to the run's mailbox
   * so the next turn surfaces it. A question already answered, expired, or
   * cancelled refuses further answers — the model has already moved on.
   */
  answerQuestion(id: string, answer: string): QuestionAnswerResult {
    const settled = this.#settle(id, answer);
    if (!settled) {
      const record = this.#questions.get(id);
      return { resolved: false, reason: this.#refusalReason(record) };
    }
    this.#mailbox.post(settled.runId, {
      kind: "question_answer",
      text: answer,
      meta: { questionId: id, questionText: settled.text },
    });
    return { resolved: true, question: settled };
  }

  /**
   * Mark a question answered by a mailbox entry that already carries the
   * answer (a `question_answer` with `meta.questionId`). Unlike
   * `answerQuestion`, nothing is re-posted to the mailbox.
   */
  resolveFromMailbox(id: string, answer: string): QuestionAnswerResult {
    const settled = this.#settle(id, answer);
    if (!settled) {
      const record = this.#questions.get(id);
      return { resolved: false, reason: this.#refusalReason(record) };
    }
    return { resolved: true, question: settled };
  }

  /**
   * Cancel a pending question without answering it (run ended, caller
   * superseded it). Returns whether anything was cancelled.
   */
  cancel(id: string): boolean {
    const record = this.#questions.get(id);
    if (!record || record.status !== "pending") return false;
    record.status = "cancelled";
    this.#clearTimer(id);
    return true;
  }

  /**
   * Expire every overdue pending question (idempotent with the per-question
   * timers). Returns the ids expired by this sweep.
   */
  sweepExpired(): string[] {
    const now = this.#now();
    const expired: string[] = [];
    for (const record of this.#questions.values()) {
      if (record.status === "pending" && record.expiresAt <= now) {
        this.#expire(record.id);
        expired.push(record.id);
      }
    }
    return expired;
  }

  getQuestion(id: string): RegisteredQuestion | undefined {
    return this.#questions.get(id);
  }

  /** Pending questions of a run, oldest first. */
  listPending(runId: string): RegisteredQuestion[] {
    return [...this.#questions.values()]
      .filter((record) => record.runId === runId && record.status === "pending")
      .sort((a, b) => a.askedAt - b.askedAt);
  }

  pendingCount(runId: string): number {
    return this.listPending(runId).length;
  }

  /** Clear every timer; records are dropped with the registry. */
  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#questions.clear();
  }

  /**
   * Mark a pending question expired and queue the synthesized
   * "proceed with best judgment" notice to the run's mailbox. Safe to call
   * on an already-settled record (the timers' no-op path).
   */
  #expire(id: string): void {
    this.#clearTimer(id);
    const record = this.#questions.get(id);
    if (!record || record.status !== "pending") return;
    record.status = "expired";
    const waitedSeconds = Math.round((record.expiresAt - record.askedAt) / 1000);
    this.#mailbox.post(record.runId, {
      kind: "notice",
      text:
        `Your question "${record.text}" received no answer within ${waitedSeconds}s ` +
        "and has expired. No answer is coming — proceed with best judgment.",
      meta: {
        questionId: record.id,
        questionStatus: "expired",
        questionText: record.text,
      },
    });
  }

  /** Transition a pending record to answered; undefined when it is not pending. */
  #settle(id: string, answer: string): RegisteredQuestion | undefined {
    const record = this.#questions.get(id);
    if (!record || record.status !== "pending") return undefined;
    record.status = "answered";
    record.answer = answer;
    record.answeredAt = this.#now();
    this.#clearTimer(id);
    return record;
  }

  #clearTimer(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
  }

  #refusalReason(
    record: RegisteredQuestion | undefined,
  ): Extract<QuestionAnswerResult, { resolved: false }>["reason"] {
    if (!record) return "unknown_question";
    switch (record.status) {
      case "answered":
        return "already_answered";
      case "expired":
        return "expired";
      case "cancelled":
        return "cancelled";
      // "pending" is unreachable here: #settle only fails on settled or
      // missing records, so a pending record never reaches the refusal path.
      case "pending":
        return "already_answered";
    }
  }
}
