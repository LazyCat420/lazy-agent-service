// ported from prism-service src/utils/ProviderStreamResilience.ts
import { getErrorMessage, sleep } from "@rodrigo-barraza/utilities-library";
import { ProviderError } from "./errors.ts";
import logger from "./logger.ts";
import {
  PROVIDER_STREAM_MAX_RETRIES,
  PROVIDER_STREAM_RETRY_BASE_MILLISECONDS,
  STREAM_IDLE_TIMEOUT_MILLISECONDS,
} from "../constants/StreamResilience.ts";

/**
 * ProviderStreamResilience — shared transient-error retry and stall-watchdog
 * wrappers for provider streams.
 *
 * Applied at the harness level (BaseAgenticHarness.createProviderStream /
 * consumeStream) so EVERY provider gets the same behavior — previously only
 * Anthropic retried (overloaded-only, fixed delay, no jitter) and the
 * fetch-based providers (Ollama, vLLM, llama-cpp, LM Studio) had no transient
 * retry and no idle timeout at all: a provider that stalled without closing
 * the socket hung the turn forever.
 */

const RETRYABLE_STATUS_CODES: Record<number, true> = {
  408: true,
  429: true,
  500: true,
  502: true,
  503: true,
  504: true,
  529: true,
};

const RETRYABLE_ERROR_CODES: Record<string, true> = {
  ECONNRESET: true,
  ECONNREFUSED: true,
  ETIMEDOUT: true,
  EPIPE: true,
  EAI_AGAIN: true,
  UND_ERR_SOCKET: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
};

const RETRYABLE_ERROR_TYPES: Record<string, true> = {
  overloaded_error: true,
  api_error: true,
  rate_limit_error: true,
};

/**
 * 429s that no amount of waiting clears: a spend cap, an exhausted credit
 * balance or a usage limit stays until someone changes a billing setting
 * (OpenAI error codes, 2026-09). They share the status with `slow_down` and
 * plain rate limits, which DO clear with backoff — so the code decides.
 */
const TERMINAL_QUOTA_ERROR_CODES: Record<string, true> = {
  insufficient_quota: true,
  credit_balance_exhausted: true,
  organization_spend_limit_exceeded: true,
  project_spend_limit_exceeded: true,
  organization_usage_limit_exceeded: true,
};

/**
 * The provider's own error code, wherever the SDK or transport put it: the
 * error itself (`APIError.code`), its response body (`error.code`), or the
 * original error a ProviderError wraps.
 */
function providerErrorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 3) return [];
  const record = error as Record<string, unknown>;
  const body = record.error as Record<string, unknown> | undefined;
  const codes = [record.code, body?.code, body?.type, record.type].filter(
    (code): code is string => typeof code === "string",
  );
  if (error instanceof ProviderError && error.originalError) {
    codes.push(...providerErrorCodes(error.originalError, depth + 1));
  }
  return codes;
}

/**
 * A quota/billing rejection: terminal, surfaced to the user as is. The
 * retry wrappers never retry it and a StopFailure hook sees `billing_error`.
 */
export function isTerminalQuotaError(error: unknown): boolean {
  return providerErrorCodes(error).some((code) =>
    TERMINAL_QUOTA_ERROR_CODES[code],
  );
}

/**
 * The HTTP status of a failure. Most adapters wrap the SDK or transport
 * error in `ProviderError(provider, message, 500, original)`, whose 500 is
 * a placeholder: a real status one layer down wins over it, so a wrapped
 * 400 is not retried as if the server had failed.
 */
function statusOf(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  const record = error as Record<string, unknown>;
  const own = error instanceof ProviderError
    ? error.statusCode
    : (record.status ?? record.statusCode);
  const ownStatus = typeof own === "number" ? own : undefined;
  if (
    error instanceof ProviderError &&
    (ownStatus === undefined || ownStatus === 500) &&
    error.originalError
  ) {
    const innerStatus = statusOf(error.originalError, depth + 1);
    if (innerStatus !== undefined) return innerStatus;
  }
  return ownStatus;
}

