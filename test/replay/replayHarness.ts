/**
 * Transcript replay harness for the core loop.
 *
 * A fixture is a recorded conversation with the model server: the HTTP replies the provider
 * gave, turn by turn, in the OpenAI-compatible `chat.completion.chunk` SSE shape that vLLM
 * serves. `runReplay` serves those replies from a loopback HTTP server and runs the REAL stack
 * against it: `createVllmProvider` (fetch + SSE parsing) -> `runCoreLoopForRun` -> `runCoreLoop`
 * -> `runToolBatch`. Only two things are replaced: the model server (the fixture's turns) and
 * the tool implementations (the fixture's canned replies).
 *
 * The harness reports what happened; it asserts nothing. Anything the fixture did not foresee
 * (an extra provider request, a tool call with no reply left) is listed in `problems`.
 */
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCoreLoopForRun, type RunsAdapterContext } from "../../src/core/loop/RunsAdapter.ts";
import type { CoreLoopResult } from "../../src/core/loop/types.ts";
import { createVllmProvider } from "../../src/providers/vllm.ts";

// Fixture schemas are strict: a misspelt key in a fixture is an error, not a silently ignored field.

const ReplayTurnSchema = z.strictObject({
  /** `chat.completion.chunk` objects, each sent as one SSE `data:` frame. A string is sent verbatim as a frame. */
  chunks: z.array(z.unknown()).optional(),
  /** A non-200 reply (with `body` as JSON) instead of a stream. */
  status: z.number().int().optional(),
  body: z.unknown().optional(),
  /**
   * Cancellation mid-stream: the chunks are sent and the stream is left open; the run is
   * cancelled as soon as the loop has passed text from this turn on to the user.
   */
  cancelRunAfterChunks: z.boolean().optional(),
});

const ReplayToolReplySchema = z.strictObject({
  result: z.unknown().optional(),
  /** The tool throws an Error with this message. */
  throw: z.string().optional(),
  /** The run is cancelled while this tool call is in flight. */
  cancelRun: z.boolean().optional(),
});

const ReplayToolSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  /** Consumed in order, one per execution of this tool. */
  replies: z.array(ReplayToolReplySchema),
});

const ExecutedCallSchema = z.strictObject({ name: z.string(), args: z.record(z.string(), z.unknown()) });
const OutcomeSchema = z.enum(["completed", "cancelled", "failed"]);

const ReplayExpectationSchema = z.strictObject({
  outcome: OutcomeSchema,
  /** Tool executions in order: what actually ran, with the arguments it received. */
  toolCalls: z.array(ExecutedCallSchema),
  /** Number of HTTP requests the loop sent to the model server. */
  modelRequests: z.number().int(),
  text: z.string().optional(),
  /** `null` means the run must end without a forced finalize. */
  finalizeReason: z.string().nullable().optional(),
  answerSource: z.enum(["model", "partial", "synthetic"]).optional(),
  providerRetries: z.number().int().optional(),
});

const ReplayFixtureSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  /** Where the transcript came from. */
  source: z.string(),
  model: z.string(),
  input: z.string(),
  maxIterations: z.number().int().optional(),
  /**
   * Set when the loop does NOT yet behave as `expect` describes. The text names the defect; the
   * replay test then expects the fixture to fail and reports when it starts passing.
   */
  knownDefect: z.string().optional(),
  tools: z.array(ReplayToolSchema),
  turns: z.array(ReplayTurnSchema),
  expect: ReplayExpectationSchema,
});

export type ReplayTurn = z.infer<typeof ReplayTurnSchema>;
export type ReplayFixture = z.infer<typeof ReplayFixtureSchema>;
export type ExecutedCall = z.infer<typeof ExecutedCallSchema>;

// What the loop sends to the model server (OpenAI-compatible chat completion request). Loose:
// the provider adds sampling fields this harness has no opinion on.

const WireMessageSchema = z.looseObject({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(z.looseObject({ id: z.string(), type: z.literal("function"), function: z.strictObject({ name: z.string(), arguments: z.string() }) }))
    .optional(),
});

const WireRequestSchema = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(WireMessageSchema),
  tools: z.array(z.looseObject({ type: z.literal("function"), function: z.looseObject({ name: z.string() }) })).optional(),
  tool_choice: z.string().optional(),
});

export type WireMessage = z.infer<typeof WireMessageSchema>;
export type WireRequest = z.infer<typeof WireRequestSchema>;

/** The `data` of a `run.warning` event the adapter emits. */
const WarningSchema = z.looseObject({ code: z.string(), reason: z.string().optional(), message: z.string().optional() });
export type ReplayWarning = z.infer<typeof WarningSchema>;

export interface ReplayError {
  name?: string;
  code?: string | number;
  message?: string;
}

export interface ReplayRun {
  outcome: z.infer<typeof OutcomeSchema>;
  result?: CoreLoopResult;
  error?: ReplayError;
  toolCalls: ExecutedCall[];
  /** Every request the loop sent to the model server, in order. */
  modelRequests: WireRequest[];
  /** The answer text streamed to the user, in order. */
  streamedText: string[];
  /** `run.warning` events emitted to the user, in order. */
  warnings: ReplayWarning[];
  unusedTurns: number;
  problems: string[];
}

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

