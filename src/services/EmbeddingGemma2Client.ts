import { ProviderError } from "../utils/errors.ts";
import type { EmbeddingContent } from "../types/provider.ts";

export const EMBEDDING_PROVIDER = "jetson-embedding";
export const EMBEDDING_MODEL = "embeddinggemma-2";
export const EMBEDDING_REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b";
export const CHUNK_BYTES = 1800;
export function embeddingSpace(dimensions = 768) {
  return `google/embeddinggemma-2@${EMBEDDING_REVISION}:${dimensions}:retrieval:utf8-${CHUNK_BYTES}-mean-l2-v1`;
}
const baseUrl = () => (process.env.HARNESS_EMBEDDING_URL || "http://10.0.0.30:8001/v1").replace(/\/$/, "");
let queue: Promise<unknown> = Promise.resolve();
let identityCheckedAt = 0;

/** Byte-bounded chunks avoid assuming that character counts equal token counts. */
export function embeddingChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > CHUNK_BYTES) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new ProviderError(EMBEDDING_PROVIDER, "Invalid embedding vector", 502);
  return vector.map(value => value / norm);
}

function taskName(task?: string): string | undefined {
  if (!task) return undefined;
  const mapping: Record<string, string> = {
    RETRIEVAL_QUERY: "query", RETRIEVAL_DOCUMENT: "document", SEMANTIC_SIMILARITY: "similarity",
    query: "query", document: "document", similarity: "similarity",
  };
  if (!mapping[task]) throw new ProviderError(EMBEDDING_PROVIDER, "Unsupported embedding task", 400);
  return mapping[task];
}

async function checkIdentity() {
  if (Date.now() - identityCheckedAt < 60_000) return;
  const response = await fetch(`${baseUrl().replace(/\/v1$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new ProviderError(EMBEDDING_PROVIDER, "Embedding health check failed", response.status);
  const health = await response.json() as Record<string, unknown>;
  if (health.model !== "google/embeddinggemma-2" || health.revision !== EMBEDDING_REVISION || health.dimensions !== 768) {
    throw new ProviderError(EMBEDDING_PROVIDER, "Embedding identity differs from the indexed model revision", 503);
  }
  if (health.ready !== true || health.quarantine_reason) throw new ProviderError(EMBEDDING_PROVIDER, "Embedding service is not ready", 503);
  identityCheckedAt = Date.now();
}

async function request(inputs: string[], task: string | undefined, dimensions: number): Promise<number[][]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${baseUrl()}/embeddings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs, encoding_format: "float", dimensions, ...(task ? { input_type: task } : {}) }),
    });
    if (response.status === 429 && attempt < 2) {
      const delay = Number(response.headers.get("Retry-After") || "1");
      if (!Number.isFinite(delay) || delay < 0 || delay > 10) throw new ProviderError(EMBEDDING_PROVIDER, "Embedding service busy", 429);
      await new Promise(resolve => setTimeout(resolve, delay * 1000));
      continue;
    }
    // Refusals (including quarantine/503 and token limits) are never retried.
    if (!response.ok) throw new ProviderError(EMBEDDING_PROVIDER, `Embedding request refused (HTTP ${response.status})`, response.status);
    const payload = await response.json() as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) throw new ProviderError(EMBEDDING_PROVIDER, "Embedding response count mismatch", 502);
    const ordered = payload.data.sort((a, b) => a.index - b.index);
    return ordered.map((item, index) => {
      if (item.index !== index || !Array.isArray(item.embedding) || item.embedding.length !== dimensions || !item.embedding.every(Number.isFinite)) {
        throw new ProviderError(EMBEDDING_PROVIDER, "Embedding response order/dimensions invalid", 502);
      }
      return normalizeVector(item.embedding);
    });
  }
  throw new ProviderError(EMBEDDING_PROVIDER, "Embedding service busy", 429);
}

export const EmbeddingGemma2Client = {
  async embedMany(texts: string[], task = "document", dimensions = 768): Promise<number[][]> {
    const inputType = taskName(task);
    if (!Number.isInteger(dimensions) || dimensions < 128 || dimensions > 768) throw new ProviderError(EMBEDDING_PROVIDER, "Dimensions must be 128–768", 400);
    if (!texts.length || texts.some(text => typeof text !== "string" || !text.trim())) throw new ProviderError(EMBEDDING_PROVIDER, "Embedding requires non-empty text", 400);
    const job = queue.then(async () => {
      await checkIdentity();
      const chunks = texts.flatMap((text, owner) => embeddingChunks(text).map(input => ({ input, owner })));
      const sums = texts.map(() => Array<number>(dimensions).fill(0));
      // Pack at most eight chunks under a conservative aggregate byte budget.
      // The server remains responsible for exact tokenizer admission.
      for (let offset = 0; offset < chunks.length;) {
        const batch: typeof chunks = [];
        let bytes = 0;
        while (offset < chunks.length && batch.length < 8) {
          const chunk = chunks[offset];
          const size = Buffer.byteLength(chunk.input);
          if (batch.length && bytes + size > 7000) break;
          batch.push(chunk); bytes += size; offset++;
        }
        const vectors = await request(batch.map(chunk => chunk.input), inputType, dimensions);
        batch.forEach((chunk, i) => vectors[i].forEach((value, d) => sums[chunk.owner][d] += value));
      }
      return sums.map(normalizeVector);
    });
    queue = job.catch(() => undefined);
    return job;
  },
  async generate(content: EmbeddingContent, task?: string, dimensions = 768) {
    if (typeof content !== "string") throw new ProviderError(EMBEDDING_PROVIDER, "This embedding endpoint returns one text vector; use individual requests for multiple documents", 400);
    const [embedding] = await this.embedMany([content], task || "", dimensions);
    return { embedding, dimensions };
  },
};
