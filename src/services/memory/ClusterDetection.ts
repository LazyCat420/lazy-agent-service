// ─── Memory Cluster Detection ───────────────────────────────
// Union-Find based clustering of semantically similar memories
// using cosine similarity of embedding vectors.
// Extracted from MemoryConsolidationService.ts

import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import type { MemoryDoc } from "./types.ts";

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
export function findClusters(
  memories: MemoryDoc[],
  threshold: number = CLUSTER_THRESHOLD,
): MemoryDoc[][] {
  const memoryCount = memories.length;
  if (memoryCount < 2) return [];

  // Union-Find data structures
  const parent = Array.from({ length: memoryCount }, (_, i) => i);
  const rank = new Array(memoryCount).fill(0);

  function find(x: number): number {
    if (parent[x] !== x) {
      parent[x] = find(parent[x]);
    }
    return parent[x];
  }

  function union(x: number, y: number): void {
    const parentX = find(x);
    const parentY = find(y);
    if (parentX === parentY) return;
    if (rank[parentX] < rank[parentY]) {
      parent[parentX] = parentY;
    } else if (rank[parentX] > rank[parentY]) {
      parent[parentY] = parentX;
    } else {
      parent[parentY] = parentX;
      rank[parentX]++;
    }
  }

  // Pairwise comparison
  for (let i = 0; i < memoryCount; i++) {
    for (let j = i + 1; j < memoryCount; j++) {
      const first = memories[i].semanticEmbedding;
      const second = memories[j].semanticEmbedding;
      if (!first || !second || first.space !== second.space || first.vector.length !== second.vector.length) continue;
      const similarity = cosineSimilarity(
        first.vector,
        second.vector,
      );
      if (similarity > threshold) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map<number, MemoryDoc[]>();
  for (let i = 0; i < memoryCount; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(memories[i]);
  }

  // Only return clusters with 2+ members, capped at MAX_CLUSTER_SIZE
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => group.slice(0, MAX_CLUSTER_SIZE));
}
