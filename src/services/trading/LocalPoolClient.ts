import logger from "../../logger.js";
import type { ChatMessage, StreamChunk } from "../../types/provider.ts";
import type { CoreModel, CoreModelRequest } from "../../core/loop/types.ts";
import {
  acquirePoolInFlight,
  markPoolMemberDown,
  pickPoolModel,
  recordPoolServed,
  releasePoolInFlight,
  selectPoolMember,
  type PoolMember,
} from "../vllm/VllmPool.ts";
import { QueueTimeoutError, VllmShimService } from "../vllm/VllmShimService.ts";

const SHIM_QUEUE_TIMEOUT_MS = 120_000;
const FAILOVER_MIN_BUDGET_MS = 60_000;

export class PoolUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "POOL_UNAVAILABLE";
}

export class PipelineTimeoutError extends Error {
  readonly statusCode = 504;
  readonly code = "PIPELINE_TIMEOUT";
}

export interface PoolCallResult {
  boxName: string;
  boxIp: string;
  modelId: string;
  sameBoxFallback: boolean;
}

export interface AcquiredPoolTarget {
  member: PoolMember;
  modelId: string;
  sameBoxFallback: boolean;
  fallbackCandidates?: PoolMember[];
  modelsByMember?: Record<string, string>;
  release: () => void;
  claimFallbackSlot?: (memberName: string) => void;
  releaseFallbackSlot?: (memberName: string) => void;
  promoteMemberSlot?: (prevName: string, nextMember: PoolMember, nextModelId: string) => void;
}

export interface PoolModelCallParams {
  preferredMember?: string;
  temperature: number;
  seed?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  onFailover?: (nextMember: PoolMember, nextModelId: string) => void;
}

function toOpenAiMessage(msg: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
  };
  if (typeof msg.tool_call_id === "string" && msg.tool_call_id) {
    out.tool_call_id = msg.tool_call_id;
  }
  if (typeof msg.name === "string" && msg.name) {
    out.name = msg.name;
  }
  if (msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map((tc, idx) => ({
      id: tc.id || `call_${idx}`,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args || {}),
      },
    }));
  }
  return out;
}

function safeParseArgs(raw: unknown): { args: Record<string, unknown>; parseError: boolean; rawText: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, parseError: false, rawText: "" };
  }
  const text = typeof raw === "string" ? raw : "{}";
  try {
    const parsed = JSON.parse(text || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, parseError: false, rawText: text };
    }
    return { args: {}, parseError: true, rawText: text };
  } catch {
    return { args: {}, parseError: true, rawText: text };
  }
}

export async function discoverPoolModel(member: PoolMember, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted before /v1/models lookup");
  }
  const combined = signal ? AbortSignal.any([AbortSignal.timeout(3000), signal]) : AbortSignal.timeout(3000);
  const resp = await fetch(`${member.url.replace(/\/$/, "")}/v1/models`, {
    signal: combined,
  });
  if (!resp.ok) {
    throw new Error(`GET ${member.url}/v1/models returned HTTP ${resp.status}`);
  }
  const id = pickPoolModel(await resp.json());
  if (!id) {
    throw new Error(`No generation model reported by ${member.name} (${member.url}/v1/models)`);
  }
  return id;
}