/** Classify an error as a transient provider failure worth retrying. */
export function isTransientProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errorRecord = error as Record<string, unknown>;

  // Deliberate aborts are never retryable
  if (errorRecord.name === "AbortError") return false;

  // A spend cap is a 429 too, but waiting does not clear it.
  if (isTerminalQuotaError(error)) return false;

  const statusCode = statusOf(error);
  if (typeof statusCode === "number" && RETRYABLE_STATUS_CODES[statusCode])
    return true;

  const errorType = error instanceof ProviderError
    ? error.errorType
    : ((errorRecord.type ??
        (errorRecord.error as Record<string, unknown> | undefined)
          ?.type) as string | undefined);
  if (typeof errorType === "string" && RETRYABLE_ERROR_TYPES[errorType])
    return true;

  // Node/undici network errors (also nested under cause for fetch failures)
  const code = (errorRecord.code ??
    (errorRecord.cause as Record<string, unknown> | undefined)?.code) as
      | string
      | undefined;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES[code]) return true;

  const message = String(errorRecord.message || "");
  if (/fetch failed|socket hang up|network|terminated/i.test(message))
    return true;

  // Wrapped provider errors: inspect the original error one level down
  if (error instanceof ProviderError && error.originalError) {
    return isTransientProviderError(error.originalError);
  }

  return false;
}

/** Exponential backoff with full jitter, honoring a provider Retry-After when present. */
export function computeRetryDelayMilliseconds(
  attempt: number,
  baseDelayMilliseconds: number,
  error?: unknown,
): number {
  const retryAfterSeconds = extractRetryAfterSeconds(error);
  if (retryAfterSeconds != null) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const exponential = baseDelayMilliseconds * 2 ** (attempt - 1);
  const capped = Math.min(exponential, 30_000);
  // Full jitter: [0.5x, 1.5x]
  return Math.round(capped * (0.5 + Math.random()));
}

type HeaderBag = Record<string, string> | { get?: (name: string) => string | null };

function readHeader(headers: HeaderBag, name: string): string | null {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name);
  }
  return headers[name] ?? null;
}

/** Seconds from a Retry-After value: delta-seconds or an HTTP-date. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds : null;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  const untilDate = (date - Date.now()) / 1000;
  return untilDate > 0 ? untilDate : null;
}

/** google.rpc.RetryInfo in an error body: `"retryDelay": "17s"`. */
const RETRY_INFO_DELAY = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;

/**
 * When the provider asked to be retried, in seconds. Looked up through every
 * layer of the error — the SDK or transport error a ProviderError wraps
 * carries the response headers, not the wrapper — and, for Gemini, whose SDK
 * keeps only the status and body, in the body's RetryInfo.
 */
function extractRetryAfterSeconds(error: unknown): number | null {
  const layers: unknown[] = [error];
  for (let index = 0; index < layers.length && index < 6; index++) {
    const layer = layers[index];
    if (!layer || typeof layer !== "object") continue;
    const record = layer as Record<string, unknown>;
    const headers = record.headers as HeaderBag | undefined;
    if (headers && typeof headers === "object") {
      const milliseconds = Number(readHeader(headers, "retry-after-ms"));
      if (Number.isFinite(milliseconds) && milliseconds > 0) {
        return milliseconds / 1000;
      }
      const seconds = parseRetryAfter(readHeader(headers, "retry-after"));
      if (seconds != null) return seconds;
    }
    const retryInfo = typeof record.message === "string"
      ? record.message.match(RETRY_INFO_DELAY)
      : null;
    if (retryInfo) return Number(retryInfo[1]) || null;
    layers.push(
      layer instanceof ProviderError ? layer.originalError : undefined,
      record.cause,
    );
  }
  return null;
}

/**
 * The error for a stream whose body ended before the provider's terminal
 * event (`response.completed`, `message_stop`, a `finish_reason`, Ollama's
 * `done`): the reply is cut off however cleanly the connection closed, and
 * ending it like a finished one would hand back a truncated answer as if it
 * were whole. 502 — the upstream answered incompletely — so it is transient:
 * streamWithRetries retries it when nothing reached the consumer yet, and
 * the pass fails with it otherwise.
 */
