export interface IndexedEmbedding {
  vector: number[];
  space: string;
}

export function indexedEmbedding(result: { embedding: number[]; space: string }): IndexedEmbedding {
  return { vector: result.embedding, space: result.space };
}

/** Untagged legacy vectors never participate in a new model's similarity search. */
export function compatibleVector(value: unknown, space: string): number[] | null {
  const candidate = value as IndexedEmbedding | undefined;
  const dimensions = Number(space.match(/:(\d+):/)?.[1]);
  return candidate?.space === space && Array.isArray(candidate.vector) && candidate.vector.length === dimensions && dimensions > 0 && candidate.vector.every(Number.isFinite)
    ? candidate.vector : null;
}
