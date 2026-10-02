import { sleep, roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
// ─── Custom LLM Accuracy Benchmarking ───────────────────────
import crypto from "crypto";
import { handleConversation, handleAgent } from "../routes/ChatRoutes.ts";
import { MODELS, MODEL_TYPES, getModelByName } from "../config.ts";
import { getProvider } from "../providers/index.ts";
import { isInstance } from "../providers/instance-registry.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import type { SseEvent } from "../types/SseTypes.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const BENCHMARKS_COLLECTION = COLLECTIONS.BENCHMARKS;
const RUNS_COLLECTION = COLLECTIONS.BENCHMARK_RUNS;

// In-memory counter: how many benchmark model calls are actively generating
let activeGenerationCount = 0;

// ── Types ────────────────────────────────────────────────────

interface Assertion {
  expectedValue: string;
  matchMode?: string;
}

interface AgentAssertion {
  type: string;
  operator?: string;
  operand?: string;
}

interface BenchmarkDoc {
  id: string;
  name: string;
  prompt: string;
  systemPrompt?: string | null;
  expectedValue?: string;
  matchMode?: string;
  benchmarkMode?: "model" | "agent" | "combined";
  assertions?: Assertion[];
  assertionOperator?: "AND" | "OR";
  agentAssertions?: AgentAssertion[];
  agentAssertionOperator?: "AND" | "OR";
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
  [key: string]: unknown;
}

interface ModelTarget {
  provider: string;
  model: string;
  label?: string;
  display_name?: string;
  thinkingEnabled?: boolean;
  toolsEnabled?: boolean;
  agent?: string;
}

interface ModelEntry {
  provider: string;
  model: string;
  label: string;
  thinkingEnabled: boolean;
  toolsEnabled: boolean;
  agent?: string;
}

interface BenchmarkEvent {
  type: string;
  content?: string;
  message?: string;
  status?: string;
  usage?: Record<string, number>;
  estimatedCost?: number | null;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  tool?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
    result?: unknown;
  };
  [key: string]: unknown;
}

interface ModelResult {
  provider: string;
  model: string;
  label: string;
  thinkingEnabled: boolean;
  toolsEnabled: boolean;
  agent?: string;
  response: string | null;
  thinking: string | null;
  toolCalls?: ToolCallResult[] | null;
  passed: boolean;
  matchMode: string;
  turnCount?: number;
  latency: number;
  usage: Record<string, number> | null;
  estimatedCost: number | null;
  error: string | null;
  completedAt: string;
}

interface ToolCallResult {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status: string;
}

interface RunBenchmarkCallbacks {
  onRunStart?: (info: { totalModels: number }) => void;
  onModelStart?: (model: ModelEntry & { isLocal: boolean }) => void;
  onModelComplete?: (result: ModelResult) => void;
  onEvent?: (event: BenchmarkEvent) => void;
  signal?: AbortSignal;
}

interface BenchmarkCreateData {
  name: string;
  prompt: string;
  systemPrompt?: string | null;
  expectedValue?: string;
  matchMode?: string;
  benchmarkMode?: string;
  assertions?: Assertion[];
  assertionOperator?: string;
  agentAssertions?: AgentAssertion[];
  agentAssertionOperator?: string;
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
}

// ─── evaluate model response against expected value ─────────
const MATCH_MODES = {
  CONTAINS: "contains",
  EXACT: "exact",
  STARTS_WITH: "startsWith",
  REGEX: "regex",
} as const;

type MatchMode = (typeof MATCH_MODES)[keyof typeof MATCH_MODES];