export function streamEndedEarlyError(
  provider: string,
  detail?: string,
): ProviderError {
  return new ProviderError(
    provider,
    `The ${provider} stream ended before the response completed${detail ? ` (${detail})` : ""}`,
    502,
  );
}

/**
 * Parsed numbers from a provider "context length exceeded" rejection.
 * `inputTokens` may be a LOWER BOUND: vLLM reports
 * `window - max_tokens + 1` ("your prompt contains at least N input
 * tokens") when it short-circuits on overflow, so the real prompt can
 * be arbitrarily larger than the reported value.
 */
export interface ContextOverflowInfo {
  contextWindow: number;
  requestedOutputTokens: number | null;
  inputTokens: number | null;
}

/**
 * Detect a context-window overflow rejection and extract its numbers.
 * Matches the wire formats seen from OpenAI-compatible runtimes:
 *   - vLLM:   "...maximum context length is 90000 tokens. However, you
 *              requested 58082 output tokens and your prompt contains at
 *              least 31919 input tokens..."
 *   - OpenAI: "...maximum context length is 8192 tokens. However, you
 *              requested 9000 tokens (7000 in the messages, 2000 in the
 *              completion)..."
 *   - SGLang: "Requested token count exceeds the model's maximum context
 *              length of 32768 tokens. You requested a total of 34000
 *              tokens: 30000 tokens from the input messages and 4000
 *              tokens for the completion..."; "The input (40000 tokens) is
 *              longer than the model's context length (32768 tokens).";
 *              "Input length (40000 tokens) exceeds the maximum allowed
 *              length (32762 tokens)..."; "max_completion_tokens is too
 *              large: 40000.This model supports at most 32768 completion
 *              tokens."
 * Returns null for anything else.
 */
export function parseContextOverflowError(
  error: unknown,
): ContextOverflowInfo | null {
  if (!error || typeof error !== "object") return null;
  const message = String((error as { message?: unknown }).message ?? "");

  // SGLang — the prompt alone is over the window (or over the input limit
  // the scheduler derives from it), so no output budget can make it fit.
  const promptOverflowMatch =
    message.match(
      /input \((\d+) tokens\) is longer than the model's context length \((\d+) tokens\)/i,
    ) ||
    message.match(
      /input length \((\d+) tokens\) exceeds the maximum allowed length \((\d+) tokens\)/i,
    );
  if (promptOverflowMatch) {
    return {
      contextWindow: Number(promptOverflowMatch[2]),
      requestedOutputTokens: null,
      inputTokens: Number(promptOverflowMatch[1]),
    };
  }

  // SGLang — max_tokens alone is over the window set by --context-length
  const outputOverflowMatch = message.match(
    /max_completion_tokens is too large: (\d+)\.\s*This model supports at most (\d+) completion tokens/i,
  );
  if (outputOverflowMatch) {
    return {
      contextWindow: Number(outputOverflowMatch[2]),
      requestedOutputTokens: Number(outputOverflowMatch[1]),
      inputTokens: null,
    };
  }

  const windowMatch = message.match(/maximum context length (?:is|of) (\d+) tokens/i);
  if (!windowMatch) return null;
  const contextWindow = Number(windowMatch[1]);

  const sglangMatch = message.match(
    /(\d+) tokens from the input messages and (\d+) tokens for the completion/i,
  );
  if (sglangMatch) {
    return {
      contextWindow,
      requestedOutputTokens: Number(sglangMatch[2]),
      inputTokens: Number(sglangMatch[1]),
    };
  }

  const vllmMatch = message.match(
    /requested (\d+) output tokens and your prompt contains at least (\d+) input tokens/i,
  );
  if (vllmMatch) {
    return {
      contextWindow,
      requestedOutputTokens: Number(vllmMatch[1]),
      inputTokens: Number(vllmMatch[2]),
    };
  }

  const openAIMatch = message.match(
    /requested \d+ tokens \((\d+) in the messages, (\d+) in the completion\)/i,
  );
  if (openAIMatch) {
    return {
      contextWindow,
      requestedOutputTokens: Number(openAIMatch[2]),
      inputTokens: Number(openAIMatch[1]),
    };
  }

  // Window matched but the component breakdown didn't — still an
  // overflow; caller falls back to blind output reduction.
  return { contextWindow, requestedOutputTokens: null, inputTokens: null };
}

