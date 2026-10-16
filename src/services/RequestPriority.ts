import { AsyncLocalStorage } from "node:async_hooks";

/**
 * RequestPriority — whether a model call serves an interactive turn or a
 * background job (memory extraction). Ported from prism-service
 * services/RequestPriority.ts: self-hosted servers that schedule by priority
 * serve interactive turns first (vLLM `X-Vllm-Priority`,
 * providers/local-request-features.ts). Anything not marked is interactive.
 */
export type RequestPriorityClass = "interactive" | "background";

const storage = new AsyncLocalStorage<RequestPriorityClass>();

export function runWithRequestPriority<T>(priority: RequestPriorityClass, call: () => T): T {
  return storage.run(priority, call);
}

export function currentRequestPriority(): RequestPriorityClass {
  return storage.getStore() ?? "interactive";
}
