import { describe, expect, it } from "vitest";
import {
  buildJsonResponseFromEvents,
  deriveLoopHonestyFields,
  withLoopHonestyFields,
} from "../../utils/SseUtilities.ts";
import type { SseEvent } from "../../types/SseTypes.ts";
import type { ChatRequest } from "../../types/schemas.ts";

// LF-06 / LF-07 (slice S-01): the JSON /agent reply and the final SSE done
// event must carry answerSource, finalizeReason and providerAttempts so a
// synthetic digest or a finalised run can never masquerade as a clean answer.

describe("deriveLoopHonestyFields", () => {
  it("normal run maps to model / COMPLETED / 1 attempt", () => {
    expect(
      deriveLoopHonestyFields({
        answerSource: "model",
        finalizeReason: undefined,
        modelCalls: 1,
      }),
    ).toEqual({
      answerSource: "model",
      finalizeReason: "COMPLETED",
      providerAttempts: 1,
    });
  });

  it("step-limit digest run maps to synthetic / STEP_LIMIT", () => {
    expect(
      deriveLoopHonestyFields({
        answerSource: "synthetic",
        finalizeReason: "STEP_LIMIT",
        modelCalls: 4,
      }),
    ).toEqual({
      answerSource: "synthetic",
      finalizeReason: "STEP_LIMIT",
      providerAttempts: 4,
    });
  });

  it("one provider retry inside the turn yields providerAttempts 2", () => {
    // CoreLoop counts every provider attempt (retry loop included) in modelCalls.
    expect(
      deriveLoopHonestyFields({
        answerSource: "model",
        finalizeReason: undefined,
        modelCalls: 2,
      }),
    ).toEqual({
      answerSource: "model",
      finalizeReason: "COMPLETED",
      providerAttempts: 2,
    });
  });

  it("passes an unknown loop finalize reason through unchanged and floors attempts at 1", () => {
    expect(
      deriveLoopHonestyFields({
        answerSource: "model",
        finalizeReason: "repeated_tool_call:scrape_url",
        modelCalls: 0,
      }),
    ).toEqual({
      answerSource: "model",
      finalizeReason: "repeated_tool_call:scrape_url",
      providerAttempts: 1,
    });
  });
});

describe("withLoopHonestyFields", () => {
  const meta = {
    answerSource: "synthetic" as const,
    finalizeReason: "TOKEN_BUDGET",
    providerAttempts: 3,
  };

  it("decorates only the done event", () => {
    expect(withLoopHonestyFields({ type: "done", model: "m" }, meta)).toEqual({
      type: "done",
      model: "m",
      ...meta,
    });
    const chunk = { type: "chunk", content: "hi" };
    expect(withLoopHonestyFields(chunk, meta)).toBe(chunk);
  });
});

describe("buildJsonResponseFromEvents — honesty fields", () => {
  const baseEvents = (doneEvent: SseEvent): SseEvent[] => [
    { type: "chunk", content: "final answer" },
    doneEvent,
  ];
  const body = (events: SseEvent[]) =>
    buildJsonResponseFromEvents(events, {
      provider: "p",
      model: "m",
    } as unknown as ChatRequest)
      .response as Record<string, unknown>;

  it("normal run replies with model / COMPLETED / 1", () => {
    const response = body(
      baseEvents({
        type: "done",
        provider: "p",
        model: "m",
        ...deriveLoopHonestyFields({
          answerSource: "model",
          finalizeReason: undefined,
          modelCalls: 1,
        }),
      }),
    );
    expect(response.text).toBe("final answer");
    expect(response.answerSource).toBe("model");
    expect(response.finalizeReason).toBe("COMPLETED");
    expect(response.providerAttempts).toBe(1);
  });

  it("step-limit digest run replies with synthetic / STEP_LIMIT", () => {
    const response = body(
      baseEvents({
        type: "done",
        provider: "p",
        model: "m",
        ...deriveLoopHonestyFields({
          answerSource: "synthetic",
          finalizeReason: "STEP_LIMIT",
          modelCalls: 5,
        }),
      }),
    );
    expect(response.answerSource).toBe("synthetic");
    expect(response.finalizeReason).toBe("STEP_LIMIT");
    expect(response.providerAttempts).toBe(5);
  });

  it("one provider retry replies with providerAttempts 2", () => {
    const response = body(
      baseEvents({
        type: "done",
        provider: "p",
        model: "m",
        ...deriveLoopHonestyFields({
          answerSource: "model",
          finalizeReason: undefined,
          modelCalls: 2,
        }),
      }),
    );
    expect(response.providerAttempts).toBe(2);
  });

  it("omits the fields when the done event has none (older paths keep working)", () => {
    const response = body(baseEvents({ type: "done", provider: "p", model: "m" }));
    expect("answerSource" in response).toBe(false);
    expect("finalizeReason" in response).toBe(false);
    expect("providerAttempts" in response).toBe(false);
    expect(response.text).toBe("final answer");
  });
});
