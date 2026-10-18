/**
 * Contract for the LAS core loop (documentation/chapters/40-core-loop-onion-refactor-plan-2026-10-17.md §4–4c).
 *
 * The loop: call model → run tool calls → append paired results → repeat; stop when a reply has
 * no tool calls. Every budget (steps, tokens, soft deadline) ends in one final toolless turn, so a
 * run always finishes with an answer unless the caller cancels or the provider is down for good.
 */
import type { ChatMessage } from "../../types/ProviderTypes.ts";
import type { StreamChunk } from "../../types/provider.ts";

export interface CoreToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type CoreToolErrorCode =
  | "TOOL_THREW"
  | "TOOL_TIMEOUT"
  | "TOOL_CANCELLED"
  | "TOOL_DENIED"
  | "TOOL_NOT_FOUND"
  | "TOOL_BAD_ARGS"
  | "REPLY_CUT_OFF"
  | "TOOL_REPEATED_FAILURE";

/** Exactly one per CoreToolCall, appended in call order (invariant I3). */
export interface CoreToolResult {
  toolCallId: string;
  name: string;
  /** What the model sees. Capped: errors at `toolErrorCap`, outputs at `toolOutputCap` (I7). */
  content: string;
  isError: boolean;
  errorCode?: CoreToolErrorCode;
  durationMs: number;
}

export interface CoreToolContext {
  toolCallId: string;
  /** Aborts on run cancel, hard deadline, or this tool's own timeout. */
  signal: AbortSignal;
}

export interface CoreTool {
  name: string;
  description: string;
  /** JSON schema (type: "object"). Args are validated against `required` and property `type`s. */
  parameters: Record<string, unknown>;
  /** Overrides `defaultToolTimeoutMs`. */
  timeoutMs?: number;
  /** Runs alone, after the parallel batch, in call order. */
  exclusive?: boolean;
  execute(args: Record<string, unknown>, context: CoreToolContext): Promise<unknown>;
}

/** The tool list the provider sees. Built once per run, sorted by name (I4). */
export interface CoreToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CoreModelRequest {
  messages: ChatMessage[];
  tools: CoreToolSchema[];
  toolChoice: "auto" | "none";
  signal: AbortSignal;
  /** True only for the final toolless pass; the adapter lets the token budget spend its reserve. */
  finalPass: boolean;
}

/**
 * A model call. Adapters wrap an LAS provider's `generateTextStream`.
 * Chunks used by the loop: string (text), {type:"thinking"}, {type:"toolCall"},
 * {type:"usage"}, {type:"stopReason", stopReason:"length"}. Others are ignored.
 * Throwing an error with `code: "TOKEN_BUDGET_FINALIZE"` asks the loop to finalize.
 */
export type CoreModel = (request: CoreModelRequest) => AsyncIterable<StreamChunk>;

export type CoreFinalizeReason =
  | "STEP_LIMIT"
  | "DEADLINE_SOFT"
  | "TOKEN_BUDGET"
  | "EMPTY_REPLY"
  | "PROVIDER_ERROR"
  | "CUT_OFF_TWICE";

export type CoreBeforeToolDecision =
  | { action: "allow"; args?: Record<string, unknown> }
  | { action: "deny"; reason: string };

export interface CoreLoopHooks {
  /** Run in order before every model call (date, app context, compaction). Must not change `tools`. */
  beforeModelCall?: Array<(messages: ChatMessage[], step: number) => ChatMessage[] | Promise<ChatMessage[]>>;
  /** Run in order; first deny wins. A throwing hook counts as deny (I2). */
  beforeToolCall?: Array<(call: CoreToolCall, signal: AbortSignal) => CoreBeforeToolDecision | Promise<CoreBeforeToolDecision>>;
  /** Run in order on every result, errors included; may rewrite content/flags. A throwing hook leaves the result unchanged. */
  afterToolCall?: Array<(call: CoreToolCall, result: CoreToolResult) => CoreToolResult | Promise<CoreToolResult>>;
}

