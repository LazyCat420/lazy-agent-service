/**
 * discoverContextWindow — ask a serving endpoint what context its model
 * takes, instead of guessing from the name.
 *
 * Probes two endpoints, both optional in practice:
 *   GET {base}/v1/models      — OpenAI-compatible; entries may carry
 *                               `context_length`, `context_window`,
 *                               `max_model_len` or `x-context-length`
 *                               (vLLM, LM Studio, llama.cpp).
 *   GET {base}/model_info     — vLLM's richer per-model info; entries may
 *                               carry `max_input_tokens` or `context_length`.
 *
 * The model entry is picked by id when `modelName` is given, else the first.
 * Anything that fails — network, timeout, no recognizable field — yields
 * `undefined`; the caller falls back to the family default.
 */

export interface DiscoverContextWindowOptions {
  /** Injectable fetch (tests supply a stub); defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds before the probe gives up; default 5_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Fields a serving endpoint may use, most specific first. */
const CONTEXT_FIELDS = [
  "max_input_tokens",
  "context_length",
  "context_window",
  "max_model_len",
  "x-context-length",
  "max_context_length",
] as const;

function contextTokensFromEntry(entry: Record<string, unknown> | undefined | null): number | undefined {
  if (!entry) return undefined;
  for (const field of CONTEXT_FIELDS) {
    const value = entry[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickEntry(payload: unknown, modelName: string | undefined): Record<string, unknown> | undefined {
  const list = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray(payload) ? payload : null;
  if (!list) return undefined;
  if (modelName) {
    const named = list.find((entry) => (entry as { id?: string })?.id === modelName);
    if (named) return named as Record<string, unknown>;
  }
  return list[0] as Record<string, unknown> | undefined;
}

async function probe(
  url: string,
  modelName: string | undefined,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<number | undefined> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return undefined;
  const payload = await response.json() as unknown;
  return contextTokensFromEntry(pickEntry(payload, modelName));
}

/** The context window the endpoint serves for `modelName`, or undefined when it says nothing. */
export async function discoverContextWindow(
  baseUrl: string,
  modelName?: string,
  options: DiscoverContextWindowOptions = {},
): Promise<number | undefined> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");

  for (const path of ["/v1/models", "/model_info"]) {
    try {
      const tokens = await probe(`${base}${path}`, modelName, fetchFn, timeoutMs);
      if (tokens !== undefined) return tokens;
    } catch {
      // Unreachable endpoint, timeout, or a body we cannot read: try the next.
    }
  }
  return undefined;
}
