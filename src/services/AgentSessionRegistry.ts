import { createAbortController } from "../utils/AbortController.ts";
import logger from "../utils/logger.ts";

/**
 * AgentSessionRegistry — tracks active agentic loop sessions so they can
 * be explicitly stopped via POST /agent/stop without relying on the SSE
 * connection lifecycle.
 *
 * Mobile browsers kill background TCP connections when the screen locks.
 * Previously this aborted the agentic loop. Now the loop continues using
 * a separate stop signal, and only an explicit stop request (or natural
 * completion) terminates processing.
 *
 * Entries are auto-cleaned when the handler completes (via `cleanup()`).
 */

interface ActiveSession {
  stopController: AbortController;
  registeredAt: number;
}

const activeSessions = new Map<string, ActiveSession>();

const AgentSessionRegistry = {
  /**
   * Register a new agentic session. Returns the stop AbortController
   * whose signal should be passed to the harness for loop-control checks.
   */
  register(conversationId: string): AbortController {
    const existingSession = activeSessions.get(conversationId);
    if (existingSession) {
      logger.warn(
        `[AgentSessionRegistry] Overwriting existing session for ${conversationId}`,
      );
      existingSession.stopController.abort();
    }
    const stopController = createAbortController();
    activeSessions.set(conversationId, {
      stopController,
      registeredAt: Date.now(),
    });
    logger.debug(
      `[AgentSessionRegistry] Registered session ${conversationId} (active=${activeSessions.size})`,
    );
    return stopController;
  },

  /**
   * Explicitly stop an active session. Called by POST /agent/stop.
   * Returns true if a session was found and aborted.
   */
  stop(conversationId: string): boolean {
    const session = activeSessions.get(conversationId);
    if (!session) return false;
    if (!session.stopController.signal.aborted) {
      session.stopController.abort();
      logger.info(
        `[AgentSessionRegistry] Stopped session ${conversationId}`,
      );
    }
    return true;
  },

  /** Check if a session is actively running (registered and not stopped). */
  isActive(conversationId: string): boolean {
    const session = activeSessions.get(conversationId);
    return !!session && !session.stopController.signal.aborted;
  },

  /**
   * Remove a session entry after the handler completes. With `owner`, only
   * when the entry is still that handler's (a newer request may own it now).
   */
  cleanup(conversationId: string, owner?: AbortController): void {
    const session = activeSessions.get(conversationId);
    if (!session) return;
    if (owner && session.stopController !== owner) return;
    activeSessions.delete(conversationId);
    logger.debug(
      `[AgentSessionRegistry] Cleaned up session ${conversationId} (active=${activeSessions.size})`,
    );
  },

  /** Current number of active sessions (for health/diagnostics). */
  get activeCount(): number {
    return activeSessions.size;
  },
};

export default AgentSessionRegistry;
