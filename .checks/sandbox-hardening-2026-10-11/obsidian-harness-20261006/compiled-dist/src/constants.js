// ─────────────────────────────────────────────────────────────
// Prism — Application Constants
// ─────────────────────────────────────────────────────────────
// ─── Timing Constants ───────────────────────────────────────
/** SSE keep-alive ping interval for admin streaming endpoints. */
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
/** Reconnect interval for MongoDB change stream watchers. */
export const CHANGE_STREAM_RECONNECT_MS = 60_000;
/** Retry delay for reopening a failed change stream. */
export const CHANGE_STREAM_RETRY_MS = 5000;
/** Cache TTL for directory listings. */
export const DIRECTORY_CACHE_TTL_MS = 60_000;
/** CORS preflight cache duration — 24 hours. */
export const CORS_MAX_AGE_SECONDS = 86_400;
// ─── Tool Orchestration Timeouts ────────────────────────────
export const TOOL_SCHEMA_FETCH_TIMEOUT_MS = 5000;
export const TOOL_CONFIG_FETCH_TIMEOUT_MS = 3000;
export const TOOL_WORKSPACE_UPDATE_TIMEOUT_MS = 10000;
export const TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS = 5000;
export const TOOL_API_HEALTH_TIMEOUT_MS = 3000;
export const DIRECTORY_FETCH_TIMEOUT_MS = 5000;
/**
 * MongoDB collection names — single source of truth.
 * Import from here instead of defining local `const COLLECTION = "..."`.
 */
export const COLLECTIONS = {
    REQUESTS: "requests",
    MODEL_CONVERSATIONS: "model_conversations",
    AGENT_CONVERSATIONS: "agent_conversations",
    WORKFLOWS: "workflows",
    BENCHMARKS: "benchmarks",
    BENCHMARK_RUNS: "benchmark_runs",
    SYNTHESIS: "synthesis",
    FAVORITES: "favorites",
    AGENT_SKILLS: "agent_skills",
    AGENT_RULES: "agent_rules",
    MCP_SERVERS: "mcp_servers",
    MEMORIES: "memories",
    MEMORY_CONSOLIDATION_RUNS: "memory_consolidation_runs",
    MEMORY_CONSOLIDATION_HISTORY: "memory_consolidation_history",
    VRAM_BENCHMARKS: "vram_benchmarks",
    SETTINGS: "settings",
    CUSTOM_AGENTS: "custom_agents",
    WORKSPACES: "workspaces",
    TOOL_CONTEXT: "tool_context",
    SCHEDULED_TASKS: "scheduled_tasks",
    CONVERSATION_TIMERS: "conversation_timers",
    PROMPTS: "prompts",
    WEBHOOK_SUBSCRIPTIONS: "webhook_subscriptions",
    SOMATIC_STATE: "somatic_state",
    WORKFLOW_MEMORIES: "workflow_memories",
};
/**
 * Reusable MongoDB $group aggregation expression for summing estimated costs.
 * Sums the per-request `estimatedCost` field (USD, nullable).
 * Convention: aggregation outputs use `totalCost` as the destination field name.
 * Usage: `totalCost: COST_SUM_EXPR` inside `$group` stages.
 */
export const COST_SUM_EXPR = { $sum: { $ifNull: ["$estimatedCost", 0] } };
/**
 * Reusable MongoDB $group aggregation expression for summing total tokens.
 * Adds inputTokens + outputTokens (both nullable).
 * Usage: `totalTokens: TOTAL_TOKENS_EXPR` inside `$group` stages.
 */
export const TOTAL_TOKENS_EXPR = {
    $sum: {
        $add: [{ $ifNull: ["$inputTokens", 0] }, { $ifNull: ["$outputTokens", 0] }],
    },
};
/**
 * Reusable MongoDB $group aggregation expression for averaging tok/s.
 * Filters out null and outlier (>10k) values before averaging.
 * Usage: `avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR` inside `$group` stages.
 */
export const AVG_TOKENS_PER_SEC_EXPR = {
    $avg: {
        $cond: [
            {
                $and: [
                    { $ne: ["$tokensPerSec", null] },
                    { $lte: ["$tokensPerSec", 10000] },
                ],
            },
            "$tokensPerSec",
            null,
        ],
    },
};
// ─── Provider & Modality Constants (re-exported from utilities-library) ──
export { PROVIDERS, PROVIDER_LIST } from "@rodrigo-barraza/utilities-library/taxonomy";
export const TYPES = {
    TEXT: "text",
    IMAGE: "image",
    AUDIO: "audio",
    VIDEO: "video",
    PDF: "pdf",
    EMBEDDING: "embedding",
};
export const MODEL_TYPES = {
    CONVERSATION: "conversation",
    AUDIO: "audio",
    EMBED: "embed",
};
export const WORKFLOW_ENDPOINTS = {
    TEXT_TO_TEXT: "textToText",
    TEXT_TO_IMAGE: "textToImage",
    AUDIO_TO_TEXT: "audioToText",
    TEXT_TO_SPEECH: "textToSpeech",
    MODALITY_TO_EMBEDDING: "modalityToEmbedding",
};
export const FILE_CATEGORIES = {
    GENERATIONS: "generations",
    UPLOADS: "uploads",
    SCREENSHOTS: "screenshots",
    PROJECTS: "projects",
};
// ─── Harness & Thought Structure Identifiers ───────────────
export const HARNESS_IDS = {
    STANDARD: "standard",
};
// Re-exported from utilities-library (single source of truth)
export { THOUGHT_STRUCTURES } from "@rodrigo-barraza/utilities-library/taxonomy";
// ─── Prompt Construction Delimiters ──────────────────────────
export const PROMPT_DELIMITERS = {
    SYSTEM_CONTEXT: "[System Context]",
    SYSTEM_CONTEXT_LOCAL_TIME_PREFIX: "[System Context - Local Time:",
    CONTEXT_NOTE_PREFIX: "[Context Note:",
    USER_MESSAGE: "[User Message]",
    PROJECT_SKILLS: "[Project Skills]",
    AGENT_MEMORY: "[Agent Memory]",
    SOMATIC_STATE_PREFIX: "[Somatic State",
    CONVERSATION_SUMMARY_PREFIX: "[Conversation Summary",
};
//# sourceMappingURL=constants.js.map