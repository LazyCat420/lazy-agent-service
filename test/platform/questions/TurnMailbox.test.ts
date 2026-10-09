import { describe, expect, it } from "vitest";
import {
  TURN_MAILBOX_MAXIMUM_PENDING,
  TURN_MAILBOX_MAXIMUM_TEXT_LENGTH,
  TurnMailbox,
  formatTurnNotice,
} from "../../../src/platform/questions/TurnMailbox.ts";

describe("TurnMailbox", () => {
  it("returns and clears pending inputs in arrival order (FIFO)", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    const first = mailbox.post("run-1", { kind: "user_update", text: "first note" });
    const second = mailbox.post("run-1", { kind: "agent_message", text: "second note" });

    expect(first).toMatchObject({ accepted: true, position: 1 });
    expect(second).toMatchObject({ accepted: true, position: 2 });
    expect(mailbox.pendingCount("run-1")).toBe(2);

    const drained = mailbox.drain("run-1");
    expect(drained.map((entry) => entry.text)).toEqual(["first note", "second note"]);
    expect(drained[0].kind).toBe("user_update");
    expect(drained[0].runId).toBe("run-1");
    expect(drained[0].id).toBe(first.accepted ? first.id : undefined);

    // Cleared after the drain.
    expect(mailbox.drain("run-1")).toEqual([]);
    expect(mailbox.pendingCount("run-1")).toBe(0);
  });

  it("is bounded: refuses posts past the cap, recovers after a drain", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");

    for (let i = 0; i < TURN_MAILBOX_MAXIMUM_PENDING; i++) {
      expect(mailbox.post("run-1", { kind: "user_update", text: `note ${i}` }).accepted).toBe(true);
    }
    expect(mailbox.post("run-1", { kind: "user_update", text: "one too many" })).toEqual({
      accepted: false,
      reason: "mailbox_full",
    });

    expect(mailbox.drain("run-1")).toHaveLength(TURN_MAILBOX_MAXIMUM_PENDING);
    expect(mailbox.post("run-1", { kind: "user_update", text: "fits again" }).accepted).toBe(true);
  });

  it("refuses posts for runs that never opened or already closed", () => {
    const mailbox = new TurnMailbox();
    expect(mailbox.post("run-unknown", { kind: "user_update", text: "hello" })).toEqual({
      accepted: false,
      reason: "no_active_run",
    });

    mailbox.open("run-1");
    mailbox.post("run-1", { kind: "user_update", text: "still pending" });
    const leftovers = mailbox.close("run-1");
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0].text).toBe("still pending");
    expect(mailbox.post("run-1", { kind: "user_update", text: "after close" })).toEqual({
      accepted: false,
      reason: "no_active_run",
    });
  });

  it("refuses empty inputs and truncates oversized text", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    expect(mailbox.post("run-1", { kind: "user_update", text: "   " })).toEqual({
      accepted: false,
      reason: "empty_input",
    });

    const long = "x".repeat(TURN_MAILBOX_MAXIMUM_TEXT_LENGTH + 100);
    const posted = mailbox.post("run-1", { kind: "user_update", text: long });
    expect(posted.accepted).toBe(true);
    const [entry] = mailbox.drain("run-1");
    expect(entry.text).toHaveLength(TURN_MAILBOX_MAXIMUM_TEXT_LENGTH);
  });

  it("re-opening keeps pending entries", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    mailbox.post("run-1", { kind: "user_update", text: "kept" });
    mailbox.open("run-1");
    expect(mailbox.drain("run-1")).toHaveLength(1);
  });

  it("formats drained entries as a single turn-input notice block", () => {
    const mailbox = new TurnMailbox();
    mailbox.open("run-1");
    mailbox.post("run-1", { kind: "user_update", text: "steer: use <b> tags & quotes" });
    mailbox.post("run-1", {
      kind: "notice",
      text: "question expired",
      meta: { questionId: "question-abc" },
    });

    const notice = formatTurnNotice(mailbox.drain("run-1"));
    expect(notice).toContain('<turn-input count="2">');
    expect(notice).toContain('kind="user_update"');
    expect(notice).toContain("steer: use &lt;b&gt; tags &amp; quotes");
    expect(notice).toContain("</turn-input>");
    expect(formatTurnNotice([])).toBe("");
  });
});