/**
 * The reduced maxTokens for a context-overflow retry, or null when no
 * reduction can help. Halving guarantees geometric convergence even when
 * the reported numbers understate the overshoot; when the rejection
 * reports the real input, the bound window − input − headroom is used.
 */
export function reducedMaxTokensForOverflow(
  currentMaxTokens: number | undefined,
  overflow: ContextOverflowInfo,
  minimumClampedOutputTokens: number,
  fixedHeadroomTokens: number,
): number | null {
  // A prompt that alone fills the window leaves no output budget to
  // shrink — surface the rejection instead of replaying it.
  if (
    overflow.inputTokens !== null &&
    overflow.inputTokens >= overflow.contextWindow
  ) {
    return null;
  }
  if (
    typeof currentMaxTokens !== "number" ||
    currentMaxTokens <= minimumClampedOutputTokens
  ) {
    return null;
  }
  const halvedMaxTokens = Math.floor(currentMaxTokens / 2);
  const boundFromReport = overflow.inputTokens !== null
    ? overflow.contextWindow - overflow.inputTokens - fixedHeadroomTokens
    : Number.POSITIVE_INFINITY;
  const reducedMaxTokens = Math.max(
    Math.min(halvedMaxTokens, boundFromReport),
    minimumClampedOutputTokens,
  );
  if (reducedMaxTokens >= currentMaxTokens) return null;
  return reducedMaxTokens;
}

export interface StreamRetryOptions {
  /** Max retry attempts after the initial try. */
  maxRetries?: number;
  /** Base backoff delay (exponential with jitter). */
  baseDelayMilliseconds?: number;
  /** Abort signal — no retries are attempted once aborted. */
  signal?: AbortSignal | null;
  /** Label for log lines (e.g. provider name). */
  label?: string;
  /**
   * Recovery hook consulted FIRST on any zero-chunk error, before transient
   * classification: return true to retry after mutating request state (e.g.
   * shrinking maxTokens after a context-overflow rejection) — this wins even
   * for errors that would classify as transient, so a doomed payload is
   * never replayed unchanged. Return false to fall through to the normal
   * transient check. Never called once any chunk has been yielded or the
   * signal is aborted.
   */
  tryRecoverFromError?: (error: unknown, attempt: number) => boolean;
}

/**
 * Wrap a stream factory with transient-error retries.
 *
 * CRITICAL INVARIANT: a retry is only attempted when ZERO chunks have been
 * yielded. Once any chunk reached the consumer, retrying would replay text
 * the user already saw and re-emit tool calls that would then EXECUTE TWICE.
 * Mid-stream failures surface as errors instead.
 */
export async function* streamWithRetries<T>(
  createStream: () => AsyncIterable<T> | Promise<AsyncIterable<T>>,
  {
    maxRetries = PROVIDER_STREAM_MAX_RETRIES,
    baseDelayMilliseconds = PROVIDER_STREAM_RETRY_BASE_MILLISECONDS,
    signal,
    label = "provider",
    tryRecoverFromError,
  }: StreamRetryOptions = {},
): AsyncGenerator<T> {
  for (let attempt = 1; ; attempt++) {
    let hasYieldedAnyChunk = false;
    try {
      const stream = await createStream();
      for await (const chunk of stream) {
        hasYieldedAnyChunk = true;
        yield chunk;
      }
      return;
    } catch (error: unknown) {
      const mayRetry =
        !hasYieldedAnyChunk && !signal?.aborted && attempt <= maxRetries;
      const isRetryable = mayRetry &&
        (tryRecoverFromError?.(error, attempt) === true ||
          isTransientProviderError(error));
      if (!isRetryable) throw error;

      const delayMilliseconds = computeRetryDelayMilliseconds(
        attempt,
        baseDelayMilliseconds,
        error,
      );
      logger.warn(
        `[StreamRetry] Transient ${label} error on attempt ${attempt}/${maxRetries + 1} ` +
          `(${getErrorMessage(error)}). ` +
          `Retrying in ${Math.round(delayMilliseconds / 100) / 10}s...`,
      );
      await sleep(delayMilliseconds);
    }
  }
}

