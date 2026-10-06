// ─── Memory Consolidation Types ─────────────────────────────
// Shared type definitions for the memory consolidation subsystem.

/** Memory document shape from MongoDB */
export interface MemoryDoc {
  id: string;
  type: string;
  title?: string | null;
  content: string;
  createdAt: string;
  embedding?: number[] | null;
  semanticEmbedding?: import("../SemanticEmbedding.ts").IndexedEmbedding;
  aboutUserId?: string;
  aboutUsername?: string;
  sourceUserId?: string;
  sourceUsername?: string;
  guildId?: string;
  [key: string]: unknown;
}

/** Consolidation action from the LLM */
export interface ConsolidationAction {
  type: "merge" | "delete";
  sourceIds?: string[];
  merged?: { type: string; title?: string; content: string };
  id?: string;
  reason?: string;
}

/** Partition attribution metadata for conversational agents */
export interface PartitionMeta {
  aboutUserId: string;
  aboutUsername: string;
  sourceUserId: string;
  sourceUsername: string;
}

/** Single batch of work for the LLM */
export interface ConsolidationBatch {
  clusters: MemoryDoc[][];
  stale: MemoryDoc[];
  partitionMeta?: PartitionMeta;
}

/** Options for processBatch */
export interface ProcessBatchOptions {
  provider: import("../../types/provider.ts").Provider;
  consolidationProvider: string;
  consolidationModel: string;
  agent: string;
  project: string | null;
  username: string;
  trigger: string;
  endpoint?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  broadcast?: ((event: Record<string, unknown>) => void) | null;
  systemPrompt?: string;
  inputBuilder?: (
    clusters: MemoryDoc[][],
    stale: MemoryDoc[],
    meta?: PartitionMeta,
  ) => string | null;
}

/** Options for applyActions */
export interface ApplyActionsOptions {
  traceId?: string | null;
  endpoint?: string | null;
  memoryLookup?: Map<string, MemoryDoc>;
}

/** Options for consolidate() */
export interface ConsolidateOptions {
  agent?: string;
  project?: string | null;
  username?: string;
  trigger?: string;
  broadcast?: ((event: Record<string, unknown>) => void) | null;
  endpoint?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  guildId?: string | null;
}

/** Options for checkAndRun() */
export interface CheckAndRunOptions {
  project?: string | null;
  username?: string;
  broadcast?: ((event: Record<string, unknown>) => void) | null;
  endpoint?: string | null;
  agent?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
}

