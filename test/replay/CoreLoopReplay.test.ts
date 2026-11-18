/**
 * Transcript replay: recorded model-server conversations (test/replay/fixtures/*.json) run
 * through the real provider, core loop and tool runner. See replayHarness.ts for what is real
 * and what is replaced.
 *
 * Every fixture is checked against its own `expect` block (which tools ran with which
 * arguments, how many model requests were made, how the run ended, the final text). The
 * scenario tests below add what an `expect` block cannot say: what the model was told on its
 * next request, and what the user saw.
 *
 * A fixture with `knownDefect` describes behaviour the loop does not have yet. It is declared
 * with `it.fails`, so it turns red the day the defect is fixed: delete `knownDefect` then.
 */
import { describe, expect, it } from "vitest";
import { loadReplayFixture, loadReplayFixtures, runReplay, type ReplayFixture, type ReplayRun, type WireMessage } from "./replayHarness.ts";

/** The Nth request (1-based) the loop sent to the model server. */
function request(run: ReplayRun, requestNumber: number) {
  const found = run.modelRequests[requestNumber - 1];
  if (!found) throw new Error(`the loop made only ${run.modelRequests.length} model request(s); wanted #${requestNumber}`);
  return found;
}

/** The tool results the model was shown in the Nth request (1-based). */
function toolResults(run: ReplayRun, requestNumber: number): WireMessage[] {
  return request(run, requestNumber).messages.filter((message) => message.role === "tool");
}

/** The tool calls of the last assistant message in the Nth request (1-based). */
function lastAssistantCalls(run: ReplayRun, requestNumber: number) {
  const assistant = request(run, requestNumber).messages.findLast((message) => message.role === "assistant");
  return assistant?.tool_calls ?? [];
}

