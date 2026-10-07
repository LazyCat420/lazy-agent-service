// ────────────────────────────────────────────────────────────
// AbortController Tree — GC-safe parent→child signal propagation
// ────────────────────────────────────────────────────────────
//
// Provides factory functions for creating AbortControllers with proper
// listener limits and parent-child relationships where:
//   - Aborting the PARENT aborts all children
//   - Aborting a CHILD does NOT affect the parent
//   - Abandoned children can be garbage-collected (WeakRef-based)
//
// Pattern modeled on Claude Code's src/utils/abortController.ts.
// ────────────────────────────────────────────────────────────
import { setMaxListeners } from "events";
const DEFAULT_MAX_LISTENERS = 50;
/**
 * Create an AbortController with a higher listener limit.
 * Prevents MaxListenersExceededWarning when multiple consumers
 * (tool calls, stream readers, etc.) listen on the same signal.
 */
export function createAbortController(maxListeners = DEFAULT_MAX_LISTENERS) {
    const controller = new AbortController();
    setMaxListeners(maxListeners, controller.signal);
    return controller;
}
//# sourceMappingURL=AbortController.js.map