/**
 * Tool-layer audit 2026-10-16 F6(b): tool_execution spans were ERROR only
 * when the tool threw. Tools that RETURN an error result (the common case)
 * were recorded OK, so the spans store showed 0 errors on a day with 18
 * whiteboard error results.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { HarnessInstrumenter, toolResultError } from "../trace/HarnessInstrumenter.ts";
import { TraceExporter } from "../trace/TraceExporter.ts";
import { RunEvidenceStore } from "../verify/RunEvidenceStore.ts";

async function spanFor(result: unknown) {
  TraceExporter.getGlobalInstance().clear();
  await HarnessInstrumenter.traceToolExecution("some_tool", {}, undefined, "READ_ONLY", async () => result);
  const spans = TraceExporter.getGlobalInstance()
    .getQueuedSpans()
    .filter((s) => s.kind === "tool_execution");
  expect(spans).toHaveLength(1);
  return spans[0];
}

describe("tool_execution span status from the tool result", () => {
  beforeEach(() => {
    RunEvidenceStore.getGlobalInstance().clear();
    TraceExporter.getGlobalInstance().clear();
  });

  it.each([
    ["{error}", { error: "Validation failed: 2 errors" }, "Validation failed: 2 errors"],
    ["{is_error:true}", { error: "PERMISSION_DENIED", message: "not in role catalog", is_error: true }, "not in role catalog"],
    ["{success:false}", { success: false, message: "nope" }, "nope"],
    ["trading JSON text {status:error}", '{"status": "error", "message": "Entry ID 7 not found"}', "Entry ID 7 not found"],
    ["trading JSON text {error}", '{"error": "Need at least 2 tickers"}', "Need at least 2 tickers"],
  ])("error result %s → ERROR span", async (_label, result, message) => {
    const span = await spanFor(result);
    expect(span.status).toBe("ERROR");
    expect(span.status_message).toBe(message);
    expect(span.attributes.error_fingerprint).toBeTruthy();
  });

  it.each([
    ["object", { content: "{}" }],
    ["plain text", "file content here"],
    ["JSON ok", '{"status": "ok", "rows": []}'],
    ["error:null", { error: null, data: 1 }],
    ["success:true with error field", { success: true, error: "ignored" }],
  ])("successful result %s → OK span", async (_label, result) => {
    expect((await spanFor(result)).status).toBe("OK");
  });

  it("toolResultError ignores truncated/non-JSON text", () => {
    expect(toolResultError('{"status": "error", "mess')).toBeNull();
    expect(toolResultError("[1,2]")).toBeNull();
  });
});
