import { COLLECTIONS } from "../constants.ts";

export interface IndexDefinition {
  collection: string;
  keys: Record<string, number>;
  options?: { unique?: boolean; expireAfterSeconds?: number };
}

/**
 * Every collection index the service creates at boot. Critical for $lookup
 * aggregation performance (conversations ↔ requests): without these, $lookup
 * does full collection scans per document.
 */
export const INDEX_DEFINITIONS: IndexDefinition[] = [
  // requests — primary lookup by requestId (admin detail view)
  { collection: COLLECTIONS.REQUESTS, keys: { requestId: 1 }, options: { unique: true } },
  // requests — used by $lookup from conversations and agent conversation joins
  { collection: COLLECTIONS.REQUESTS, keys: { conversationId: 1 } },
  { collection: COLLECTIONS.REQUESTS, keys: { traceId: 1 } },
  { collection: COLLECTIONS.REQUESTS, keys: { timestamp: -1 } },
  { collection: COLLECTIONS.REQUESTS, keys: { project: 1, timestamp: -1 } },
  // requests — agent conversation joins (admin traces, conversation detail)
  { collection: COLLECTIONS.REQUESTS, keys: { agentConversationId: 1 } },
  // requests — parent agent conversation hierarchy traversal (7+ query sites use $in on this field)
  { collection: COLLECTIONS.REQUESTS, keys: { parentAgentConversationId: 1 } },
  // requests — per-user stats aggregation
  { collection: COLLECTIONS.REQUESTS, keys: { username: 1, timestamp: -1 } },
  // requests — tool stats aggregation (multikey on array field)
  { collection: COLLECTIONS.REQUESTS, keys: { toolApiNames: 1 } },
  // requests — model/provider breakdown aggregation
  { collection: COLLECTIONS.REQUESTS, keys: { model: 1, provider: 1 } },
  // requests — endpoint breakdown aggregation
  { collection: COLLECTIONS.REQUESTS, keys: { endpoint: 1 } },
  // requests — success/failure filtering with time range
  { collection: COLLECTIONS.REQUESTS, keys: { success: 1, timestamp: -1 } },
  // conversations — used by findOne lookups and list queries
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { updatedAt: -1 } },
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { project: 1, username: 1, updatedAt: -1 } },
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { traceId: 1 } },
  // conversations — admin workspace filter
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { workspaceRoot: 1 } },
  // conversations — stale isGenerating cleanup + stats count
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { isGenerating: 1, updatedAt: -1 } },
  // conversations — sub-agent parent linkage (cascading deletion)
  { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { parentConversationId: 1 } },
  // agent_conversations — same indexes as conversations
  { collection: COLLECTIONS.AGENT_CONVERSATIONS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.AGENT_CONVERSATIONS, keys: { updatedAt: -1 } },
  { collection: COLLECTIONS.AGENT_CONVERSATIONS, keys: { project: 1, username: 1, updatedAt: -1 } },
  // agent_conversations — admin workspace filter
  { collection: COLLECTIONS.AGENT_CONVERSATIONS, keys: { workspaceRoot: 1 } },
  // agent_conversations — stale isGenerating cleanup + stats count
  { collection: COLLECTIONS.AGENT_CONVERSATIONS, keys: { isGenerating: 1, updatedAt: -1 } },
  // agent_conversations — sub-agent parent linkage (tree grouping in UI)
  { collection: COLLECTIONS.AGENT_CONVERSATIONS, keys: { parentConversationId: 1 } },
  // workflows — used by conversationIds lookup
  { collection: COLLECTIONS.WORKFLOWS, keys: { id: 1 }, options: { unique: true } },
  // benchmarks
  { collection: COLLECTIONS.BENCHMARKS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARKS, keys: { project: 1, updatedAt: -1 } },
  { collection: COLLECTIONS.BENCHMARK_RUNS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARK_RUNS, keys: { benchmarkId: 1, project: 1, startedAt: -1 } },
  // synthesis
  { collection: COLLECTIONS.SYNTHESIS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.SYNTHESIS, keys: { project: 1, username: 1, updatedAt: -1 } },
  { collection: COLLECTIONS.AGENT_SKILLS, keys: { project: 1, username: 1 } },
  // agent_rules
  { collection: COLLECTIONS.AGENT_RULES, keys: { project: 1, username: 1, agent: 1 } },
  // mcp_servers
  { collection: COLLECTIONS.MCP_SERVERS, keys: { project: 1, username: 1 } },
  // mcp_servers — compound for enabled filter (5+ query sites)
  { collection: COLLECTIONS.MCP_SERVERS, keys: { project: 1, username: 1, enabled: 1 } },
  // workspaces
  { collection: COLLECTIONS.WORKSPACES, keys: { project: 1, username: 1 } },
  { collection: COLLECTIONS.WORKSPACES, keys: { id: 1 }, options: { unique: true } },
  // prompts
  { collection: COLLECTIONS.PROMPTS, keys: { project: 1, username: 1, updatedAt: -1 } },
  { collection: COLLECTIONS.PROMPTS, keys: { id: 1 }, options: { unique: true } },
  // webhook_subscriptions
  { collection: COLLECTIONS.WEBHOOK_SUBSCRIPTIONS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.WEBHOOK_SUBSCRIPTIONS, keys: { enabled: 1 } },
  // somatic_state — unique per agent
  { collection: COLLECTIONS.SOMATIC_STATE, keys: { agentId: 1 }, options: { unique: true } },
  // workflow_memories — retrieval query index
  { collection: COLLECTIONS.WORKFLOW_MEMORIES, keys: { agent: 1, project: 1, createdAt: -1 } },
  // pending_decisions — durable approvals (settled records expire via expiresAt)
  { collection: COLLECTIONS.PENDING_DECISIONS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.PENDING_DECISIONS, keys: { conversationId: 1, status: 1 } },
  { collection: COLLECTIONS.PENDING_DECISIONS, keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  // workflow_memories — uniqueness per agent conversation
  { collection: COLLECTIONS.WORKFLOW_MEMORIES, keys: { conversationId: 1, agentConversationId: 1 }, options: { unique: true } },
];