function contentOf(message: WireMessage | undefined): string {
  if (message === undefined) throw new Error("expected a message, found none");
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function finalizeReasons(run: ReplayRun): Array<string | undefined> {
  return run.warnings.filter((warning) => warning.code === "FINALIZE").map((warning) => warning.reason);
}

/** Checks a finished run against the fixture's `expect` block. */
function expectRunToMatchFixture(run: ReplayRun, fixture: ReplayFixture): void {
  const want = fixture.expect;

  expect(run.problems).toEqual([]);
  expect(run.toolCalls).toEqual(want.toolCalls);
  expect(run.modelRequests).toHaveLength(want.modelRequests);
  expect(run.unusedTurns).toBe(fixture.turns.length - want.modelRequests);
  expect(run.outcome).toBe(want.outcome);

  if (want.outcome !== "completed") {
    expect(run.result).toBeUndefined();
    return;
  }
  expect(run.result?.status).toBe("completed");
  if (want.text !== undefined) {
    expect(run.result?.text).toBe(want.text);
    // The answer the run reports is the answer the user saw streamed.
    expect(run.streamedText.join("")).toBe(want.text);
  }
  if (want.finalizeReason !== undefined) expect(run.result?.finalizeReason ?? null).toBe(want.finalizeReason);
  if (want.answerSource !== undefined) expect(run.result?.answerSource).toBe(want.answerSource);
  if (want.providerRetries !== undefined) expect(run.result?.providerRetries).toBe(want.providerRetries);
}

const fixtures = loadReplayFixtures();
const working = fixtures.filter((fixture) => fixture.knownDefect === undefined);
const defective = fixtures.filter((fixture) => fixture.knownDefect !== undefined);

describe("core loop transcript replay: every fixture meets its expect block", () => {
  it.each(working.map((fixture) => [fixture.id, fixture] as const))("%s", async (_id, fixture) => {
    expectRunToMatchFixture(await runReplay(fixture), fixture);
  });

  // DEFECTS: each fixture's `knownDefect` names the cause. Remove `knownDefect` from the fixture when fixed.
  it.fails.each(defective.map((fixture) => [fixture.id, fixture] as const))("%s (known defect)", async (_id, fixture) => {
    expectRunToMatchFixture(await runReplay(fixture), fixture);
  });
});

describe("core loop transcript replay: what the model is told next", () => {
  it("round trip: the first request offers the fixture's tools and ends with the user's message", async () => {
    const run = await runReplay(loadReplayFixture("02-tool-round-trip"));
    const first = request(run, 1);

    expect(first.model).toBe("replay-model");
    expect(first.stream).toBe(true);
    expect(first.tool_choice).toBe("auto");
    expect(first.tools?.map((tool) => tool.function.name)).toContain("get_quote");
    expect(first.messages.at(-1)).toMatchObject({ role: "user", content: "What is AAPL trading at?" });
  });

  it("round trip: the second request carries the assistant tool call and its result under the same id", async () => {
    const run = await runReplay(loadReplayFixture("02-tool-round-trip"));
    const calls = lastAssistantCalls(run, 2);
    const results = toolResults(run, 2);

    expect(calls.map((call) => call.function.name)).toEqual(["get_quote"]);
    expect(calls.map((call) => JSON.parse(call.function.arguments))).toEqual([{ symbol: "AAPL" }]);
    expect(results.map((message) => message.tool_call_id)).toEqual(calls.map((call) => call.id));
    expect(JSON.parse(contentOf(results[0]))).toEqual({ symbol: "AAPL", price: 187.42, currency: "USD" });
  });

  it("parallel calls: both results go back, each under its own call id, in call order", async () => {
    const run = await runReplay(loadReplayFixture("03-parallel-tool-calls"));
    const calls = lastAssistantCalls(run, 2);
    const results = toolResults(run, 2);

    expect(calls.map((call) => call.function.name)).toEqual(["get_quote", "get_news"]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    expect(results.map((message) => message.tool_call_id)).toEqual(calls.map((call) => call.id));
    expect(contentOf(results[0])).toContain("912.5");
    expect(contentOf(results[1])).toContain("Export rules");
  });

  it("malformed arguments (required argument): the model is told which argument is missing", async () => {
    const run = await runReplay(loadReplayFixture("04-malformed-args-required"));
    const results = toolResults(run, 2);

    expect(results).toHaveLength(1);
    expect(results[0]?.tool_call_id).toBe(lastAssistantCalls(run, 2)[0]?.id);
    expect(contentOf(results[0])).toContain("get_quote");
    expect(contentOf(results[0])).toContain("symbol");
  });

  // Regression (fixed 2026-11-18): CoreLoop dropped the provider's argsParseError flag, so the
  // tool ran with `{}` and the model was shown a real result for arguments it never finished.
  it("malformed arguments (optional arguments): the model is told its arguments did not parse", async () => {
    const run = await runReplay(loadReplayFixture("05-malformed-args-optional"));
    const results = toolResults(run, 2);

    expect(results).toHaveLength(1);
    // "VTI" is what the tool returns; a refusal names the tool and the arguments, never the holdings.
    expect(contentOf(results[0])).not.toContain("VTI");
    expect(contentOf(results[0])).toMatch(/argument/i);
  });

  // Regression (fixed 2026-11-18): `null` arguments used to throw in ToolRunner coerceArgs and fail the run.
  it("null arguments: the model is told the call was rejected and the run carries on", async () => {
    const run = await runReplay(loadReplayFixture("06-null-arguments"));

    expect(run.outcome).toBe("completed");
    expect(toolResults(run, 2)).toHaveLength(1);
    expect(contentOf(toolResults(run, 2)[0])).toContain("get_quote");
  });

  it("unknown tool: the model is told the name is unknown and is offered the close match", async () => {
    const run = await runReplay(loadReplayFixture("07-unknown-tool"));
    const results = toolResults(run, 2);

    expect(results).toHaveLength(1);
    expect(contentOf(results[0])).toContain('"get_qoute" not found');
    expect(contentOf(results[0])).toContain('Did you mean "get_quote"?');
  });

  it("tool error: the error text reaches the model as the result of that call", async () => {
    const run = await runReplay(loadReplayFixture("08-tool-error"));
    const results = toolResults(run, 2);

    expect(results).toHaveLength(1);
    expect(results[0]?.tool_call_id).toBe(lastAssistantCalls(run, 2)[0]?.id);
    expect(contentOf(results[0])).toContain("SEC EDGAR returned HTTP 503");
  });

  it("repeated tool error: the fourth call gets a refusal, not another failure from the tool", async () => {
    const run = await runReplay(loadReplayFixture("09-tool-error-repeated"));
    const results = toolResults(run, 5);

    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map(contentOf)).toEqual([
      expect.stringContaining("Attempt 1/3"),
      expect.stringContaining("Attempt 2/3"),
      expect.stringContaining("Attempt 3/3"),
    ]);
    expect(contentOf(results[3])).toContain('"get_filing" failed 3 times in a row');
    expect(contentOf(results[3])).not.toContain("SEC EDGAR");
  });

  it("max iterations: the final request forbids tools, says why, and the user is warned once", async () => {
    const run = await runReplay(loadReplayFixture("10-max-iterations"));
    const last = request(run, 3);

    expect(last.tool_choice).toBe("none");
    expect(last.messages.at(-1)?.role).toBe("user");
    expect(contentOf(last.messages.at(-1))).toContain("Do not call tools");
    // Both tool results are still in front of the model for the final answer.
    expect(toolResults(run, 3).map(contentOf)).toEqual([
      expect.stringContaining("note about rates"),
      expect.stringContaining("note about housing"),
    ]);
    expect(finalizeReasons(run)).toEqual(["STEP_LIMIT"]);
  });

  it("max iterations, model asks for a tool anyway: the answer is built from the results already gathered", async () => {
    const run = await runReplay(loadReplayFixture("11-final-pass-tool-call"));

    expect(run.result?.text).toContain("note about rates");
    expect(run.result?.text).toContain("note about housing");
    expect(run.streamedText.join("")).toBe(run.result?.text);
    expect(finalizeReasons(run)).toEqual(["STEP_LIMIT"]);
  });

  it("cancel mid-stream: the user saw the text streamed before the cancel, and the loop asks the model nothing more", async () => {
    const run = await runReplay(loadReplayFixture("12-cancel-mid-stream"));

    expect(run.problems).toEqual([]);
    expect(run.streamedText).toEqual(["AAPL is trad"]);
    expect(run.modelRequests).toHaveLength(2);
    expect(finalizeReasons(run)).toEqual([]);
  });

  // Regression (fixed 2026-11-18): the provider ends its stream cleanly on cancel (vllm.ts returns
  // on AbortError) and the loop did not re-check the signal, so the cut-off text came back as a
  // completed answer with answerSource "model".
  it("cancel mid-stream: the cut-off text is not reported as a completed answer", async () => {
    const run = await runReplay(loadReplayFixture("12-cancel-mid-stream"));

    expect(run.outcome).toBe("cancelled");
    expect(run.result).toBeUndefined();
  });

  it("cancel during a tool: the abandoned call's result is never sent to the model", async () => {
    const run = await runReplay(loadReplayFixture("13-cancel-during-tool"));

    expect(run.outcome).toBe("cancelled");
    expect(run.error?.name).toBe("AbortError");
    expect(run.modelRequests).toHaveLength(1);
    expect(run.streamedText).toEqual([]);
  });

  it("provider retry: the retried request repeats the same conversation", async () => {
    const run = await runReplay(loadReplayFixture("14-provider-retry"));

    expect(request(run, 2).messages).toEqual(request(run, 1).messages);
  });

  it("repeated identical call: the repeats are refused with a reason and the final request forbids tools", async () => {
    const run = await runReplay(loadReplayFixture("15-repeated-tool-call"));
    const results = toolResults(run, 4);

    expect(results).toHaveLength(3);
    expect(contentOf(results[0])).toContain("note about rates");
    expect(contentOf(results[2])).toContain("Repeated tool call limit reached");
    expect(request(run, 4).tool_choice).toBe("none");
    expect(finalizeReasons(run)).toEqual(["repeated_tool_call:search_notes"]);
  });

  it("empty reply: the model is nudged once before the loop gives up and asks for a final answer", async () => {
    const run = await runReplay(loadReplayFixture("16-empty-reply"));

    expect(request(run, 2).messages.length).toBeGreaterThan(request(run, 1).messages.length);
    expect(request(run, 2).messages.at(-1)?.role).toBe("user");
    expect(request(run, 2).tool_choice).not.toBe("none");
    expect(finalizeReasons(run)).toEqual(["EMPTY_REPLY"]);
  });

  it("provider down: the failure names the provider's error and nothing is streamed as an answer", async () => {
    const run = await runReplay(loadReplayFixture("17-provider-down"));

    expect(run.outcome).toBe("failed");
    expect(run.error?.message).toContain("server overloaded, retry later");
    expect(run.streamedText).toEqual([]);
    expect(finalizeReasons(run)).toEqual(["PROVIDER_ERROR"]);
  });
});
