import logger from "../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * AgentHooks — typed lifecycle system for the agentic loop.
 *
 * Events:
 *   beforePrompt     — Fires before each LLM call. Listeners receive (ctx) and
 *                       can mutate ctx.messages (e.g. inject system prompt context).
 *   beforeToolCall   — Fires before each tool execution. Listeners receive
 *                       (toolCall, ctx) and can return { isApproved: false } to block.
 *   afterToolCall    — Fires after each tool returns. Listeners receive
 *                       (toolCall, result, ctx).
 *   afterResponse    — Fires when the loop exits with a final response.
 *                       Listeners receive (ctx, { text, thinking, toolCalls, messages }).
 *   runStop          — Fires when the run loop exits with the final response
 *                       (canonical RunExecutionEngine path). Listeners receive
 *                       (ctx, { runId, messages, toolCalls }).
 *   onError          — Fires on any loop error. Listeners receive (error, ctx).
 *
 * Hook Categories (inspired by Antigravity SDK):
 *   inspect    — Read-only, non-blocking. Errors are logged but never propagate.
 *                Ideal for telemetry, logging, and observability.
 *   decide     — Read-only, blocking. Returns { isApproved: boolean }.
 *                Short-circuits on first deny. For policy enforcement & guardrails.
 *   transform  — Modifying, blocking. Can mutate context/args and return control objects.
 *                Default category for backwards compatibility.
 *
 * Execution order within an event:
 *   1. decide hooks  (blocking — aborts if any deny)
 *   2. transform hooks (blocking — can mutate data)
 *   3. inspect hooks (fire-and-forget — never blocks)
 *
 * Usage:
 *   const hooks = new AgentHooks();
 *   hooks.register("beforePrompt", async (ctx) => { ... }, "MyHook", "transform");
 *   hooks.register("afterResponse", async (ctx) => { ... }, "Logger", "inspect");
 *   await hooks.run("beforePrompt", ctx);
 */

type HookEvent =
  | "beforePrompt"
  | "beforeToolCall"
  | "afterToolCall"
  | "afterResponse"
  | "runStop"
  | "onError";

/**
 * Hook category determines execution semantics.
 *   inspect   — fire-and-forget, non-blocking, errors swallowed
 *   decide    — blocking, returns {isApproved}, short-circuits on deny
 *   transform — blocking, can mutate context (default for backwards compat)
 */
type HookCategory = "inspect" | "decide" | "transform";

// Hook handlers have heterogeneous signatures per event (beforePrompt receives
// a context object, beforeToolCall receives (toolCall, ctx), afterResponse
// receives (ctx, output), etc.). A single function type can't express this
// without a complex generic event map, so we use a callable interface.
type HookHandler = (
  ...args: unknown[]
) => Promise<object | void> | object | void;

interface RegisteredHook {
  handler: HookHandler;
  name: string;
  category: HookCategory;
}

export type { HookCategory, HookHandler };

export default class AgentHooks {
  private _hooks: Map<HookEvent, RegisteredHook[]>;

  constructor() {
    this._hooks = new Map();
  }

  /**
   * Register a named hook for a lifecycle event.
   * @param category - Hook category (default: "transform" for backwards compat)
   */
  register(
    event: HookEvent,
    handler: HookHandler,
    name: string,
    category: HookCategory = "transform",
  ): void {
    if (!this._hooks.has(event)) {
      this._hooks.set(event, []);
    }
    this._hooks
      .get(event)!
      .push({ handler, name: name || handler.name || "anonymous", category });
  }

  /**
   * Run all registered hooks for an event with category-aware execution:
   *
   *   1. decide hooks — run sequentially, short-circuit on { isApproved: false }
   *   2. transform hooks — run sequentially, merge results
   *   3. inspect hooks — fire-and-forget (errors logged, never propagate)
   */
  async run(
    event: HookEvent,
    ...args: unknown[]
  ): Promise<Record<string, unknown> | undefined> {
    const hooks = this._hooks.get(event) || [];
    let result: Record<string, unknown> | undefined;

    // Partition by category
    const decideHooks = hooks.filter((h) => h.category === "decide");
    const transformHooks = hooks.filter((h) => h.category === "transform");
    const inspectHooks = hooks.filter((h) => h.category === "inspect");

    // Phase 1: Decide hooks (blocking, short-circuit on deny)
    for (const { handler, name } of decideHooks) {
      try {
        const hookResult = await (handler as (...args: unknown[]) => unknown)(
          ...args,
        );
        if (hookResult && typeof hookResult === "object") {
          result = { ...result, ...hookResult };
          // Short-circuit if any decide hook denies
          if (
            "isApproved" in hookResult &&
            (hookResult as { isApproved: boolean }).isApproved === false
          ) {
            logger.info(
              `[AgentHooks] Decide hook "${name}" denied on "${event}"`,
            );
            return result;
          }
        }
      } catch (error: unknown) {
        logger.error(
          `[AgentHooks] Decide hook "${name}" on "${event}" failed: ${errorMessage(error)}`,
        );
      }
    }

    // Phase 2: Transform hooks (blocking, can mutate)
    for (const { handler, name } of transformHooks) {
      try {
        const hookResult = await (handler as (...args: unknown[]) => unknown)(
          ...args,
        );
        if (hookResult && typeof hookResult === "object") {
          result = { ...result, ...hookResult };
        }
      } catch (error: unknown) {
        logger.error(
          `[AgentHooks] Transform hook "${name}" on "${event}" failed: ${errorMessage(error)}`,
        );
      }
    }

    // Phase 3: Inspect hooks (fire-and-forget, errors swallowed)
    for (const { handler, name } of inspectHooks) {
      try {
        // Don't await — fire-and-forget for non-blocking observability
        const maybePromise = (handler as (...args: unknown[]) => unknown)(
          ...args,
        );
        if (
          maybePromise &&
          typeof (maybePromise as Promise<unknown>).catch === "function"
        ) {
          (maybePromise as Promise<unknown>).catch((error: unknown) => {
            logger.warn(
              `[AgentHooks] Inspect hook "${name}" on "${event}" failed (non-blocking): ${errorMessage(error)}`,
            );
          });
        }
      } catch (error: unknown) {
        // Sync errors in inspect hooks are logged but never propagate
        logger.warn(
          `[AgentHooks] Inspect hook "${name}" on "${event}" threw (non-blocking): ${errorMessage(error)}`,
        );
      }
    }

    return result;
  }

  hasHooks(event: HookEvent): boolean {
    return (this._hooks.get(event) || []).length > 0;
  }
}