/**
 * Non-streaming analog of streamWithRetries: wrap a provider call with
 * transient-error retries using the same classification and jittered
 * backoff. Safe for non-streaming calls only — nothing has been delivered
 * to the consumer when the call rejects, so a retry never duplicates output.
 */
export async function callWithRetries<T>(
  call: () => Promise<T>,
  {
    maxRetries = PROVIDER_STREAM_MAX_RETRIES,
    baseDelayMilliseconds = PROVIDER_STREAM_RETRY_BASE_MILLISECONDS,
    signal,
    label = "provider",
  }: StreamRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error: unknown) {
      const isRetryable =
        !signal?.aborted && attempt <= maxRetries && isTransientProviderError(error);
      if (!isRetryable) throw error;

      const delayMilliseconds = computeRetryDelayMilliseconds(
        attempt,
        baseDelayMilliseconds,
        error,
      );
      logger.warn(
        `[CallRetry] Transient ${label} error on attempt ${attempt}/${maxRetries + 1} ` +
          `(${getErrorMessage(error)}). ` +
          `Retrying in ${Math.round(delayMilliseconds / 100) / 10}s...`,
      );
      await sleep(delayMilliseconds);
    }
  }
}

/**
 * Chunk-idle watchdog: throws if no chunk arrives within
 * `idleTimeoutMilliseconds`. Guards against providers that stall without
 * closing the socket — previously such a stall hung the turn until the
 * 2-hour housekeeping sweep.
 *
 * `onStall` runs first: the caller aborts the provider request there. The
 * stalled generator is stuck in an await, so tearing it down cannot reach
 * the socket — without the abort the connection stayed open and the
 * provider kept generating for a turn that had already failed.
 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  idleTimeoutMilliseconds: number = STREAM_IDLE_TIMEOUT_MILLISECONDS,
  label = "provider",
  onStall?: () => void,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const STALLED = Symbol("stalled");
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const nextPromise = iterator.next();
      const result = await Promise.race([
        nextPromise,
        new Promise<typeof STALLED>((resolve) => {
          timeoutId = setTimeout(() => resolve(STALLED), idleTimeoutMilliseconds);
        }),
      ]).finally(() => {
        clearTimeout(timeoutId);
      });

      if (result === STALLED) {
        // The abandoned next() promise may still reject long after we throw
        // (e.g. the user's stop aborts the underlying fetch). Without a
        // rejection handler that becomes an unhandled rejection and kills
        // the process, wiping every in-flight turn.
        nextPromise.catch(() => {
          /* abandoned after stall — rejection is expected on teardown */
        });
        logger.error(
          `[StreamWatchdog] ${label} stream produced no chunk for ${Math.round(idleTimeoutMilliseconds / 1000)}s — aborting pass.`,
        );
        try {
          onStall?.();
        } catch {
          /* the abort is best-effort; the pass fails either way */
        }
        throw new ProviderError(
          label,
          `Provider stream stalled: no data received for ${Math.round(idleTimeoutMilliseconds / 1000)}s`,
          504,
        );
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Tear down the underlying stream on early exit (stall, consumer break).
    // Fire-and-forget: a STALLED stream's return() may itself never resolve
    // (the generator is stuck mid-await), and awaiting it would hang the
    // very path that exists to escape the hang.
    if (typeof iterator.return === "function") {
      try {
        void Promise.resolve(iterator.return(undefined)).catch(() => {
          /* stream teardown is best-effort */
        });
      } catch {
        /* stream teardown is best-effort */
      }
    }
  }
}