function evaluate(
  response: string,
  expected: string,
  matchMode: MatchMode | string = MATCH_MODES.CONTAINS,
): boolean {
  if (!response || !expected) return false;
  const norm = (s: string) => s.trim().toLowerCase();
  switch (matchMode) {
    case MATCH_MODES.EXACT:
      return norm(response) === norm(expected);
    case MATCH_MODES.STARTS_WITH:
      return norm(response).startsWith(norm(expected));
    case MATCH_MODES.REGEX: {
      try {
        const regex = new RegExp(expected, "i");
        return regex.test(response);
      } catch {
        logger.warn(`[benchmark] Invalid regex: ${expected}`);
        return false;
      }
    }
    case MATCH_MODES.CONTAINS:
    default:
      return norm(response).includes(norm(expected));
  }
}
function evaluateAssertions(
  response: string,
  benchmark: BenchmarkDoc,
): boolean {
  const assertions = benchmark.assertions;
  if (!assertions || assertions.length === 0) {
    return false;
  }
  const operator = benchmark.assertionOperator || "AND";
  if (operator === "OR") {
    // Disjunction: ANY assertion must pass
    return assertions.some((assertion) =>
      evaluate(
        response,
        assertion.expectedValue,
        assertion.matchMode || MATCH_MODES.CONTAINS,
      ),
    );
  }
  // Conjunction (AND): ALL assertions must pass
  return assertions.every((assertion) =>
    evaluate(
      response,
      assertion.expectedValue,
      assertion.matchMode || MATCH_MODES.CONTAINS,
    ),
  );
}
// ─── behavioral assertions ──────────────────────────────────
const COMPARATORS: Record<
  string,
  (firstValue: number, secondValue: number) => boolean
> = {
  gte: (firstValue, secondValue) => firstValue >= secondValue,
  lte: (firstValue, secondValue) => firstValue <= secondValue,
  gt: (firstValue, secondValue) => firstValue > secondValue,
  lt: (firstValue, secondValue) => firstValue < secondValue,
  eq: (firstValue, secondValue) => firstValue === secondValue,
};

interface ExecutionData {
  response: string | null;
  thinking: string | null;
  toolCalls: ToolCallResult[];
  turnCount: number;
}

function evaluateSingleAgentAssertion(
  assertion: AgentAssertion,
  executionData: ExecutionData,
): boolean {
  const { type, operator, operand } = assertion;
  switch (type) {
    case "replied":
      return (
        !!executionData.response && executionData.response.trim().length > 0
      );
    case "used_tool_calls": {
      const count = executionData.toolCalls?.length || 0;
      const target = parseInt(operand || "", 10);
      if (isNaN(target)) return count > 0; // Fallback: any tool calls
      const compareFunction = COMPARATORS[operator || "gte"];
      return compareFunction ? compareFunction(count, target) : count >= target;
    }
    case "thought":
      return (
        !!executionData.thinking && executionData.thinking.trim().length > 0
      );
    case "max_turns": {
      const turns = executionData.turnCount || 1;
      const limit = parseInt(operand || "", 10);
      if (isNaN(limit)) return true; // No limit specified
      const compareFunction = COMPARATORS[operator || "lte"];
      return compareFunction ? compareFunction(turns, limit) : turns <= limit;
    }
    default:
      logger.warn(`[benchmark] Unknown agent assertion type: ${type}`);
      return false;
  }
}
function evaluateAgentAssertions(
  benchmark: BenchmarkDoc,
  executionData: ExecutionData,
): boolean {
  const assertions = benchmark.agentAssertions;
  if (!assertions || assertions.length === 0) {
    return true; // No agent assertions = pass by default
  }
  const operator = benchmark.agentAssertionOperator || "AND";
  if (operator === "OR") {
    return assertions.some((assertion) =>
      evaluateSingleAgentAssertion(assertion, executionData),
    );
  }
  return assertions.every((assertion) =>
    evaluateSingleAgentAssertion(assertion, executionData),
  );
}
// ─── list available conversation models ─────────────────────
/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
function getConversationModels(): ModelEntry[] {
  const results: ModelEntry[] = [];
  for (const model of Object.values(MODELS)) {
    if (model.modelType !== MODEL_TYPES.CONVERSATION) continue;
    if ((model as Record<string, unknown>).listed === false) continue;
    // Skip image-only output models (no text output)
    if (!model.outputTypes?.includes("text")) continue;
    // Skip image API models (generate images, not text completions)
    if ((model as Record<string, unknown>).imageAPI) continue;
    results.push({
      provider: model.provider,
      model: model.name,
      label: model.label,
      thinkingEnabled: false,
      toolsEnabled: false,
    });
  }
  return results;
}
/**
 * Filter a model list to only those whose providers are actually
 * reachable (have API keys configured / servers running).
 * For cloud providers we check if getProvider() doesn't throw.
 * For local providers we also do a quick health check.
 */
