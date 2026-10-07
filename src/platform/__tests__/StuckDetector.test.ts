import { describe, it, expect } from "vitest";
import {
  StuckDetector,
  normalizeContent,
  isErrorResult,
  type StuckEvent,
} from "../verify/StuckDetector.ts";

function toolEvent(
  toolName: string,
  content: string,
  isError = false,
): StuckEvent {
  return {
    toolName,
    normalizedContent: content,
    isError,
    isModelMonologue: false,
  };
}

function monologueEvent(content: string): StuckEvent {
  return {
    toolName: "",
    normalizedContent: content,
    isError: false,
    isModelMonologue: true,
  };
}

describe("normalizeContent", () => {
  it("strips ids, timestamps and whitespace", () => {
    const a = normalizeContent(
      "deploy id=a1b2c3d4-e5f6-7890-abcd-ef0123456789 at 2026-10-07T12:34:56Z done",
    );
    const b = normalizeContent(
      "deploy  id=fedcba98-7654-3211-0fed-cba987654321  at  2099-01-01T00:00:00.000Z  DONE",
    );
    expect(a).toBe(b);
  });

  it("keeps genuinely different results distinct", () => {
    expect(normalizeContent("3 tests failed")).not.toBe(
      normalizeContent("5 tests failed"),
    );
  });
});

describe("isErrorResult", () => {
  it("recognizes the orchestrator result shapes", () => {
    expect(isErrorResult({ success: false, message: "boom" })).toBe(true);
    expect(isErrorResult({ success: true })).toBe(false);
    expect(isErrorResult({ error: "timeout" })).toBe(true);
    expect(isErrorResult({ is_error: true })).toBe(true);
    expect(isErrorResult("plain output")).toBe(false);
    expect(isErrorResult(null)).toBe(false);
  });
});

describe("StuckDetector five patterns", () => {
  it("trips action_observation_loop after 4 repeated identical cycles", () => {
    const detector = new StuckDetector();
    for (let i = 0; i < 4; i++) {
      detector.record(toolEvent("run_tests", "all 42 tests passed"));
    }
    const pattern = detector.detect();
    expect(pattern?.pattern).toBe("action_observation_loop");
    expect(pattern?.occurrences).toBe(4);
  });

  it("does not trip action_observation_loop when observations differ", () => {
    const detector = new StuckDetector();
    for (let i = 0; i < 4; i++) {
      detector.record(toolEvent("run_tests", `run ${i}: ${i * 7} tests passed`));
    }
    expect(detector.detect()).toBeNull();
  });

  it("trips action_error_loop after 3 repeated identical failures", () => {
    const detector = new StuckDetector();
    for (let i = 0; i < 3; i++) {
      detector.record(toolEvent("read_file", "ENOENT: no such file", true));
    }
    expect(detector.detect()?.pattern).toBe("action_error_loop");
  });

  it("trips monologue_loop after 3 consecutive monologues", () => {
    const detector = new StuckDetector();
    for (let i = 0; i < 3; i++) {
      detector.record(monologueEvent(`let me think about step ${i}`));
    }
    expect(detector.detect()?.pattern).toBe("monologue_loop");
  });

  it("trips alternating_loop after 6+ alternating identical pairs", () => {
    const detector = new StuckDetector();
    for (let i = 0; i < 3; i++) {
      detector.record(toolEvent("read_file", "alpha"));
      detector.record(toolEvent("list_dir", "beta"));
    }
    const pattern = detector.detect();
    expect(pattern?.pattern).toBe("alternating_loop");
    expect(pattern?.occurrences).toBe(6);
  });

  it("trips context_window_error after 3 repeated overflow errors", () => {
    const detector = new StuckDetector();
    for (let i = 0; i < 3; i++) {
      detector.record(
        toolEvent(
          "shell",
          `request failed: context_length_exceeded (attempt ${i}, id=a1b2c3d4-e5f6-7890-abcd-ef0123456789)`,
          true,
        ),
      );
    }
    expect(detector.detect()?.pattern).toBe("context_window_error");
  });

  it("a legitimate retry with a changed result does not trip", () => {
    const detector = new StuckDetector();
    detector.record(toolEvent("read_file", "ENOENT: missing.ts", true));
    detector.record(toolEvent("read_file", "export const ok = true", false));
    detector.record(toolEvent("run_tests", "3 tests failed", false));
    detector.record(toolEvent("run_tests", "all tests passed", false));
    expect(detector.detect()).toBeNull();
  });

  it("tracks consecutive detection streaks for escalation", () => {
    const detector = new StuckDetector();
    detector.record(toolEvent("shell", "same output"));
    detector.record(toolEvent("shell", "same output"));
    detector.record(toolEvent("shell", "same output"));
    detector.record(toolEvent("shell", "same output"));
    detector.detect();
    expect(detector.getStreak()).toBe(1);
    detector.record(toolEvent("shell", "same output"));
    detector.detect();
    expect(detector.getStreak()).toBe(2);
    detector.record(toolEvent("shell", "a different outcome entirely"));
    expect(detector.detect()).toBeNull();
    expect(detector.getStreak()).toBe(0);
  });
});
