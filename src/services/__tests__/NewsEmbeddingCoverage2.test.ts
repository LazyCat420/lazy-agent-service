/**
 * News search provider mapping/dedupe, embedding modality profiling, media
 * reference resolution and workflow retrieval. Network, MinIO, Mongo and the
 * embedding provider are faked; the mapping, scoring and formatting logic runs
 * for real.
 */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  topHeadlines: vi.fn(),
  uploadFile: vi.fn(),
  isMinioRef: vi.fn(),
  extractKey: vi.fn(),
  getFile: vi.fn(),
  getDb: vi.fn(),
  getProvider: vi.fn(),
  getMemoryModelConfig: vi.fn(),
  requestLog: vi.fn(),
  embedMany: vi.fn(),
}));

vi.mock("../../../config.ts", () => ({
  default: {
    GNEWS_API_KEY: "gnews-key", /* # secret-ok */
    WORLDNEWSAPI_KEY: "",
    CURRENTS_API_KEY: "",
    THENEWSAPI_KEY: "",
    NEWSAPI_API_KEY: "",
    NEWS_DEFAULT_COUNTRY: "us",
    MONGO_DB_NAME: "test-db",
  },
  MONGO_DB_NAME: "test-db",
}));
vi.mock("../EditorialHeadlinesService.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  topHeadlines: fakes.topHeadlines,
}));
vi.mock("../FileService.ts", () => ({
  default: {
    uploadFile: fakes.uploadFile,
    isMinioRef: fakes.isMinioRef,
    extractKey: fakes.extractKey,
    getFile: fakes.getFile,
  },
}));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: fakes.getDb },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../SettingsService.ts", () => ({
  default: { getMemoryModelConfig: fakes.getMemoryModelConfig },
}));
vi.mock("../RequestLogger.ts", () => ({ default: { log: fakes.requestLog } }));
vi.mock("../EmbeddingGemma2Client.ts", () => ({
  EmbeddingGemma2Client: { embedMany: fakes.embedMany },
  EMBEDDING_PROVIDER: "jetson-gemma",
  EMBEDDING_MODEL: "embeddinggemma-300m",
  embeddingSpace: (dimensions: number) => `gemma:${dimensions}:v1`,
}));

import EmbeddingService from "../EmbeddingService.ts";
import { resolveMediaReference } from "../MediaResolutionService.ts";
import { newsSearch } from "../NewsSearchService.ts";
import WorkflowMemoryService from "../WorkflowMemoryService.ts";

const EMBEDDING_SPACE = "vllm:emb-model:3:retrieval-v1";
const PAST_WORKFLOWS_HEADER = "## Past Successful Workflows";