function readFixture(file: string): ReplayFixture {
  const parsed = ReplayFixtureSchema.safeParse(JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")));
  if (!parsed.success) throw new Error(`replay fixture ${file} is not a valid fixture:\n${z.prettifyError(parsed.error)}`);
  if (`${parsed.data.id}.json` !== file) throw new Error(`replay fixture ${file} has id "${parsed.data.id}"; the id must match the file name`);
  return parsed.data;
}

export function loadReplayFixtures(): ReplayFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(readFixture);
}

export function loadReplayFixture(id: string): ReplayFixture {
  return readFixture(`${id}.json`);
}

/** Serves the fixture's turns as the model server. Returns the base URL and what it recorded. */
async function startModelServer(turns: ReplayTurn[], onOpenStream: () => void, problems: string[]) {
  const requests: WireRequest[] = [];
  const remaining = [...turns];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      raw += part;
    });
    request.on("end", () => {
      const turn = request.method === "POST" && request.url === "/v1/chat/completions" ? remaining.shift() : undefined;
      if (!turn) {
        problems.push(`model server got a request the fixture has no turn for: ${request.method} ${request.url}`);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "replay fixture has no turn for this request" } }));
        return;
      }
      const body = WireRequestSchema.safeParse(JSON.parse(raw));
      if (!body.success) {
        problems.push(`the loop sent the model server a request that is not a chat completion request:\n${z.prettifyError(body.error)}`);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "replay harness rejected the request body" } }));
        return;
      }
      requests.push(body.data);
      if (turn.status !== undefined) {
        response.writeHead(turn.status, { "content-type": "application/json" });
        response.end(JSON.stringify(turn.body ?? {}));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frames = (turn.chunks ?? [])
        .map((chunk) => (typeof chunk === "string" ? `${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`))
        .join("");
      if (turn.cancelRunAfterChunks) {
        // The stream stays open: the client is mid-read when the run is cancelled.
        response.write(frames, onOpenStream);
        return;
      }
      response.end(`${frames}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("replay model server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    unusedTurns: () => remaining.length,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function describeError(thrown: unknown): ReplayError {
  if (!(thrown instanceof Error)) return { message: String(thrown) };
  const code = "code" in thrown && (typeof thrown.code === "string" || typeof thrown.code === "number") ? thrown.code : undefined;
  return { name: thrown.name, code, message: thrown.message };
}

/** Runs one fixture through the real provider and core loop and reports what happened. */
export async function runReplay(fixture: ReplayFixture): Promise<ReplayRun> {
  const run = new AbortController();
  const problems: string[] = [];
  const toolCalls: ExecutedCall[] = [];
  const streamedText: string[] = [];
  const warnings: ReplayWarning[] = [];
  const replies = new Map(fixture.tools.map((tool) => [tool.name, [...tool.replies]]));
  // Mid-stream cancellation: armed when the model server has sent the turn's chunks, fired when
  // the loop has streamed text from that turn to the user (so the cancel lands mid-answer, not
  // before the loop has read anything). A loop that streams no text from that turn never
  // cancels, and the replay ends at the test's own timeout.
  let cancelOnNextText = false;
  const server = await startModelServer(
    fixture.turns,
    () => {
      cancelOnNextText = true;
    },
    problems,
  );

  const context: RunsAdapterContext = {
    options: { maxIterations: fixture.maxIterations },
    messages: [{ role: "user", content: fixture.input }],
    provider: createVllmProvider(server.baseUrl),
    resolvedModel: fixture.model,
    signal: run.signal,
    runtimeTools: {
      finalTools: fixture.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    },
    runtimeToolExecutor: async (call) => {
      toolCalls.push({ name: call.name, args: call.args });
      const reply = replies.get(call.name)?.shift();
      if (!reply) {
        problems.push(`tool "${call.name}" was executed but the fixture has no reply left for it`);
        throw new Error("replay fixture has no reply for this tool call");
      }
      if (reply.cancelRun) {
        run.abort();
        return new Promise<never>(() => {}); // in flight forever; the runner abandons it on cancel
      }
      if (reply.throw !== undefined) throw new Error(reply.throw);
      return reply.result;
    },
    emit: (event) => {
      if (event.type === "run.warning") {
        const warning = WarningSchema.safeParse(event.data);
        if (warning.success) warnings.push(warning.data);
        else problems.push(`run.warning event without a code: ${JSON.stringify(event.data)}`);
      }
      if (event.type !== "chunk") return;
      streamedText.push(event.content ?? "");
      if (cancelOnNextText) {
        cancelOnNextText = false;
        run.abort();
      }
    },
  };

  const base = { toolCalls, streamedText, warnings, problems, modelRequests: server.requests };
  try {
    const { result } = await runCoreLoopForRun(context);
    return { ...base, outcome: "completed", result, unusedTurns: server.unusedTurns() };
  } catch (thrown) {
    const error = describeError(thrown);
    const cancelled = error.name === "AbortError" || error.code === "RUN_CANCELLED";
    return { ...base, outcome: cancelled ? "cancelled" : "failed", error, unusedTurns: server.unusedTurns() };
  } finally {
    await server.close();
  }
}
