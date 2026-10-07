import { createAbortController } from "../utils/AbortController.js";
import logger from "../utils/logger.js";
const activeSessions = new Map();
const AgentSessionRegistry = {
    /**
     * Register a new agentic session. Returns the stop AbortController
     * whose signal should be passed to the harness for loop-control checks.
     */
    register(conversationId) {
        const existingSession = activeSessions.get(conversationId);
        if (existingSession) {
            logger.warn(`[AgentSessionRegistry] Overwriting existing session for ${conversationId}`);
            existingSession.stopController.abort();
        }
        const stopController = createAbortController();
        activeSessions.set(conversationId, {
            stopController,
            registeredAt: Date.now(),
        });
        logger.debug(`[AgentSessionRegistry] Registered session ${conversationId} (active=${activeSessions.size})`);
        return stopController;
    },
    /**
     * Explicitly stop an active session. Called by POST /agent/stop.
     * Returns true if a session was found and aborted.
     */
    stop(conversationId) {
        const session = activeSessions.get(conversationId);
        if (!session)
            return false;
        if (!session.stopController.signal.aborted) {
            session.stopController.abort();
            logger.info(`[AgentSessionRegistry] Stopped session ${conversationId}`);
        }
        return true;
    },
    /** Check if a session is actively running (registered and not stopped). */
    isActive(conversationId) {
        const session = activeSessions.get(conversationId);
        return !!session && !session.stopController.signal.aborted;
    },
    /** Remove a session entry after the handler completes. */
    cleanup(conversationId) {
        activeSessions.delete(conversationId);
        logger.debug(`[AgentSessionRegistry] Cleaned up session ${conversationId} (active=${activeSessions.size})`);
    },
    /** Current number of active sessions (for health/diagnostics). */
    get activeCount() {
        return activeSessions.size;
    },
};
export default AgentSessionRegistry;
//# sourceMappingURL=AgentSessionRegistry.js.map