export async function acquireLocalPoolTarget(
  preferredMember?: string,
  signal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<AcquiredPoolTarget> {
  if (signal?.aborted) {
    throw normalizePoolFailure(signal.reason, undefined, signal, deadlineAtMs);
  }
  const budgetMs = resolveCallBudgetMs(deadlineAtMs);
  const discoverySignal = combinedCallSignal(undefined, signal, Math.min(3000, budgetMs));
  const selectionSignal = combinedCallSignal(undefined, signal, budgetMs);
  let selection: Awaited<ReturnType<typeof selectPoolMember>>;
  try {
    selection = await selectPoolMember({
      preferredMember,
      body: {},
      headers: preferredMember ? { "x-pool-prefer-member": preferredMember } : undefined,
      signal: selectionSignal,
    });
  } catch (err) {
    throw normalizePoolFailure(err, undefined, signal, deadlineAtMs);
  }
  let heldName: string | null = selection.member.name;
  const discoveryErrors: string[] = [];
  try {
    if (signal?.aborted) {
      throw normalizePoolFailure(signal.reason, undefined, signal, deadlineAtMs);
    }
    resolveCallBudgetMs(deadlineAtMs);
    for (const candidate of selection.candidates) {
      try {
        const cachedModel = selection.modelsByMember?.[candidate.name];
        const modelId = cachedModel || (await discoverPoolModel(candidate, discoverySignal));
        if (signal?.aborted) {
          throw normalizePoolFailure(signal.reason, undefined, signal, deadlineAtMs);
        }
        resolveCallBudgetMs(deadlineAtMs);
        if (candidate.name !== heldName) {
          acquirePoolInFlight(candidate.name);
          if (heldName) releasePoolInFlight(heldName);
          heldName = candidate.name;
        }
        const fallbackCandidates = selection.candidates.filter((m) => m.name !== candidate.name);
        let released = false;
        const ownedSlots = new Set<string>(heldName ? [heldName] : []);
        const acquired: AcquiredPoolTarget = {
          member: candidate,
          modelId,
          sameBoxFallback:
            Boolean(selection.sameBoxFallback) ||
            (Boolean(preferredMember) && candidate.name !== preferredMember),
          fallbackCandidates,
          modelsByMember: selection.modelsByMember,
          claimFallbackSlot: (memberName: string) => {
            if (!released && !ownedSlots.has(memberName)) {
              acquirePoolInFlight(memberName);
              ownedSlots.add(memberName);
            }
          },
          releaseFallbackSlot: (memberName: string) => {
            if (ownedSlots.delete(memberName)) {
              releasePoolInFlight(memberName);
            }
          },
          promoteMemberSlot: (prevName: string, nextMember: PoolMember, nextModelId: string) => {
            if (ownedSlots.delete(prevName)) {
              releasePoolInFlight(prevName);
            }
            if (!released && !ownedSlots.has(nextMember.name)) {
              acquirePoolInFlight(nextMember.name);
              ownedSlots.add(nextMember.name);
            }
            acquired.member = nextMember;
            acquired.modelId = nextModelId;
          },
          release: () => {
            if (released) return;
            released = true;
            for (const slot of ownedSlots) {
              releasePoolInFlight(slot);
            }
            ownedSlots.clear();
          },
        };
        if (signal?.aborted) {
          throw normalizePoolFailure(signal.reason, undefined, signal, deadlineAtMs);
        }
        resolveCallBudgetMs(deadlineAtMs);
        return acquired;
      } catch (err) {
        if (signal?.aborted || (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs)) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[LocalPoolClient] /v1/models discovery failed on ${candidate.name}: ${msg}`);
        discoveryErrors.push(`${candidate.name}: ${msg}`);
      }
    }
    throw new PoolUnavailableError(
      `No healthy local DeepSeek pool box available from /v1/models (${discoveryErrors.join("; ") || "no candidates"})`,
    );
  } catch (err) {
    if (heldName) {
      releasePoolInFlight(heldName);
      heldName = null;
    }
    throw normalizePoolFailure(err, undefined, signal, deadlineAtMs);
  }
}

function buildCompletionPayload(
  modelId: string,
  request: CoreModelRequest,
  params: PoolModelCallParams,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: modelId,
    messages: request.messages.map(toOpenAiMessage),
    temperature: params.temperature,
    max_tokens: params.maxTokens ?? 4096,
    stream: false,
    enable_thinking: false,
    chat_template_kwargs: { thinking: false, enable_thinking: false },
  };
  if (typeof params.seed === "number") {
    payload.seed = params.seed;
  }
  if (request.tools.length > 0 && request.toolChoice !== "none") {
    payload.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    payload.tool_choice = "auto";
  }
  return payload;
}

function toToolCallChunk(tc: any, index: number): StreamChunk {
  const fn = tc?.function || {};
  const { args, parseError, rawText } = safeParseArgs(fn.arguments);
  return {
    type: "toolCall",
    id: typeof tc?.id === "string" && tc.id ? tc.id : `call_${index}`,
    name: String(fn.name || ""),
    args,
    native: true,
    ...(parseError ? { argsParseError: true, rawArgs: rawText.slice(0, 2000) } : {}),
  };
}

function completionChunks(parsed: Record<string, any>, allowTools: boolean): StreamChunk[] {
  const out: StreamChunk[] = [];
  const choice = parsed?.choices?.[0] || {};
  const msg = choice.message || {};
  if (typeof msg.content === "string" && msg.content) out.push(msg.content);
  if (allowTools && Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc: unknown, idx: number) => out.push(toToolCallChunk(tc, idx)));
  }
  if (choice.finish_reason === "length") out.push({ type: "stopReason", stopReason: "length" });
  if (parsed?.usage) {
    out.push({
      type: "usage",
      usage: {
        inputTokens: Number(parsed.usage.prompt_tokens || 0),
        outputTokens: Number(parsed.usage.completion_tokens || 0),
      },
    });
  }
  return out;
}

function resolveCallBudgetMs(deadlineAtMs?: number): number {
  if (deadlineAtMs === undefined) return 300_000;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) {
    throw new PipelineTimeoutError("Linear pipeline deadline exceeded");
  }
  return Math.min(300_000, remaining);
}

function combinedCallSignal(
  requestSignal: AbortSignal | undefined,
  paramSignal: AbortSignal | undefined,
  budgetMs = 300_000,
): AbortSignal {
  const timeoutSig = AbortSignal.timeout(Math.max(1, budgetMs));
  const signals = [requestSignal, paramSignal, timeoutSig].filter(Boolean) as AbortSignal[];
  return AbortSignal.any(signals);
}

async function acquireSemaphoreWithAbort(
  sem: { acquire: (timeoutMs: number) => Promise<() => void> },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<() => void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted before acquiring pool slot");
  }
  return await new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted while waiting for pool slot"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sem.acquire(timeoutMs).then(
      (release) => {
        signal.removeEventListener("abort", onAbort);
        if (settled || signal.aborted) {
          release();
          if (!settled) {
            settled = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted after acquiring pool slot"));
          }
          return;
        }
        settled = true;
        resolve(release);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
    );
  });
}

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isCallerAborted(requestSignal?: AbortSignal, paramSignal?: AbortSignal): boolean {
  return Boolean(requestSignal?.aborted || paramSignal?.aborted);
}

function hasFailoverBudget(deadlineAtMs?: number): boolean {
  if (deadlineAtMs === undefined) return true;
  return deadlineAtMs - Date.now() >= FAILOVER_MIN_BUDGET_MS;
}

function isRetryablePoolFailure(err: unknown, callerAborted: boolean): boolean {
  if (callerAborted) return false;
  if (err instanceof QueueTimeoutError || err instanceof PoolUnavailableError) return true;
  if (err instanceof HttpStatusError) return err.status >= 500;
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return true;
  return err instanceof TypeError || (err instanceof Error && /fetch|network|timeout|ECONN|EHOST|socket/i.test(err.message));
}

function normalizePoolFailure(
  err: unknown,
  requestSignal?: AbortSignal,
  paramSignal?: AbortSignal,
  deadlineAtMs?: number,
): Error {
  if (requestSignal?.aborted || paramSignal?.aborted) {
    const reason = paramSignal?.reason ?? requestSignal?.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      return new PipelineTimeoutError(reason.message || "Linear pipeline deadline exceeded");
    }
    if (reason instanceof Error) return reason;
    return new Error(String(reason || "Aborted"));
  }
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    return new PipelineTimeoutError(err instanceof Error && err.message ? err.message : "Linear pipeline deadline exceeded");
  }
  if (err instanceof PoolUnavailableError || err instanceof PipelineTimeoutError) return err;
  if (err instanceof QueueTimeoutError) return new PoolUnavailableError(err.message);
  if (err instanceof HttpStatusError) {
    return err.status >= 500 ? new PoolUnavailableError(err.message) : err;
  }
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new PipelineTimeoutError(err.message || "vLLM request timed out");
  }
  if (isRetryablePoolFailure(err, false)) {
    return new PoolUnavailableError(err instanceof Error ? err.message : String(err));
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function resolveCandidateModel(
  candidate: PoolMember,
  modelsByMember?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const cached = modelsByMember?.[candidate.name];
  if (cached) return cached;
  return await discoverPoolModel(candidate, signal);
}

/**
 * Create a `CoreModel` backed by a local pool member (`gold-spark` or `dell2`)
 * discovered via `/v1/models`. Acquires `VllmShimService.semaphoreFor(member)`
 * around every completion request (racing cleanly against abort/deadline so no
 * slot waits on dead callers), while `LinearStageTarget.release` frees pool
 * in-flight accounting when the stage completes. Falls over once to a healthy
 * sibling pool member on 5xx, network failure, or queue timeout.
 */
export function createPoolCoreModel(
  target: AcquiredPoolTarget,
  params: PoolModelCallParams,
): CoreModel {
  return (request: CoreModelRequest): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
      const candidates = [target.member, ...(target.fallbackCandidates ?? [])].slice(0, 2);
      let lastErr: unknown;

      for (let idx = 0; idx < candidates.length; idx++) {
        const candidate = candidates[idx]!;
        let releaseSem: (() => void) | null = null;
        let fallbackCharged = false;
        let promoted = false;
        try {
          const budgetMs = resolveCallBudgetMs(params.deadlineAtMs);
          const callSignal = combinedCallSignal(request.signal, params.signal, budgetMs);
          const semWaitMs = Math.min(SHIM_QUEUE_TIMEOUT_MS, budgetMs);
          const prevMember = target.member;
          const modelId =
            idx > 0 ? await resolveCandidateModel(candidate, target.modelsByMember, callSignal) : target.modelId;

          const url = `${candidate.url.replace(/\/$/, "")}/v1/chat/completions`;
          const sem = VllmShimService.semaphoreFor(candidate.name);
          releaseSem = sem ? await acquireSemaphoreWithAbort(sem, semWaitMs, callSignal) : null;

          if (idx > 0 && candidate.name !== prevMember.name) {
            if (target.claimFallbackSlot) target.claimFallbackSlot(candidate.name);
            else acquirePoolInFlight(candidate.name);
            fallbackCharged = true;
          }

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildCompletionPayload(modelId, request, params)),
            signal: callSignal,
          });
          if (!res.ok) {
            const text = await res.text();
            throw new HttpStatusError(res.status, `vLLM ${candidate.name} HTTP ${res.status}: ${text.slice(0, 300)}`);
          }
          const rawJson = (await res.json()) as Record<string, any>;

          if (idx > 0 && fallbackCharged && candidate.name !== prevMember.name) {
            if (target.promoteMemberSlot) {
              target.promoteMemberSlot(prevMember.name, candidate, modelId);
            } else {
              releasePoolInFlight(prevMember.name);
              target.member = candidate;
              target.modelId = modelId;
            }
            target.fallbackCandidates = (target.fallbackCandidates ?? []).filter(
              (m) => m.name !== candidate.name && m.name !== prevMember.name,
            );
            promoted = true;
            params.onFailover?.(candidate, modelId);
          }

          const allowTools = request.tools.length > 0 && request.toolChoice !== "none";
          const parsed = allowTools ? VllmShimService.normalizeToolCalls(rawJson) : rawJson;
          for (const chunk of completionChunks(parsed, allowTools)) {
            yield chunk;
          }
          recordPoolServed(candidate.name);
          return;
        } catch (err) {
          lastErr = err;
          if (fallbackCharged && !promoted) {
            if (target.releaseFallbackSlot) target.releaseFallbackSlot(candidate.name);
            else releasePoolInFlight(candidate.name);
            fallbackCharged = false;
          }
          const callerAborted = isCallerAborted(request.signal, params.signal);
          const deadlineHit = params.deadlineAtMs !== undefined && Date.now() >= params.deadlineAtMs;
          const retryable = isRetryablePoolFailure(err, callerAborted || deadlineHit);
          if (retryable && !deadlineHit) {
            markPoolMemberDown(candidate.name);
          }
          const canFailover =
            idx === 0 &&
            candidates.length > 1 &&
            retryable &&
            !deadlineHit &&
            hasFailoverBudget(params.deadlineAtMs);
          if (!canFailover) {
            throw normalizePoolFailure(err, request.signal, params.signal, params.deadlineAtMs);
          }
          logger.warn(
            `[LocalPoolClient] ${candidate.name} failed (${err instanceof Error ? err.message : String(err)}); failing over to ${candidates[idx + 1]!.name}`,
          );
        } finally {
          releaseSem?.();
          if (fallbackCharged && !promoted) {
            if (target.releaseFallbackSlot) target.releaseFallbackSlot(candidate.name);
            else releasePoolInFlight(candidate.name);
            fallbackCharged = false;
          }
        }
      }
      throw normalizePoolFailure(lastErr, request.signal, params.signal, params.deadlineAtMs);
    },
  });
}

export function releasePoolTarget(memberName: string): void {
  releasePoolInFlight(memberName);
}
