import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUESTION_TIMEOUT_MS,
  NonBlockingQuestionRegistry,
} from "../../../src/platform/questions/NonBlockingQuestion.ts";
import { TurnMailbox } from "../../../src/platform/questions/TurnMailbox.ts";

describe("NonBlockingQuestionRegistry", () => {
  it("registers a question and returns its id immediately (non-blocking)", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    const registry = new NonBlockingQuestionRegistry(mailbox);

    const record = registry.registerQuestion("run-1", { text: "Which database should I use?" });

    expect(record.id).toMatch(/^question-/);
    expect(record.status).toBe("pending");
    expect(record.expiresAt).toBe(record.askedAt + DEFAULT_QUESTION_TIMEOUT_MS);
    expect(registry.pendingCount("run-1")).toBe(1);
    expect(registry.listPending("run-1")[0].id).toBe(record.id);
    // Registering does not touch the mailbox; the ask itself is the model's own turn.
    expect(mailbox.pendingCount("run-1")).toBe(0);
  });

  it("resolves via answerQuestion and posts a question_answer entry to the mailbox", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    const registry = new NonBlockingQuestionRegistry(mailbox);
    const record = registry.registerQuestion("run-1", { text: "Proceed without tests?" });

    const outcome = registry.answerQuestion(record.id, "Yes, proceed with a smoke test");
    expect(outcome.resolved).toBe(true);
    expect(registry.getQuestion(record.id)).toMatchObject({
      status: "answered",
      answer: "Yes, proceed with a smoke test",
    });

    const drained = mailbox.drain("run-1");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ kind: "question_answer", text: "Yes, proceed with a smoke test" });
    expect(drained[0].meta).toMatchObject({ questionId: record.id });

    // A second answer for the same question is refused.
    expect(registry.answerQuestion(record.id, "changed my mind")).toEqual({
      resolved: false,
      reason: "already_answered",
    });
  });

  it("resolves answers that arrive through the mailbox without re-posting", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    const registry = new NonBlockingQuestionRegistry(mailbox);
    const record = registry.registerQuestion("run-1", { text: "Which branch?" });

    // The transport delivered the answer as a mailbox entry carrying the id.
    mailbox.post("run-1", {
      kind: "question_answer",
      text: "use main",
      meta: { questionId: record.id },
    });
    expect(mailbox.pendingCount("run-1")).toBe(1);

    const outcome = registry.resolveFromMailbox(record.id, "use main");
    expect(outcome.resolved).toBe(true);
    expect(registry.getQuestion(record.id)).toMatchObject({ status: "answered", answer: "use main" });
    // Nothing re-posted: the entry the loop already drained is the answer.
    expect(mailbox.pendingCount("run-1")).toBe(1);
  });

  // The registry schedules a real setTimeout; fake timers advance it
  // deterministically instead of a guessed real-time sleep.
  it("expires on its timer and queues a synthesized proceed-with-best-judgment notice", () => {
    vi.useFakeTimers();
    try {
      const mailbox = new TurnMailbox();
      mailbox.open("run-1");
      const registry = new NonBlockingQuestionRegistry(mailbox, { defaultTimeoutMs: 20_000 });
      const record = registry.registerQuestion("run-1", { text: "Deploy now or later?" });

      vi.advanceTimersByTime(20_000);

      expect(registry.getQuestion(record.id)?.status).toBe("expired");
      const drained = mailbox.drain("run-1");
      expect(drained).toHaveLength(1);
      expect(drained[0].kind).toBe("notice");
      expect(drained[0].text).toContain("no answer");
      expect(drained[0].text).toContain("proceed with best judgment");
      expect(drained[0].meta).toMatchObject({ questionId: record.id, questionStatus: "expired" });

      // A late answer after expiry is refused.
      expect(registry.answerQuestion(record.id, "too late")).toEqual({
        resolved: false,
        reason: "expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps overdue questions without relying on timers", () => {
    let now = 1_000_000;
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    const registry = new NonBlockingQuestionRegistry(mailbox, { now: () => now });

    const first = registry.registerQuestion("run-1", { text: "first" }, 1_000);
    const second = registry.registerQuestion("run-1", { text: "second" }, 10_000);

    now += 2_000;
    expect(registry.sweepExpired()).toEqual([first.id]);
    expect(registry.getQuestion(first.id)?.status).toBe("expired");
    expect(registry.getQuestion(second.id)?.status).toBe("pending");

    const drained = mailbox.drain("run-1");
    expect(drained).toHaveLength(1);
    expect(drained[0].text).toContain("proceed with best judgment");
    expect(drained[0].meta).toMatchObject({ questionId: first.id });
  });

  it("cancels a pending question and clears its timer", () => {
    vi.useFakeTimers();
    try {
      const mailbox = new TurnMailbox();
      mailbox.open("run-1");
      const registry = new NonBlockingQuestionRegistry(mailbox, { defaultTimeoutMs: 20_000 });
      const record = registry.registerQuestion("run-1", { text: "obsolete?" });

      expect(registry.cancel(record.id)).toBe(true);
      expect(registry.cancel(record.id)).toBe(false);

      vi.advanceTimersByTime(20_000);
      expect(registry.getQuestion(record.id)?.status).toBe("cancelled");
      expect(mailbox.drain("run-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses answers to unknown questions", () => {
    const mailbox = new TurnMailbox();
    const registry = new NonBlockingQuestionRegistry(mailbox);
    expect(registry.answerQuestion("question-does-not-exist", "anything")).toEqual({
      resolved: false,
      reason: "unknown_question",
    });
  });
});
