// ─── Conversational Memory Partitioner ───────────────────────
// Partitions conversational agent memories by observer-subject pairs
// and identifies stale fast-decaying categories.
// Extracted from MemoryConsolidationService.ts
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
/** Conversational agent type-aware staleness — only fast-decaying categories get flagged */
export const CONVERSATIONAL_STALENESS_CONFIG = {
    gaming: 60,
    work: 90,
    achievement: 90,
};
/**
 * Partition conversational agent memories by (aboutUserId, sourceUserId) so each
 * partition represents one observer's perspective about one subject. This ensures
 * we never merge facts across different people or different observers.
 *
 * Returns a Map where keys are "aboutUserId::sourceUserId" and values are
 * arrays of memory documents.
 */
export function partitionConversationalMemories(memories) {
    const partitions = new Map();
    for (const memory of memories) {
        const aboutUserId = memory.aboutUserId || "_unknown";
        const sourceUserId = memory.sourceUserId || "_unknown";
        const key = `${aboutUserId}::${sourceUserId}`;
        if (!partitions.has(key))
            partitions.set(key, []);
        partitions.get(key).push(memory);
    }
    return partitions;
}
/**
 * Identify stale conversational agent memories using type-aware thresholds.
 * Only fast-decaying categories (gaming, work, achievement) are flagged.
 */
export function findStaleConversationalMemories(memories) {
    return memories.filter((memory) => {
        const threshold = CONVERSATIONAL_STALENESS_CONFIG[memory.type];
        if (!threshold)
            return false; // durable types (personal, preference, etc.) are never stale
        return daysSinceIso(memory.createdAt) > threshold;
    });
}
//# sourceMappingURL=ConversationalMemoryPartitioner.js.map