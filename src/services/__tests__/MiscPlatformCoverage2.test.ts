/**
 * Platform helpers — FileService uploads, cron matching, memory batching and
 * the global classify capability. Mongo and MinIO are fakes; every other module
 * is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getDb: vi.fn(),
  minioAvailable: vi.fn(),
  minioUpload: vi.fn(),
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: fakes.getDb, getCollection: () => null },
}));
vi.mock("../../wrappers/MinioWrapper.ts", () => ({
  default: {
    isAvailable: fakes.minioAvailable,
    upload: fakes.minioUpload,
  },
}));

import FileService from "../FileService.ts";
import { matchCron } from "../../utils/CronMatcher.ts";
import { buildBatches, BATCH_MAX_CLUSTERS, BATCH_MAX_STALE } from "../memory/BatchBuilder.ts";
import { GlobalCapabilityExecutor } from "../GlobalCapabilityExecutor.ts";
import type { MemoryDoc } from "../memory/types.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FileService.uploadFile", () => {
  it("returns the data URL inline when MinIO is unavailable", async () => {
    fakes.minioAvailable.mockReturnValue(false);
    const dataUrl = "data:image/png;base64,AAAA";

    const result = await FileService.uploadFile(dataUrl);

    expect(result.ref).toBe(dataUrl);
    expect(result.contentType).toBe("application/octet-stream");
    expect(result.size).toBe(Math.round((dataUrl.length * 3) / 4));
    expect(fakes.minioUpload).not.toHaveBeenCalled();
  });

  it("passes through values that are not data URLs", async () => {
    fakes.minioAvailable.mockReturnValue(true);

    const result = await FileService.uploadFile("https://example.test/file.png");

    expect(result).toEqual({
      ref: "https://example.test/file.png",
      size: 0,
      contentType: "application/octet-stream",
    });
    expect(fakes.minioUpload).not.toHaveBeenCalled();
  });

  it("uploads a data URL under the project/user path", async () => {
    fakes.minioAvailable.mockReturnValue(true);
    fakes.minioUpload.mockResolvedValue(undefined);
    const base64 = Buffer.from("hello").toString("base64");

    const result = await FileService.uploadFile(
      `data:image/png;base64,${base64}`,
      "uploads",
      "proj",
      "alice",
    );

    expect(result.size).toBe(5);
    expect(result.contentType).toBe("image/png");
    expect(result.ref).toMatch(/^minio:\/\/projects\/proj\/alice\/uploads\/[0-9a-f-]+\.png$/);
    expect(fakes.minioUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^projects\/proj\/alice\/uploads\/[0-9a-f-]+\.png$/),
      expect.any(Buffer),
      "image/png",
    );
  });

  it("replaces an IP-address username with the default user", async () => {
    fakes.minioAvailable.mockReturnValue(true);
    fakes.minioUpload.mockResolvedValue(undefined);

    const result = await FileService.uploadFile(
      `data:image/png;base64,${Buffer.from("x").toString("base64")}`,
      "uploads",
      "proj",
      "10.0.0.5",
    );

    expect(result.ref).not.toContain("10.0.0.5");
    expect(result.ref).toMatch(/^minio:\/\/projects\/proj\/[^/]+\/uploads\//);
  });

  it("uses a flat key without project and username, and 'bin' for unknown types", async () => {
    fakes.minioAvailable.mockReturnValue(true);
    fakes.minioUpload.mockResolvedValue(undefined);

    const result = await FileService.uploadFile(
      `data:application/x-custom;base64,${Buffer.from("y").toString("base64")}`,
    );

    expect(result.contentType).toBe("application/x-custom");
    expect(result.ref).toMatch(/^minio:\/\/uploads\/[0-9a-f-]+\.bin$/);
  });
});

describe("matchCron", () => {
  const date = new Date("2026-10-30T09:05:00");

  it("matches wildcards", () => {
    expect(matchCron("* * * * *", date)).toBe(true);
  });

  it("matches literal fields", () => {
    expect(matchCron("5 9 30 10 5", date)).toBe(true);
    expect(matchCron("6 9 30 10 5", date)).toBe(false);
    expect(matchCron("5 10 30 10 5", date)).toBe(false);
  });

  it("matches comma lists", () => {
    expect(matchCron("1,5,10 * * * *", date)).toBe(true);
    expect(matchCron("1,7 * * * *", date)).toBe(false);
  });

  it("matches step values over a wildcard and over a range", () => {
    expect(matchCron("*/5 * * * *", date)).toBe(true);
    expect(matchCron("*/4 * * * *", date)).toBe(false);
    expect(matchCron("5-20/5 * * * *", date)).toBe(true);
    expect(matchCron("6-20/5 * * * *", date)).toBe(false);
  });

  it("rejects an unparsable step", () => {
    expect(matchCron("*/x * * * *", date)).toBe(false);
  });

  it("matches ranges", () => {
    expect(matchCron("0-30 9 * * *", date)).toBe(true);
    expect(matchCron("0-4 9 * * *", date)).toBe(false);
    expect(matchCron("0-30 10-17 * * *", date)).toBe(false);
  });

  it("rejects expressions that are not five fields", () => {
    expect(matchCron("* * *", date)).toBe(false);
    expect(matchCron("", date)).toBe(false);
  });
});