beforeEach(() => {
  vi.resetAllMocks();
  fakes.topHeadlines.mockResolvedValue({ items: [], stale: false });
  fakes.getProvider.mockReturnValue({
    generateEmbedding: async () => ({ embedding: [1, 0, 0] }),
  });
  fakes.getMemoryModelConfig.mockResolvedValue({ provider: "vllm", model: "emb-model" });
  fakes.getDb.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newsSearch provider mapping", () => {
  const jsonResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const articles = {
    articles: [
      {
        title: "Alpha climate story",
        url: "https://a.example/1",
        image: "https://a.example/1.jpg",
        source: { name: "Alpha News" },
        description: "desc",
        publishedAt: "2026-10-01T00:00:00Z",
      },
      { title: "Alpha climate story", url: "https://b.example/2", image: "" },
      { title: "Different headline entirely", url: "https://a.example/1", image: "" },
      { title: "Beta market story", url: "https://c.example/3", image: "" },
    ],
  };

  it("maps, dedupes by URL and near-identical titles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(articles)));

    const result = await newsSearch("climate", 6);

    expect(result.source).toBe("gnews");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      title: "Alpha climate story",
      url: "https://a.example/1",
      image: "https://a.example/1.jpg",
      source: "Alpha News",
      snippet: "desc",
      date: "2026-10-01T00:00:00Z",
    });
    expect(result.items[1].source).toBe("c.example");
  });

  it("uses the top-headlines endpoint when the topic is empty and keyed is pinned", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(articles));
    vi.stubGlobal("fetch", fetchMock);

    const result = await newsSearch("", 6, "us", "", { source: "keyed" });

    expect(result.source).toBe("gnews");
    expect(fetchMock.mock.calls[0][0]).toContain("/top-headlines");
  });

  it("returns the editorial result when the editorial feeds answer", async () => {
    fakes.topHeadlines.mockResolvedValue({
      items: [
        {
          title: "Editorial lead",
          url: "https://news.example/lead",
          image: "",
          source: "news.example",
          snippet: "",
          date: "",
        },
      ],
      stale: false,
    });

    const result = await newsSearch("");

    expect(result.source).toBe("editorial");
    expect(result.items[0].title).toBe("Editorial lead");
  });

  it("marks a stale editorial answer", async () => {
    fakes.topHeadlines.mockResolvedValue({
      items: [
        {
          title: "Stale lead",
          url: "https://news.example/stale",
          image: "",
          source: "news.example",
          snippet: "",
          date: "",
        },
      ],
      stale: true,
    });

    const result = await newsSearch("");

    expect(result.source).toBe("editorial:stale");
  });

  it("falls back to keyed providers when the editorial path throws", async () => {
    fakes.topHeadlines.mockRejectedValue(new Error("feed down"));
    const fetchMock = vi.fn(async () => jsonResponse(articles));
    vi.stubGlobal("fetch", fetchMock);

    const result = await newsSearch("", 6, "us");

    expect(result.source).toBe("gnews");
    expect(fetchMock.mock.calls[0][0]).toContain("/top-headlines");
  });

  it("returns nothing when no provider is usable", async () => {
    fakes.topHeadlines.mockRejectedValue(new Error("feed down"));

    const result = await newsSearch("climate", 6, "us", "", { provider: "currentsapi" });

    expect(result).toEqual({ items: [], source: "" });
  });

  it("honours a pinned provider name", async () => {
    const result = await newsSearch("climate", 6, "us", "", { provider: "worldnewsapi" });

    expect(result).toEqual({ items: [], source: "" });
  });

  it("rethrows when the caller aborted the request", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("aborted");
    }));

    await expect(newsSearch("climate", 6, "us", "", {}, controller.signal)).rejects.toThrow(
      "aborted",
    );
  });

  it("cools a failing provider down and skips it next time", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await newsSearch("climate");
    const second = await newsSearch("climate");

    expect(first).toEqual({ items: [], source: "" });
    expect(second).toEqual({ items: [], source: "" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("EmbeddingService modality profiling", () => {
  it("records text-only modalities for a string input", async () => {
    const result = await EmbeddingService.generate("plain text");

    expect(result.dimensions).toBe(3);
    expect(fakes.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        modalities: { embeddingOut: true, textIn: true },
        requestPayload: { source: "any", contentType: "text", text: "plain text" },
      }),
    );
  });

  it("records every modality present in a multimodal input", async () => {
    await EmbeddingService.generate([
      "bare string part",
      { text: "labelled text" },
      { inlineData: { mimeType: "image/png", data: "AAA" } },
      { inlineData: { mimeType: "audio/wav", data: "AAA" } },
      { inlineData: { mimeType: "video/mp4", data: "AAA" } },
      { inlineData: { mimeType: "application/pdf", data: "AAA" } },
      { inlineData: { mimeType: "text/plain", data: "AAA" } },
    ]);

    expect(fakes.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        modalities: {
          embeddingOut: true,
          textIn: true,
          imageIn: true,
          audioIn: true,
          videoIn: true,
          docIn: true,
        },
        requestPayload: { source: "any", contentType: "multimodal" },
      }),
    );
  });

  it("records only the output modality for a non-text, non-array input", async () => {
    await EmbeddingService.generate(undefined as never);

    expect(fakes.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        modalities: { embeddingOut: true },
        requestPayload: { source: "any", contentType: "any" },
      }),
    );
  });

  it("logs the failure and rethrows when the provider rejects", async () => {
    fakes.getProvider.mockReturnValue({
      generateEmbedding: async () => {
        throw new Error("provider offline");
      },
    });

    await expect(EmbeddingService.generate("text", { project: "p" })).rejects.toThrow(
      "provider offline",
    );
    expect(fakes.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: "provider offline",
        modalities: { embeddingOut: true, textIn: true },
        responsePayload: { error: "provider offline" },
      }),
    );
  });

  it("rejects a provider without embedding support", async () => {
    fakes.getProvider.mockReturnValue({});

    await expect(EmbeddingService.generate("text")).rejects.toThrow(
      'Provider "vllm" does not support embeddings',
    );
  });

  it("embeds a batch through the Gemma client", async () => {
    fakes.getMemoryModelConfig.mockResolvedValue({
      provider: "jetson-gemma",
      model: "embeddinggemma-300m",
    });
    fakes.embedMany.mockResolvedValue([[1, 2], [3, 4]]);

    const result = await EmbeddingService.generateMany(["one", "two"]);

    expect(result).toEqual({
      embeddings: [[1, 2], [3, 4]],
      dimensions: 768,
      provider: "jetson-gemma",
      model: "embeddinggemma-300m",
      space: "gemma:768:v1",
    });
    expect(fakes.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        modalities: { textIn: true, embeddingOut: true },
        requestPayload: expect.objectContaining({ contentType: "text-batch", count: 2 }),
      }),
    );
  });

  it("logs and rethrows a failed Gemma batch", async () => {
    fakes.getMemoryModelConfig.mockResolvedValue({
      provider: "jetson-gemma",
      model: "embeddinggemma-300m",
    });
    fakes.embedMany.mockRejectedValue(new Error("queue full"));

    await expect(EmbeddingService.generateMany(["one"])).rejects.toThrow("queue full");
    expect(fakes.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: "queue full" }),
    );
  });

  it("rejects invalid batch inputs", async () => {
    await expect(EmbeddingService.generateMany([])).rejects.toThrow(
      "texts must hold 1–32 non-empty strings",
    );
    await expect(EmbeddingService.generateMany(["  "])).rejects.toThrow(
      "texts must hold 1–32 non-empty strings",
    );
    await expect(
      EmbeddingService.generateMany(new Array(33).fill("text")),
    ).rejects.toThrow("texts must hold 1–32 non-empty strings");
  });

  it("falls back to single generate calls for non-Gemma providers", async () => {
    const result = await EmbeddingService.generateMany(["one", "two"]);

    expect(result.embeddings).toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
    expect(result.space).toBe(EMBEDDING_SPACE);
  });
});

