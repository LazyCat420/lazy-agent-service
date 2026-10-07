import { it, expect, vi, beforeEach } from "vitest";
import { ProviderError } from "../../src/utils/errors.ts";

const fixture = vi.hoisted(() => ({ generateMany: vi.fn() }));
vi.mock("../../src/services/EmbeddingService.ts", () => ({ default: { generateMany: fixture.generateMany }, MAX_BATCH_TEXTS: 32 }));
const { default: router } = await import("../../src/routes/OpenAIEmbeddingsRoutes.ts");
const handler = (router as any).stack.find((layer: any) => layer.route?.path === "/").route.stack[0].handle;

function call(body: unknown, req: Record<string, unknown> = {}) {
  return new Promise<{ status: number; body: any }>(resolve => {
    let status = 200;
    const res: any = { status(code: number) { status = code; return res; }, json(payload: unknown) { resolve({ status, body: payload }); return res; } };
    handler({ body, ...req }, res, (error: unknown) => resolve({ status: 500, body: { error } }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.generateMany.mockImplementation(async (texts: string[], options: any) => ({
    embeddings: texts.map((_t, i) => [i === 0 ? 0.6 : 0, 0.8]), dimensions: 2, provider: "jetson-embedding",
    model: "embeddinggemma-2", space: `space:${options.taskType}`,
  }));
});

it("answers a plain OpenAI request in the OpenAI shape, with the symmetric task by default", async () => {
  const { status, body } = await call({ model: "embeddinggemma-2", input: "How do I restart the kit?" });
  expect(status).toBe(200);
  expect(body).toMatchObject({ object: "list", model: "embeddinggemma-2", space: "space:similarity", data: [{ object: "embedding", index: 0, embedding: [0.6, 0.8] }] });
  expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  expect(fixture.generateMany).toHaveBeenCalledWith(["How do I restart the kit?"], expect.objectContaining({ taskType: "similarity", source: "openai", project: "openai-compatible" }));
});

it("passes an explicit task and batch through, and encodes base64 as little-endian float32", async () => {
  const { body } = await call({ input: ["doc one", "doc two"], input_type: "document", encoding_format: "base64" }, { project: "omp" });
  expect(fixture.generateMany).toHaveBeenCalledWith(["doc one", "doc two"], expect.objectContaining({ taskType: "document", project: "omp" }));
  const decoded = Buffer.from(body.data[0].embedding, "base64");
  expect(decoded.readFloatLE(0)).toBeCloseTo(0.6, 5);
  expect(body.data.map((d: any) => d.index)).toEqual([0, 1]);
});

it("refuses unknown models, bad inputs and bad encodings with an OpenAI error body", async () => {
  for (const body of [{ model: "text-embedding-3-small", input: "x" }, { input: [] }, { input: ["ok", ""] }, { input: [1, 2] },
    { input: Array(33).fill("x") }, { input: "x", encoding_format: "int8" }]) {
    const result = await call(body);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({ type: "invalid_request_error", message: expect.any(String) });
  }
  expect(fixture.generateMany).not.toHaveBeenCalled();
});

it("maps a quarantined or busy embedder to the matching status", async () => {
  fixture.generateMany.mockRejectedValueOnce(new ProviderError("jetson-embedding", "Embedding service is not ready", 503));
  expect(await call({ input: "x" })).toMatchObject({ status: 503, body: { error: { type: "server_error" } } });
  fixture.generateMany.mockRejectedValueOnce(new ProviderError("jetson-embedding", "Embedding service busy", 429));
  expect(await call({ input: "x" })).toMatchObject({ status: 429, body: { error: { type: "rate_limit_error" } } });
});
