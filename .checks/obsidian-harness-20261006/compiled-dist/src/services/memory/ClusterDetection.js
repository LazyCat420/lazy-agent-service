// ─── Memory Cluster Detection ───────────────────────────────
// Union-Find based clustering of semantically similar memories
// using cosine similarity of embedding vectors.
// Extracted from MemoryConsolidationService.ts
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
/** Cosine similarity above which two memories are clustered together */
export const CLUSTER_THRESHOLD = 0.75;
/** Conversational agents use a higher threshold — personal facts are shorter and more distinct */
export const CONVERSATIONAL_CLUSTER_THRESHOLD = 0.8;
/** Max memories per cluster sent to the LLM (avoid token blowup) */
export const MAX_CLUSTER_SIZE = 8;
/**
 * Find clusters of semantically similar memories using Union-Find.
 * Returns arrays of memory groups (each group has 2+ members).
 *
 * Uses O(n²) pairwise comparison — acceptable for <500 memories.
 */
export function findClusters(memories, threshold = CLUSTER_THRESHOLD) {
    const memoryCount = memories.length;
    if (memoryCount < 2)
        return [];
    // Union-Find data structures
    const parent = Array.from({ length: memoryCount }, (_, i) => i);
    const rank = new Array(memoryCount).fill(0);
    function find(x) {
        if (parent[x] !== x) {
            parent[x] = find(parent[x]);
        }
        return parent[x];
    }
    function union(x, y) {
        const parentX = find(x);
        const parentY = find(y);
        if (parentX === parentY)
            return;
        if (rank[parentX] < rank[parentY]) {
            parent[parentX] = parentY;
        }
        else if (rank[parentX] > rank[parentY]) {
            parent[parentY] = parentX;
        }
        else {
            parent[parentY] = parentX;
            rank[parentX]++;
        }
    }
    // Pairwise comparison
    for (let i = 0; i < memoryCount; i++) {
        for (let j = i + 1; j < memoryCount; j++) {
            if (!memories[i].embedding || !memories[j].embedding)
                continue;
            const similarity = cosineSimilarity(memories[i].embedding, memories[j].embedding);
            if (similarity > threshold) {
                union(i, j);
            }
        }
    }
    // Group by root
    const groups = new Map();
    for (let i = 0; i < memoryCount; i++) {
        const root = find(i);
        if (!groups.has(root)) {
            groups.set(root, []);
        }
        groups.get(root).push(memories[i]);
    }
    // Only return clusters with 2+ members, capped at MAX_CLUSTER_SIZE
    return [...groups.values()]
        .filter((group) => group.length >= 2)
        .map((group) => group.slice(0, MAX_CLUSTER_SIZE));
}
//# sourceMappingURL=ClusterDetection.js.map