function filterAvailableModels(models: ModelEntry[]): ModelEntry[] {
  const checked = new Map<string, boolean>();
  return models.filter((model) => {
    if (checked.has(model.provider)) return checked.get(model.provider);
    try {
      getProvider(model.provider);
      checked.set(model.provider, true);
      return true;
    } catch {
      checked.set(model.provider, false);
      return false;
    }
  });
}
// ─── Run a single model against a benchmark prompt ──────────
export async function runSingleModel(
  benchmark: BenchmarkDoc,
  model: ModelEntry,
  project: string | null,
  username: string,
  {
    signal,
    onEvent,
  }: { signal?: AbortSignal; onEvent?: (event: BenchmarkEvent) => void } = {},
): Promise<ModelResult> {
  // Config flags carried on every result for stats differentiation
  const configFlags = {
    thinkingEnabled: model.thinkingEnabled || false,
    toolsEnabled: model.toolsEnabled || false,
    ...(model.agent && { agent: model.agent }),
  };
  // Bail immediately if already aborted
  if (signal?.aborted) {
    logger.info(
      `[benchmark] ⏭ Skipping ${model.provider}/${model.model} — already aborted`,
    );
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: null,
      thinking: null,
      passed: false,
      matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
      latency: 0,
      usage: null,
      estimatedCost: null,
      error: "Aborted",
      completedAt: new Date().toISOString(),
    };
  }
  const start = performance.now();
  const messages: Array<{ role: string; content: string }> = [];
  // Optional system prompt
  if (benchmark.systemPrompt) {
    messages.push({ role: "system", content: benchmark.systemPrompt });
  }
  messages.push({ role: "user", content: benchmark.prompt });
  logger.info(`[benchmark] ▶ Running ${model.provider}/${model.model}`);
  try {
    const events: BenchmarkEvent[] = [];
    const handler =
      model.agent || model.toolsEnabled ? handleAgent : handleConversation;
    await handler(
      {
        provider: model.provider,
        model: model.model,
        messages,
        temperature: benchmark.temperature ?? 0,
        maxTokens: Math.max(benchmark.maxTokens ?? 2048, 2048),
        project,
        username,
        skipConversation: true,
        thinkingEnabled: model.thinkingEnabled || false,
        ...((model.agent || model.toolsEnabled) && {
          ...(model.agent && { agent: model.agent }),
          agenticLoopEnabled: true,
          autoApprove: true,
          maxIterations: 10,
        }),
        ...(model.toolsEnabled && {
          functionCallingEnabled: true,
          enabledTools: [TOOL_NAMES.CALCULATE_PRECISE],
        }),
      },
      (event: SseEvent) => {
        const benchmarkEvent = event as SseEvent & BenchmarkEvent;
        events.push(benchmarkEvent);
        // Forward chunk/thinking/tool events in real-time for live preview
        if (
          benchmarkEvent.type === "chunk" ||
          benchmarkEvent.type === "thinking" ||
          benchmarkEvent.type === "toolCall" ||
          benchmarkEvent.type === "tool_execution" ||
          benchmarkEvent.type === "tool_output"
        ) {
          if (onEvent) {
            try {
              onEvent(benchmarkEvent);
            } catch {
              /* noop */
            }
          }
        }
        // Log every event for debugging
        if (benchmarkEvent.type === "chunk") {
          logger.info(
            `[benchmark]   📦 ${model.model} chunk (${benchmarkEvent.content?.length || 0} chars)`,
          );
        } else if (benchmarkEvent.type === "error") {
          logger.error(
            `[benchmark]   ❌ ${model.model} error: ${benchmarkEvent.message}`,
          );
        } else if (benchmarkEvent.type === "done") {
          logger.info(
            `[benchmark]   ✅ ${model.model} done — usage: ${JSON.stringify(benchmarkEvent.usage || null)}, cost: ${benchmarkEvent.estimatedCost ?? "N/A"}`,
          );
        } else {
          logger.info(
            `[benchmark]   📨 ${model.model} event: ${benchmarkEvent.type}`,
          );
        }
      },
      { signal },
    );
    const latency = (performance.now() - start) / 1000;
    // Log all event types received
    const eventTypes = events.map((e) => e.type);
    logger.info(
      `[benchmark] ◀ ${model.model} finished in ${latency.toFixed(2)}s — events: [${eventTypes.join(", ")}]`,
    );
    // Check for errors
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      logger.warn(
        `[benchmark]   ⚠ ${model.model} returned error event: ${errorEvent.message}`,
      );
      return {
        provider: model.provider,
        model: model.model,
        label: model.label,
        ...configFlags,
        response: null,
        thinking: null,
        passed: false,
        matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
        latency: roundMilliseconds(latency),
        usage: null,
        estimatedCost: null,
        error: errorEvent.message || "Unknown error",
        completedAt: new Date().toISOString(),
      };
    }
    // Extract text response
    const text = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content)
      .join("");
    if (!text) {
      logger.warn(
        `[benchmark]   ⚠ ${model.model} produced NO text — chunk count: ${events.filter((e) => e.type === "chunk").length}, all events: ${JSON.stringify(eventTypes)}`,
      );
    }
    const doneEvent =
      events.find((e) => e.type === "done") || ({} as BenchmarkEvent);
    const matchMode = benchmark.matchMode || MATCH_MODES.CONTAINS;
    // Extract thinking content (emitted as type: "thinking")
    const thinkingText = events
      .filter((e) => e.type === "thinking")
      .map((e) => e.content)
      .join("");
    // Extract tool calls from both event paths:
    // - "toolCall" with status "done" — native MCP path (e.g. LM Studio)
    // - "tool_execution" with status "done" — standard agentic path (cloud providers)
    const nativeToolCalls: ToolCallResult[] = events
      .filter((e) => e.type === "toolCall" && e.status === "done")
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        result: toolCall.result,
        status: "done",
      }));
    const agenticToolCalls: ToolCallResult[] = events
      .filter(
        (e) =>
          e.type === "tool_execution" &&
          (e.status === "done" || e.status === "error"),
      )
      .map((e) => ({
        id: e.tool?.id,
        name: e.tool?.name,
        args: e.tool?.args,
        result: e.tool?.result,
        status: e.status || "done",
      }));
    const toolCalls = [...nativeToolCalls, ...agenticToolCalls];
    const toolCallsResult = toolCalls.length > 0 ? toolCalls : null;
    // Count agentic loop turns (each chunk of tool calls + response = 1 turn)
    // A turn is roughly: user→model→(tools)→model. Count "done" events as turn markers.
    const turnCount = events.filter((e) => e.type === "done").length || 1;
    // ── Mode-aware pass/fail evaluation ──────────────────────
    const mode = benchmark.benchmarkMode || "model";
    let passed: boolean;
    if (mode === "agent") {
      // Agent mode: only behavioral assertions
      passed = evaluateAgentAssertions(benchmark, {
        response: text,
        thinking: thinkingText,
        toolCalls,
        turnCount,
      });
    } else if (mode === "combined") {
      // Combined mode: both text + behavioral assertions must pass
      const textPassed = evaluateAssertions(text, benchmark);
      const agentPassed = evaluateAgentAssertions(benchmark, {
        response: text,
        thinking: thinkingText,
        toolCalls,
        turnCount,
      });
      passed = textPassed && agentPassed;
    } else {
      // Model mode (default): text assertions only
      passed = evaluateAssertions(text, benchmark);
    }
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: text || null,
      thinking: thinkingText || null,
      toolCalls: toolCallsResult,
      passed,
      matchMode,
      turnCount,
      latency: roundMilliseconds(latency),
      usage: (doneEvent.usage as Record<string, number>) || null,
      estimatedCost: (doneEvent.estimatedCost as number) ?? null,
      error: null,
      completedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    const latency = (performance.now() - start) / 1000;
    logger.error(
      `[benchmark]   💥 ${model.model} threw: ${getErrorMessage(error)}`,
    );
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: null,
      thinking: null,
      passed: false,
      matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
      latency: roundMilliseconds(latency),
      usage: null,
      estimatedCost: null,
      error: getErrorMessage(error),
      completedAt: new Date().toISOString(),
    };
  }
}
// ─── public API ─────────────────────────────────────────────
const BenchmarkService = {
  MATCH_MODES,
  evaluate,
  getConversationModels,
  /** Number of benchmark model calls currently in-flight. */
  get activeGenerationCount() {
    return activeGenerationCount;
  },
  async runBenchmark(
    benchmark: BenchmarkDoc,
    modelTargets: ModelTarget[] | null,
    project: string | null,
    username: string,
    {
      onRunStart,
      onModelStart,
      onModelComplete,
      onEvent,
      signal,
    }: RunBenchmarkCallbacks = {},
  ) {
    // Resolve target models
    let models: ModelEntry[];
    if (modelTargets && modelTargets.length > 0) {
      // Validate and enrich with labels
      models = modelTargets.map((tool) => {
        const modelDefinition = getModelByName(tool.model);
        return {
          provider: tool.provider,
          model: tool.model,
          label: tool.display_name || modelDefinition?.label || tool.model,
          thinkingEnabled: tool.thinkingEnabled || false,
          toolsEnabled: tool.toolsEnabled || false,
          ...(tool.agent && { agent: tool.agent }),
        };
      });
    } else {
      models = filterAvailableModels(getConversationModels());
    }
    if (models.length === 0) {
      throw new Error("No models available for benchmarking");
    }
    // Notify caller of total model count (used for live reconnection state)
    if (onRunStart) {
      try {
        onRunStart({ totalModels: models.length });
      } catch {
        /* noop */
      }
    }
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    logger.info(
      `[benchmark] Starting run ${runId} — "${benchmark.name}" against ${models.length} model(s)`,
    );
    // ── Instance-aware concurrent execution ─────────────────────
    // Cloud providers: all models under the same provider run sequentially
    // within a bucket, but different providers run concurrently.
    // Local providers: models are bucketed per instance (e.g. lm-studio,
    // lm-studio-2), and each instance runs up to its concurrency limit.
    // Two instances means two concurrent local inference streams.
    const INTRA_PROVIDER_DELAY_MS = 100;
    // Group models by provider; local providers use their instance ID as key
    const buckets = new Map<string, ModelEntry[]>();
    for (const model of models) {
      const key = model.provider; // Instance IDs are already unique (lm-studio, lm-studio-2, etc.)
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(model);
    }
    logger.info(
      `[benchmark] Executing across ${buckets.size} provider bucket(s): ${[...buckets.keys()].join(", ")}`,
    );
    // Each bucket runs its models sequentially; all buckets run concurrently.
    // The process-level GPU mutex (LocalModelQueue) still serializes at the
    // instance level, so concurrent benchmark runs and chat requests are safe.
    let aborted = false;
    const bucketPromises = [...buckets.entries()].map(
      async ([_key, bucketModels]) => {
        const bucketResults: ModelResult[] = [];
        for (let i = 0; i < bucketModels.length; i++) {
          // Check abort signal before each model
          if (signal?.aborted || aborted) {
            logger.info(`[benchmark] Aborting bucket — signal received`);
            break;
          }
          if (i > 0) await sleep(INTRA_PROVIDER_DELAY_MS);
          const model = bucketModels[i];
          if (onModelStart) {
            try {
              onModelStart({ ...model, isLocal: isInstance(model.provider) });
            } catch {
              /* noop */
            }
          }
          activeGenerationCount++;
          // Wrap onEvent to tag each event with the source model (enables
          // correct attribution when multiple provider buckets stream concurrently).
          const modelOnEvent = onEvent
            ? (event: BenchmarkEvent) =>
                onEvent({
                  ...event,
                  _sourceModel: {
                    provider: model.provider,
                    model: model.model,
                  },
                })
            : undefined;
          let result: ModelResult;
          try {
            result = await runSingleModel(benchmark, model, project, username, {
              signal,
              onEvent: modelOnEvent,
            });
          } finally {
            activeGenerationCount = Math.max(0, activeGenerationCount - 1);
          }
          if (signal?.aborted || aborted) {
            logger.info(
              `[benchmark] Aborting after model ${model.model} completed`,
            );
            // Still record this model's result even though we're stopping
            if (onModelComplete) {
              try {
                onModelComplete(result);
              } catch {
                /* noop */
              }
            }
            bucketResults.push(result);
            break;
          }
          if (onModelComplete) {
            try {
              onModelComplete(result);
            } catch {
              /* noop */
            }
          }
          bucketResults.push(result);
        }
        return bucketResults;
      },
    );
    // Listen for abort signal to propagate to all buckets
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
    }
    const bucketOutputs = await Promise.all(bucketPromises);
    const results = bucketOutputs.flat();
    const completedAt = new Date().toISOString();
    const wasAborted = signal?.aborted || aborted;
    const passed = results.filter(
      (benchmarkResult) => benchmarkResult.passed,
    ).length;
    const failed = results.filter(
      (benchmarkResult) => !benchmarkResult.passed && !benchmarkResult.error,
    ).length;
    const errored = results.filter(
      (benchmarkResult) => benchmarkResult.error,
    ).length;
    const totalCost = results.reduce(
      (sum, benchmarkResult) => sum + (benchmarkResult.estimatedCost || 0),
      0,
    );
    const run = {
      id: runId,
      benchmarkId: benchmark.id,
      project,
      models: results,
      aborted: wasAborted || false,
      summary: {
        total: results.length,
        passed,
        failed,
        errored,
        totalCost,
      },
      startedAt,
      completedAt,
    };
    // Persist run (even partial / aborted runs)
    if (results.length > 0) {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (db) {
        await db.collection(RUNS_COLLECTION).insertOne(run);
      }
    }
    logger.success(
      `[benchmark] Run ${runId} ${wasAborted ? "ABORTED" : "complete"} — ${passed}/${results.length} passed` +
        (errored > 0 ? `, ${errored} error(s)` : ""),
    );
    return run;
  },
  // ── CRUD Helpers ────────────────────────────────────────────
  async create(
    data: BenchmarkCreateData,
    project: string | null,
    username: string,
  ) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    const now = new Date().toISOString();
    const document = {
      id: crypto.randomUUID(),
      project,
      username,
      name: data.name,
      prompt: data.prompt,
      systemPrompt: data.systemPrompt || null,
      expectedValue: data.expectedValue,
      matchMode: data.matchMode || MATCH_MODES.CONTAINS,
      benchmarkMode: data.benchmarkMode || "model",
      assertions: data.assertions || [],
      assertionOperator: data.assertionOperator || "AND",
      agentAssertions: data.agentAssertions || [],
      agentAssertionOperator: data.agentAssertionOperator || "AND",
      temperature: data.temperature ?? 0,
      maxTokens: data.maxTokens ?? 256,
      tags: data.tags || [],
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(BENCHMARKS_COLLECTION).insertOne(document);
    return document;
  },
  async list(project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(BENCHMARKS_COLLECTION)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray();
  },
  async getById(id: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db.collection(BENCHMARKS_COLLECTION).findOne({ id, project });
  },
  async remove(id: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    await db.collection(BENCHMARKS_COLLECTION).deleteOne({ id, project });
    await db
      .collection(RUNS_COLLECTION)
      .deleteMany({ benchmarkId: id, project });
  },
  async getRuns(benchmarkId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(RUNS_COLLECTION)
      .find({ benchmarkId, project })
      .sort({ startedAt: -1 })
      .toArray();
  },
  async getRunById(runId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db.collection(RUNS_COLLECTION).findOne({ id: runId, project });
  },
  async getLatestRun(benchmarkId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(RUNS_COLLECTION)
      .findOne({ benchmarkId, project }, { sort: { startedAt: -1 } });
  },
};
export default BenchmarkService;
