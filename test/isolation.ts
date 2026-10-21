import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/services/RunStore.ts";
const directory = mkdtempSync(join(tmpdir(), "runtime-test-"));
RunStore.setPersistenceFile(join(directory, "runs.json"));
process.env.PRISM_PROXY_SESSIONS_FILE = join(directory, "prism-proxy-sessions.json");
const originalFetch = globalThis.fetch;

// Copy of EMBEDDING_REVISION (src/services/EmbeddingGemma2Client.ts:6). Not imported: modules a vitest
// setup file imports are cached before the test file runs, so test-file vi.mock() of that client would not apply.
const EMBEDDING_REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b";

/** Deterministic, finite, non-zero vector derived from the text (FNV-1a seed). */
function fixtureEmbedding(text: string, dimensions: number): number[] {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619) >>> 0;
  return Array.from({ length: dimensions }, (_, d) => Math.sin(hash + d + 1) + 1.5);
}

/** Fixture for the embedding service; undefined when the URL is not an embedding endpoint. */
function embeddingFixture(href: string, init?: RequestInit): Response | undefined {
  // Same base URL expression as EmbeddingGemma2Client's `baseUrl()`, read per call so tests may override the env.
  const base = (process.env.HARNESS_EMBEDDING_URL || "http://10.0.0.30:8001/v1").replace(/\/$/, "");
  const root = base.replace(/\/v1$/, "");
  if (!href.startsWith(root)) return undefined;
  if (href === `${root}/health`) {
    return Response.json({ model: "google/embeddinggemma-2", revision: EMBEDDING_REVISION, dimensions: 768, ready: true });
  }
  if (href === `${base}/embeddings` && typeof init?.body === "string") {
    const { input, dimensions } = JSON.parse(init.body) as { input: string[]; dimensions: number };
    return Response.json({ data: input.map((text, index) => ({ index, embedding: fixtureEmbedding(text, dimensions) })) });
  }
  return undefined;
}

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return originalFetch(input, init);
  const fixture = embeddingFixture(href, init);
  if (fixture) return fixture;
  throw new Error("External fetch disabled in tests; supply a fixture");
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