describe("resolveMediaReference", () => {
  const dataUrl = "data:application/pdf;base64,QUJD";

  it("uploads a data URL and returns the MinIO reference for storage", async () => {
    fakes.uploadFile.mockResolvedValue({ ref: "minio://bucket/uploads/x.pdf" });

    const result = await resolveMediaReference(dataUrl, "proj", "user");

    expect(result).toEqual({
      providerRef: dataUrl,
      storageRef: "minio://bucket/uploads/x.pdf",
    });
    expect(fakes.uploadFile).toHaveBeenCalledWith(dataUrl, "uploads", "proj", "user");
  });

  it("keeps the data URL when the MinIO upload fails", async () => {
    fakes.uploadFile.mockRejectedValue(new Error("minio down"));

    const result = await resolveMediaReference(dataUrl, "proj", "user");

    expect(result).toEqual({ providerRef: dataUrl, storageRef: dataUrl });
  });

  it("downloads a MinIO reference into a data URL for the provider", async () => {
    fakes.isMinioRef.mockReturnValue(true);
    fakes.extractKey.mockReturnValue("projects/p/uploads/x.pdf");
    fakes.getFile.mockResolvedValue({
      contentType: "application/pdf",
      stream: Readable.from([Buffer.from("ABC"), Buffer.from("D")]),
    });

    const result = await resolveMediaReference("minio://bucket/x.pdf", "p", "u");

    expect(result).toEqual({
      providerRef: "data:application/pdf;base64,QUJDRA==",
      storageRef: "minio://bucket/x.pdf",
    });
  });

  it("passes the reference through when the MinIO object is missing", async () => {
    fakes.isMinioRef.mockReturnValue(true);
    fakes.extractKey.mockReturnValue("missing");
    fakes.getFile.mockResolvedValue(null);

    const result = await resolveMediaReference("minio://bucket/missing", "p", "u");

    expect(result).toEqual({
      providerRef: "minio://bucket/missing",
      storageRef: "minio://bucket/missing",
    });
  });

  it("passes the reference through when the MinIO read throws", async () => {
    fakes.isMinioRef.mockReturnValue(true);
    fakes.extractKey.mockReturnValue("broken");
    fakes.getFile.mockRejectedValue(new Error("io error"));

    const result = await resolveMediaReference("minio://bucket/broken", "p", "u");

    expect(result).toEqual({
      providerRef: "minio://bucket/broken",
      storageRef: "minio://bucket/broken",
    });
  });

  it("fetches an HTTP reference into a data URL", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/pdf" },
      arrayBuffer: async () => new Uint8Array([65, 66, 67]).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveMediaReference("https://example.com/x.pdf", "p", "u");

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/x.pdf");
    expect(result).toEqual({
      providerRef: "data:application/pdf;base64,QUJD",
      storageRef: "https://example.com/x.pdf",
    });
  });

  it("keeps the HTTP reference when the fetch is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } })),
    );

    const result = await resolveMediaReference("http://example.com/missing", "p", "u");

    expect(result).toEqual({
      providerRef: "http://example.com/missing",
      storageRef: "http://example.com/missing",
    });
  });

  it("keeps the HTTP reference when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    const result = await resolveMediaReference("https://example.com/x", "p", "u");

    expect(result).toEqual({
      providerRef: "https://example.com/x",
      storageRef: "https://example.com/x",
    });
  });

  it("passes unknown references through untouched", async () => {
    const result = await resolveMediaReference("file:///tmp/x", "p", "u");

    expect(result).toEqual({ providerRef: "file:///tmp/x", storageRef: "file:///tmp/x" });
  });
});