describe("buildBatches", () => {
  const memory = (id: string, content = `content ${id}`): MemoryDoc => ({
    id,
    type: "fact",
    title: `Title ${id}`,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("returns no batches for empty input", () => {
    expect(buildBatches([], [])).toEqual([]);
  });

  it("splits clusters into batches of at most the cluster cap", () => {
    const clusters = Array.from({ length: BATCH_MAX_CLUSTERS + 1 }, (_, index) => [
      memory(`c${index}`),
    ]);

    const batches = buildBatches(clusters, []);

    expect(batches).toHaveLength(2);
    expect(batches[0].clusters).toHaveLength(BATCH_MAX_CLUSTERS);
    expect(batches[1].clusters).toHaveLength(1);
    expect(batches[0].stale).toEqual([]);
  });

  it("attaches stale memories to the first cluster batch up to the stale cap", () => {
    const stale = Array.from({ length: BATCH_MAX_STALE + 2 }, (_, index) =>
      memory(`s${index}`),
    );

    const batches = buildBatches([[memory("c0")]], stale);

    expect(batches[0].stale).toHaveLength(BATCH_MAX_STALE);
    expect(batches[1].clusters).toEqual([]);
    expect(batches[1].stale).toHaveLength(2);
  });

  it("starts a new stale batch when the token budget would overflow", () => {
    const huge = memory("huge", "x".repeat(60_000));
    const small = memory("small");

    const batches = buildBatches([], [huge, small]);

    expect(batches).toHaveLength(2);
    expect(batches[0].stale).toEqual([huge]);
    expect(batches[1].stale).toEqual([small]);
  });

  it("keeps an oversized first cluster so no work is dropped", () => {
    const hugeCluster = [memory("huge", "y".repeat(60_000))];

    const batches = buildBatches([hugeCluster, [memory("next")]], []);

    expect(batches).toHaveLength(2);
    expect(batches[0].clusters).toEqual([hugeCluster]);
  });
});

describe("GlobalCapabilityExecutor global.data.classify", () => {
  it("rejects missing item or rules", async () => {
    const missingItem = await GlobalCapabilityExecutor.execute("global.data.classify", {
      rules: [],
    });
    expect(missingItem.success).toBe(false);
    expect(missingItem.error?.code).toBe("INVALID_ARGUMENTS");

    const missingRules = await GlobalCapabilityExecutor.execute("global.data.classify", {
      item: { title: "x" },
    });
    expect(missingRules.success).toBe(false);
    expect(missingRules.error?.code).toBe("INVALID_ARGUMENTS");
  });

  it("collects categories from substring and regex rules", async () => {
    const result = await GlobalCapabilityExecutor.execute("global.data.classify", {
      item: { title: "Breaking: storm hits coast", body: "123 casualties" },
      rules: [
        { field: "title", match: "storm", category: "weather" },
        { field: "body", match: "^\\d+", category: "numbers" },
        { field: "title", match: "sports", category: "sports" },
        { field: "missing", match: "anything", category: "never" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ categories: ["weather", "numbers"] });
  });
});
