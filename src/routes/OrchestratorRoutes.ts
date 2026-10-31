import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import OrchestratorService from "../services/OrchestratorService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

interface SubAgentSummary {
  agentId: string;
  description: string;
  status: string;
  providerName?: string;
  resolvedModel?: string;
  durationMs: number;
  toolUses: number;
  hasChanges: boolean;
  totalCost?: number | null;
  branchName?: string | null;
  files?: string[];
  toolCallCount?: number;
  recursionDepth?: number;
  toolNames?: Record<string, number>;
}

const MAX_DESCENDANT_DEPTH = 10;

function processChildConversationDocument(
  childDocument: Record<string, unknown>,
  visitedConversationIds: Set<string>,
  nextFrontier: string[],
  persistedSubAgentsList: SubAgentSummary[],
): void {
  const childConversationId = childDocument.id as string;
  if (visitedConversationIds.has(childConversationId)) return;
  visitedConversationIds.add(childConversationId);
  nextFrontier.push(childConversationId);

  // Also track the agentConversationId (if stored and different from id)
  // so that grandchildren linked via parentAgentConversationId are found.
  const childAgentConversationId =
    childDocument.agentConversationId as string | undefined;
  if (
    childAgentConversationId &&
    childAgentConversationId !== childConversationId &&
    !visitedConversationIds.has(childAgentConversationId)
  ) {
    visitedConversationIds.add(childAgentConversationId);
    nextFrontier.push(childAgentConversationId);
  }

  if (
    Array.isArray(childDocument.subAgents) &&
    childDocument.subAgents.length > 0
  ) {
    for (const descendantSubAgent of childDocument.subAgents) {
      persistedSubAgentsList.push(descendantSubAgent);
    }
  }
}

async function loadPersistedSubAgents(
  conversationIdentifier: string,
): Promise<SubAgentSummary[]> {
  const persistedSubAgentsList: SubAgentSummary[] = [];
  try {
    const { default: MongoWrapper } =
      await import("../wrappers/MongoWrapper.js");
    const { MONGO_DB_NAME } = await import("../../config.js");
    const { COLLECTIONS } = await import("../constants.js");
    const collection = MongoWrapper.getCollection(
      MONGO_DB_NAME,
      COLLECTIONS.AGENT_CONVERSATIONS,
    );

    const rootConversationDocument = await collection.findOne(
      { id: conversationIdentifier },
      { projection: { subAgents: 1, agentConversationId: 1 } },
    );
    if (rootConversationDocument && rootConversationDocument.subAgents) {
      if (rootConversationDocument.subAgents.length > 0) {
        persistedSubAgentsList.push(...rootConversationDocument.subAgents);
      }
    }

    // Recursively discover all descendant sub-agents by traversing the
    // parentAgentConversationId / parentConversationId chain in AGENT_CONVERSATIONS.
    // Each sub-agent conversation may itself have a subAgents array if it
    // spawned its own workers (recursive sub-agent delegation).
    //
    // The root conversation's document `id` differs from the in-memory
    // `agentConversationId` used by the agentic loop. Child conversations
    // store `parentConversationId` → parent's `id`, and
    // `parentAgentConversationId` → parent's `agentConversationId`.
    // Seed the frontier with both IDs and query with $or at every hop.
    let frontier: string[] = [conversationIdentifier];
    const visitedConversationIds = new Set<string>([conversationIdentifier]);

    // Include the root's agentConversationId (if different from id)
    const rootAgentConversationId =
      rootConversationDocument?.agentConversationId as string | undefined;
    if (
      rootAgentConversationId &&
      rootAgentConversationId !== conversationIdentifier
    ) {
      frontier.push(rootAgentConversationId);
      visitedConversationIds.add(rootAgentConversationId);
    }

    for (
      let depth = 0;
      depth < MAX_DESCENDANT_DEPTH && frontier.length > 0;
      depth++
    ) {
      const childConversationDocuments = await collection
        .find(
          {
            $or: [
              { parentAgentConversationId: { $in: frontier } },
              { parentConversationId: { $in: frontier } },
            ],
          },
          { projection: { id: 1, agentConversationId: 1, subAgents: 1 } },
        )
        .toArray();

      if (childConversationDocuments.length === 0) break;

      const nextFrontier: string[] = [];
      for (const childDocument of childConversationDocuments) {
        processChildConversationDocument(
          childDocument as Record<string, unknown>,
          visitedConversationIds,
          nextFrontier,
          persistedSubAgentsList,
        );
      }
      frontier = nextFrontier;
    }
  } catch (error: unknown) {
    logger.warn(
      `[orchestrator] Failed to load persisted sub-agents: ${getErrorMessage(error)}`,
    );
  }
  return persistedSubAgentsList;
}

const router = Router();

// ═══════════════════════════════════════════════════════════════
// Chat-Spawned Sub-Agent Endpoints
// ═══════════════════════════════════════════════════════════════

/*
 * GET /orchestrator/sub-agents
 * List all active sub-agents spawned via chat tools.
 * Optional query: ?conversationId=xxx to filter by parent conversation.
 */
router.get(
  "/sub-agents",
  asyncHandler(async (request: Request, response: Response) => {
    const conversationIdQuery = request.query.conversationId;
    const conversationIdentifier =
      typeof conversationIdQuery === "string" ? conversationIdQuery : undefined;
    const activeSubAgentsList = conversationIdentifier
      ? OrchestratorService.listAllDescendantSubAgents(conversationIdentifier)
      : OrchestratorService.listSubAgents();

    const persistedSubAgentsList = conversationIdentifier
      ? await loadPersistedSubAgents(conversationIdentifier)
      : [];

    const mergedSubAgentsMap = new Map<string, SubAgentSummary>();
    for (const subAgent of persistedSubAgentsList) {
      mergedSubAgentsMap.set(subAgent.agentId, subAgent);
    }
    for (const subAgent of activeSubAgentsList) {
      mergedSubAgentsMap.set(subAgent.agentId, subAgent);
    }
    const finalSubAgentsList = Array.from(mergedSubAgentsMap.values());

    response.json({ subAgents: finalSubAgentsList });
  }),
);

/*
 * POST /orchestrator/sub-agents/stop
 * Abort all running sub-agents for a given parent conversation.
 * Called by the frontend when the user presses stop.
 *
 * Body: { conversationId: string }
 */
router.post(
  "/sub-agents/stop",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId } = request.body;
    if (!conversationId) {
      return response
        .status(400)
        .json({ error: "'conversationId' is required" });
    }

    const result =
      await OrchestratorService.abortSubAgentsByConversation(conversationId);
    response.json(result);
  }),
);

/*
 * GET /orchestrator/sub-agents/:agentId
 * Get the status of a specific chat-spawned sub-agent.
 */
router.get("/sub-agents/:agentId", (request: Request, response: Response) => {
  const agentId = request.params.agentId;
  if (typeof agentId !== "string" || !agentId) {
    return response.status(400).json({ error: "agentId is required" });
  }
  const status = OrchestratorService.getSubAgentStatus(agentId);
  if (!status) {
    return response.status(404).json({ error: "Sub-agent not found" });
  }
  response.json(status);
});

export default router;