export interface CoreLoopOptions {
  model: CoreModel;
  tools: CoreTool[];
  messages: ChatMessage[];
  signal: AbortSignal;
  /** Aborted when the run should stop working and answer now (e.g. soft deadline). Cuts the in-flight non-final model turn and tool batch; the loop then runs the final pass. The final pass uses only `signal`. */
  finalizeSignal?: AbortSignal;
  hooks?: CoreLoopHooks;
  /** Model calls before forcing the final pass (the final pass itself is extra). */
  maxSteps: number;
  /** Polled before each model call; non-null forces the final pass. Soft deadline lives here. */
  shouldFinalize?: () => CoreFinalizeReason | null;
  /** Default 60_000. */
  defaultToolTimeoutMs?: number;
  /** Default 16_000 chars, head + tail with a cut note. */
  toolOutputCap?: number;
  /** Default 2_048 chars. */
  toolErrorCap?: number;
  /** Retries of a failed model call before finalizing. Default 2. */
  providerRetries?: number;
  /** Same tool failing this many times in a row gets TOOL_REPEATED_FAILURE instead of running. Default 3. */
  maxConsecutiveToolErrors?: number;
  /** Injected clock for durations; default Date.now. */
  now?: () => number;
  /** Max time for the toolless final pass; on expiry the loop answers with streamed partial text or the synthetic fallback. Undefined = no limit. */
  finalPassTimeoutMs?: number;
  /** Test seam: builds the final-pass timeout signal; default `AbortSignal.timeout(ms)`. */
  finalPassSignalFor?: (ms: number) => AbortSignal;
  /** Builds each tool's timeout signal; default `AbortSignal.timeout(ms)`. Tests inject controllable signals. */
  timeoutSignalFor?: (toolName: string, ms: number) => AbortSignal;
}

export type CoreLoopEvent =
  | { type: "model.start"; step: number; finalPass: boolean }
  | { type: "text.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "tool.start"; call: CoreToolCall }
  | { type: "tool.end"; call: CoreToolCall; result: CoreToolResult }
  | { type: "finalize"; reason: CoreFinalizeReason }
  | { type: "warning"; code: string; message: string };

export interface CoreLoopResult {
  status: "completed" | "cancelled" | "failed";
  /** Final assistant text; non-empty whenever status is "completed" (I1). */
  text: string;
  /** Input messages plus everything the loop appended, tool pairs intact. */
  messages: ChatMessage[];
  modelCalls: number;
  toolCalls: number;
  finalizeReason?: CoreFinalizeReason;
  /** "synthetic" when the final pass returned nothing and the loop summarized tool results. */
  answerSource: "model" | "synthetic";
  error?: { code: string; message: string };
}

export interface ToolBatchOptions {
  tools: ReadonlyMap<string, CoreTool>;
  hooks?: CoreLoopHooks;
  signal: AbortSignal;
  defaultToolTimeoutMs: number;
  toolOutputCap: number;
  toolErrorCap: number;
  maxConsecutiveToolErrors: number;
  /** Per-tool consecutive error count, owned by the loop, mutated by the runner across batches. */
  failureStreak: Map<string, number>;
  now: () => number;
  timeoutSignalFor?: (toolName: string, ms: number) => AbortSignal;
}

/**
 * Runs one batch. Never throws (I2). Returns exactly one result per call, in call order (I3).
 * Non-exclusive tools run in parallel; exclusive ones run after, one at a time. Implemented in ToolRunner.ts.
 */
export type RunToolBatch = (calls: CoreToolCall[], options: ToolBatchOptions) => Promise<CoreToolResult[]>;

/** `runCoreLoop(options)` yields events and returns the result. Implemented in CoreLoop.ts. */
export type RunCoreLoop = (options: CoreLoopOptions) => AsyncGenerator<CoreLoopEvent, CoreLoopResult>;
