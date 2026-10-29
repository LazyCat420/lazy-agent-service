import { createUsageAccumulator } from "../utils/CostCalculator.js";
/**
 * AgenticLoopState — encapsulates all mutable accumulated state
 * for an agentic loop execution.
 *
 * Harness implementations populate this during `run()` and the
 * finalization logic reads from it to persist and emit results.
 *
 * Separating state from logic makes it possible for different
 * harnesses to share finalization, progress emission, and DB
 * persistence code without inheritance coupling.
 */
export default class AgenticLoopState {
    // ── Iteration tracking ──────────────────────────────────
    iterations;
    loadedTools;
    // ── Usage / cost accumulation ────────────────────────────
    overallUsage;
    overallFirstTokenTime;
    overallGenerationEnd;
    overallOutputCharacters;
    // ── Streamed content ────────────────────────────────────
    finalStreamedText;
    streamedThinking;
    streamedImages;
    streamedToolCalls;
    streamedAudioChunks;
    audioSampleRate;
    lastRateLimits;
    // ── Display segment tracking ────────────────────────────
    // Mirrors the client-side contentSegments system so the
    // interleaving order (thinking ↔ tools ↔ text) survives DB
    // round-trips for proper rendering on conversation restore.
    displaySegments;
    displayTextFragments;
    displayThinkingFragments;
    lastDisplaySegType;
    // ── Plan mode ───────────────────────────────────────────
    planModeActive;
    planModeText;
    // ── Message management ──────────────────────────────────
    // Track the initial message count so we can slice only NEW
    // messages for DB persistence. The client sends the full
    // history; we must not re-append already-persisted messages.
    originalMessageCount;
    // ── Compaction tracking ─────────────────────────────────
    // Set when LLM-powered auto-compaction fires during the loop.
    compactionPerformed;
    preCompactTokenCount;
    postCompactTokenCount;
    // ── Error budget tracking ───────────────────────────────
    toolErrorCounts;
    // ── Conversation outcome ───────────────────────────
    // Set by harnesses before finalization to indicate how the
    // conversation ended. Used by afterResponse hooks (e.g. AWM) to
    // gate actions that should only run on successful completions.
    conversationOutcome;
    // ── Branch tracking (TreeOfThought) ─────────────────────
    branchesExplored;
    branchesBacktracked;
    proactiveBacktracks;
    selectedBranchScores;
    frontierCandidates;
    // ── High-water marks ────────────────────────────────────
    // Token counts emitted to the frontend must be monotonically
    // non-decreasing. These prevent dips at iteration boundaries.
    hwmOutputTokens;
    hwmInputTokens;
    hwmTotalTokens;
    hwmOutputCharacters;
    // ── Progress emission throttling ────────────────────────
    PROGRESS_CHUNK_INTERVAL = 10;
    PROGRESS_TIME_INTERVAL_MS = 500;
    lastProgressEmitTime;
    chunksSinceLastProgress;
    constructor({ originalMessageCount = 0, planModeActive = false, } = {}) {
        this.iterations = 0;
        this.overallUsage = createUsageAccumulator();
        this.overallFirstTokenTime = null;
        this.overallGenerationEnd = null;
        this.overallOutputCharacters = 0;
        this.finalStreamedText = "";
        this.streamedThinking = "";
        this.streamedImages = [];
        this.streamedToolCalls = [];
        this.streamedAudioChunks = [];
        this.audioSampleRate = 24000;
        this.lastRateLimits = null;
        this.displaySegments = [];
        this.displayTextFragments = [];
        this.displayThinkingFragments = [];
        this.lastDisplaySegType = null;
        this.planModeActive = planModeActive;
        this.planModeText = "";
        this.originalMessageCount = originalMessageCount;
        this.compactionPerformed = false;
        this.preCompactTokenCount = null;
        this.postCompactTokenCount = null;
        this.toolErrorCounts = new Map();
        this.conversationOutcome = "completed";
        this.branchesExplored = 0;
        this.branchesBacktracked = 0;
        this.proactiveBacktracks = 0;
        this.selectedBranchScores = [];
        this.frontierCandidates = [];
        this.hwmOutputTokens = 0;
        this.hwmInputTokens = 0;
        this.hwmTotalTokens = 0;
        this.hwmOutputCharacters = 0;
        this.lastProgressEmitTime = 0;
        this.chunksSinceLastProgress = 0;
        this.loadedTools = new Set();
    }
    /** Get clean display segments (trimmed, empty-filtered) for DB persistence. */
    getCleanDisplayData() {
        const cleanSegments = [];
        const cleanTextFragments = [];
        const cleanThinkingFragments = [];
        for (const segment of this.displaySegments) {
            if (segment.type === "text") {
                const trimmed = this.displayTextFragments[segment.fragmentIndex]?.trim();
                if (!trimmed)
                    continue;
                cleanSegments.push({
                    type: "text",
                    fragmentIndex: cleanTextFragments.length,
                });
                cleanTextFragments.push(trimmed);
            }
            else if (segment.type === "thinking") {
                const trimmed = this.displayThinkingFragments[segment.fragmentIndex]?.trim();
                if (!trimmed)
                    continue;
                cleanSegments.push({
                    type: "thinking",
                    fragmentIndex: cleanThinkingFragments.length,
                });
                cleanThinkingFragments.push(trimmed);
            }
            else {
                cleanSegments.push(segment); // tools segments pass through
            }
        }
        return { cleanSegments, cleanTextFragments, cleanThinkingFragments };
    }
}
//# sourceMappingURL=AgenticLoopState.js.map