describe("WorkflowMemoryService.retrieveRelevantWorkflows", () => {
  const embedding = (vector: number[], space = EMBEDDING_SPACE) => ({ vector, space });

  const fakeCollection = (documents: unknown[], count = documents.length) => ({
    countDocuments: async () => count,
    find: () => ({
      sort: () => ({
        limit: () => ({ toArray: async () => documents }),
      }),
    }),
  });

  const fakeDb = (collection: unknown) => ({ collection: () => collection });

  it("returns null without a query or project", async () => {
    expect(await WorkflowMemoryService.retrieveRelevantWorkflows("agent", "proj", "")).toBeNull();
    expect(await WorkflowMemoryService.retrieveRelevantWorkflows("agent", null, "task")).toBeNull();
  });

  it("returns null when Mongo is unavailable", async () => {
    fakes.getDb.mockReturnValue(null);

    expect(
      await WorkflowMemoryService.retrieveRelevantWorkflows("agent", "proj", "task"),
    ).toBeNull();
  });

  it("returns null when the agent has no stored workflows", async () => {
    fakes.getDb.mockReturnValue(fakeDb(fakeCollection([], 0)));

    expect(
      await WorkflowMemoryService.retrieveRelevantWorkflows("agent", "proj", "task"),
    ).toBeNull();
  });

  it("formats the most similar compatible workflows", async () => {
    fakes.getDb.mockReturnValue(
      fakeDb(
        fakeCollection([
          { summary: "Run the linter", userRequest: "fix", stepCount: 3, semanticEmbedding: embedding([1, 0, 0]) },
          { summary: "Write the docs", userRequest: "doc", stepCount: 4, semanticEmbedding: embedding([0, 1, 0]) },
          { summary: "Old space", userRequest: "old", stepCount: 2, semanticEmbedding: embedding([1, 0, 0], "other:3:v1") },
          { summary: "Legacy untagged", userRequest: "legacy", stepCount: 2, semanticEmbedding: [1, 0, 0] },
        ]),
      ),
    );

    const result = await WorkflowMemoryService.retrieveRelevantWorkflows("agent", "proj", "task");

    expect(result).not.toBeNull();
    expect(result?.startsWith(PAST_WORKFLOWS_HEADER)).toBe(true);
    expect(result).toContain("### Past Workflow (similarity: 100%)");
    expect(result).toContain("Run the linter");
    expect(result).not.toContain("Old space");
    expect(result).not.toContain("Legacy untagged");
  });

  it("returns null when every workflow scores below the threshold", async () => {
    fakes.getDb.mockReturnValue(
      fakeDb(
        fakeCollection([
          { summary: "Unrelated", userRequest: "x", stepCount: 1, semanticEmbedding: embedding([0, 1, 0]) },
        ]),
      ),
    );

    expect(
      await WorkflowMemoryService.retrieveRelevantWorkflows("agent", "proj", "task"),
    ).toBeNull();
  });

  it("returns null when the character budget rejects every block", async () => {
    fakes.getDb.mockReturnValue(
      fakeDb(
        fakeCollection([
          {
            summary: "x".repeat(2000),
            userRequest: "big",
            stepCount: 5,
            semanticEmbedding: embedding([1, 0, 0]),
          },
        ]),
      ),
    );

    expect(
      await WorkflowMemoryService.retrieveRelevantWorkflows("agent", "proj", "task"),
    ).toBeNull();
  });

  it("respects the maximumResults option", async () => {
    fakes.getDb.mockReturnValue(
      fakeDb(
        fakeCollection([
          { summary: "First", userRequest: "a", stepCount: 3, semanticEmbedding: embedding([1, 0, 0]) },
          { summary: "Second", userRequest: "b", stepCount: 3, semanticEmbedding: embedding([1, 0, 0]) },
        ]),
      ),
    );

    const result = await WorkflowMemoryService.retrieveRelevantWorkflows(
      "agent",
      "proj",
      "task",
      { maximumResults: 1 },
    );

    expect(result).toContain("First");
    expect(result).not.toContain("Second");
  });
});
