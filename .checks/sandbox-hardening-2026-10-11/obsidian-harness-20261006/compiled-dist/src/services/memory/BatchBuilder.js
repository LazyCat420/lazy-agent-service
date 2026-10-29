// ─── Memory Consolidation Batch Builder ──────────────────────
// Partitions clusters and stale memories into LLM-friendly batches
// that respect the input token budget.
// Extracted from MemoryConsolidationService.ts
import { estimateTokens } from "../../utils/CostCalculator.js";
import { formatMemoryEntry } from "./ConsolidationPrompts.js";
/** Max clusters per LLM batch — keeps input well under context window limits */
export const BATCH_MAX_CLUSTERS = 5;
/** Max stale memories per LLM batch */
export const BATCH_MAX_STALE = 10;
/** Soft token budget for the user message portion of a batch (leaves room for system prompt + output) */
export const BATCH_INPUT_TOKEN_BUDGET = 12_000;
/**
 * Partition clusters and stale memories into batches that stay within
 * the input token budget. Each batch gets up to BATCH_MAX_CLUSTERS
 * clusters and BATCH_MAX_STALE stale memories, with a hard token cap.
 */
export function buildBatches(clusters, staleMemories) {
    const batches = [];
    let clusterIndex = 0;
    let staleIndex = 0;
    // First, batch clusters (primary merge candidates)
    while (clusterIndex < clusters.length) {
        const batchClusters = [];
        let batchTokens = 0;
        while (clusterIndex < clusters.length &&
            batchClusters.length < BATCH_MAX_CLUSTERS) {
            const clusterText = clusters[clusterIndex]
                .map(formatMemoryEntry)
                .join("\n");
            const clusterTokens = estimateTokens(clusterText);
            if (batchTokens + clusterTokens > BATCH_INPUT_TOKEN_BUDGET &&
                batchClusters.length > 0) {
                break; // This cluster would exceed budget — start a new batch
            }
            batchClusters.push(clusters[clusterIndex]);
            batchTokens += clusterTokens;
            clusterIndex++;
        }
        // Attach stale memories to the first cluster batch that has room
        const batchStale = [];
        while (staleIndex < staleMemories.length &&
            batchStale.length < BATCH_MAX_STALE) {
            const entryText = formatMemoryEntry(staleMemories[staleIndex]);
            const entryTokens = estimateTokens(entryText);
            if (batchTokens + entryTokens > BATCH_INPUT_TOKEN_BUDGET &&
                batchStale.length > 0) {
                break;
            }
            batchStale.push(staleMemories[staleIndex]);
            batchTokens += entryTokens;
            staleIndex++;
        }
        if (batchClusters.length > 0 || batchStale.length > 0) {
            batches.push({ clusters: batchClusters, stale: batchStale });
        }
    }
    // Any remaining stale memories that didn't fit into cluster batches
    while (staleIndex < staleMemories.length) {
        const batchStale = [];
        let batchTokens = 0;
        while (staleIndex < staleMemories.length &&
            batchStale.length < BATCH_MAX_STALE) {
            const entryText = formatMemoryEntry(staleMemories[staleIndex]);
            const entryTokens = estimateTokens(entryText);
            if (batchTokens + entryTokens > BATCH_INPUT_TOKEN_BUDGET &&
                batchStale.length > 0) {
                break;
            }
            batchStale.push(staleMemories[staleIndex]);
            batchTokens += entryTokens;
            staleIndex++;
        }
        if (batchStale.length > 0) {
            batches.push({ clusters: [], stale: batchStale });
        }
    }
    return batches;
}
//# sourceMappingURL=BatchBuilder.js.map