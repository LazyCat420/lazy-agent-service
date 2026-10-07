import logger from "../utils/logger.js";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
export default class AgentHooks {
    _hooks;
    constructor() {
        this._hooks = new Map();
    }
    /**
     * Register a named hook for a lifecycle event.
     * @param category - Hook category (default: "transform" for backwards compat)
     */
    register(event, handler, name, category = "transform") {
        if (!this._hooks.has(event)) {
            this._hooks.set(event, []);
        }
        this._hooks
            .get(event)
            .push({ handler, name: name || handler.name || "anonymous", category });
    }
    /**
     * Run all registered hooks for an event with category-aware execution:
     *
     *   1. decide hooks — run sequentially, short-circuit on { isApproved: false }
     *   2. transform hooks — run sequentially, merge results
     *   3. inspect hooks — fire-and-forget (errors logged, never propagate)
     */
    async run(event, ...args) {
        const hooks = this._hooks.get(event) || [];
        let result;
        // Partition by category
        const decideHooks = hooks.filter((h) => h.category === "decide");
        const transformHooks = hooks.filter((h) => h.category === "transform");
        const inspectHooks = hooks.filter((h) => h.category === "inspect");
        // Phase 1: Decide hooks (blocking, short-circuit on deny)
        for (const { handler, name } of decideHooks) {
            try {
                const hookResult = await handler(...args);
                if (hookResult && typeof hookResult === "object") {
                    result = { ...result, ...hookResult };
                    // Short-circuit if any decide hook denies
                    if ("isApproved" in hookResult &&
                        hookResult.isApproved === false) {
                        logger.info(`[AgentHooks] Decide hook "${name}" denied on "${event}"`);
                        return result;
                    }
                }
            }
            catch (error) {
                logger.error(`[AgentHooks] Decide hook "${name}" on "${event}" failed: ${errorMessage(error)}`);
            }
        }
        // Phase 2: Transform hooks (blocking, can mutate)
        for (const { handler, name } of transformHooks) {
            try {
                const hookResult = await handler(...args);
                if (hookResult && typeof hookResult === "object") {
                    result = { ...result, ...hookResult };
                }
            }
            catch (error) {
                logger.error(`[AgentHooks] Transform hook "${name}" on "${event}" failed: ${errorMessage(error)}`);
            }
        }
        // Phase 3: Inspect hooks (fire-and-forget, errors swallowed)
        for (const { handler, name } of inspectHooks) {
            try {
                // Don't await — fire-and-forget for non-blocking observability
                const maybePromise = handler(...args);
                if (maybePromise &&
                    typeof maybePromise.catch === "function") {
                    maybePromise.catch((error) => {
                        logger.warn(`[AgentHooks] Inspect hook "${name}" on "${event}" failed (non-blocking): ${errorMessage(error)}`);
                    });
                }
            }
            catch (error) {
                // Sync errors in inspect hooks are logged but never propagate
                logger.warn(`[AgentHooks] Inspect hook "${name}" on "${event}" threw (non-blocking): ${errorMessage(error)}`);
            }
        }
        return result;
    }
    hasHooks(event) {
        return (this._hooks.get(event) || []).length > 0;
    }
}
//# sourceMappingURL=AgentHooks.js.map