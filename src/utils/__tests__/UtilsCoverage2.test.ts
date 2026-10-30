/**
 * Coverage2 for pure util modules whose hot functions were untested:
 * gguf-arch (VRAM estimation), RecurrenceMatcher, ModelResolution,
 * media, ContextWindowManager, openai-compat, SseUtilities and
 * StreamChunkDispatcher.
 *
 * Only external boundaries are stubbed (provider registry, child_process,
 * FileService); assertions are on returned values / emitted events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveArchParams,
  estimateMemory,
  type ArchParams,
} from "../gguf-arch.ts";
import { matchRecurrenceRule, type RecurrenceRule } from "../RecurrenceMatcher.ts";

const GiB = 1024 ** 3;

describe("gguf-arch.resolveArchParams", () => {
  it("resolves a known architecture by parameter count", () => {
    const params = resolveArchParams("qwen3", "8B", 5 * GiB, 4);
    expect(params).toEqual({
      layers: 36,
      kvHeads: 8,
      headDim: 128,
      attnRatio: 1,
      isKnown: true,
    });
  });

  it("carries the hybrid attention ratio for qwen3.5", () => {
    const params = resolveArchParams("qwen35", "20B", 0, 4);
    expect(params.isKnown).toBe(true);
    expect(params.attnRatio).toBe(0.25);
    expect(params.layers).toBe(40);
  });

  it("falls back to the last variant when the bucket overflows", () => {
    const params = resolveArchParams("lfm2", "500B", 0, 4);
    expect(params).toEqual({
      layers: 28,
      kvHeads: 4,
      headDim: 80,
      attnRatio: 0.25,
      isKnown: true,
    });
  });

  it("derives billions from file size when paramsString is missing", () => {
    // 8 bytes per weight at 4 bits → 4 GiB file ≈ 8.6B parameters
    const params = resolveArchParams("qwen2", null, 4 * GiB, 4);
    expect(params.isKnown).toBe(true);
    expect(params.layers).toBe(28);
  });

  it("defaults to 7B when no size signal is available", () => {
    const params = resolveArchParams(null, null, 0, 4);
    expect(params.isKnown).toBe(false);
    expect(params.layers).toBe(32);
    expect(params.kvHeads).toBe(8);
    expect(params.headDim).toBe(128);
  });

  it("uses generic buckets for unknown architectures", () => {
    const buckets: Array<[number, number]> = [
      [1, 24],
      [3, 32],
      [8, 32],
      [16, 40],
      [30, 64],
      [70, 80],
      [120, 96],
    ];
    for (const [billions, layers] of buckets) {
      const params = resolveArchParams("unknown-arch", `${billions}B`, 0, 4);
      expect(params.layers, `${billions}B`).toBe(layers);
      expect(params.isKnown).toBe(false);
    }
  });
});

describe("gguf-arch.estimateMemory", () => {
  const arch: ArchParams = {
    layers: 32,
    kvHeads: 8,
    headDim: 128,
    attnRatio: 1,
    isKnown: true,
  };

  it("returns zeroes when there is nothing to estimate", () => {
    expect(
      estimateMemory({
        sizeBytes: 0,
        archParams: arch,
        gpuLayers: 32,
        contextLength: 4096,
      }),
    ).toEqual({ gpuGiB: 0, totalGiB: 0, cpuOffloaded: false });
    expect(
      estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: null,
        gpuLayers: 32,
        contextLength: 4096,
      }).totalGiB,
    ).toBe(0);
  });

  it("splits weights between GPU and CPU by layer ratio", () => {
    const result = estimateMemory({
      sizeBytes: 4 * GiB,
      archParams: arch,
      gpuLayers: 16,
      contextLength: 4096,
      flashAttention: true,
    });
    // weights 2 GiB on GPU + KV (2*32*8*128*1*4096 bytes) + 0.8 overhead
    const kv = (2 * 32 * 8 * 128 * 4096) / GiB;
    expect(result.gpuGiB).toBeCloseTo(2 + kv + 0.8, 6);
    expect(result.totalGiB).toBeCloseTo(4 + kv + 0.8, 6);
    expect(result.cpuOffloaded).toBe(false);
  });

  it("charges FP32 KV bytes without flash attention and keeps KV on CPU when not offloaded", () => {
    const result = estimateMemory({
      sizeBytes: 4 * GiB,
      archParams: arch,
      gpuLayers: 32,
      contextLength: 4096,
      flashAttention: false,
      offloadKvCache: false,
    });
    const kv = (2 * 32 * 8 * 128 * 4 * 4096) / GiB;
    expect(result.gpuGiB).toBeCloseTo(4 + 0.8, 6);
    expect(result.totalGiB).toBeCloseTo(4 + kv + 0.8, 6);
  });

  it("adds the small-model surcharge and vision encoder overhead", () => {
    const small = estimateMemory({
      sizeBytes: 1 * GiB,
      archParams: arch,
      gpuLayers: 32,
      contextLength: 0,
      vision: true,
    });
    // overhead 0.8 + 0.4*(1-1/3); vision 0.7 + 0.025*1
    expect(small.gpuGiB).toBeCloseTo(1 + 0.8 + 0.4 * (2 / 3) + 0.725, 6);
    // gpuLayers 0 → no overhead, no vision surcharge
    const cpuOnly = estimateMemory({
      sizeBytes: 1 * GiB,
      archParams: arch,
      gpuLayers: 0,
      contextLength: 0,
      vision: true,
    });
    expect(cpuOnly.gpuGiB).toBeCloseTo(0, 6);
    expect(cpuOnly.totalGiB).toBeCloseTo(1, 6);
  });

  it("clamps to the GPU budget and reports silent offload", () => {
    const result = estimateMemory({
      sizeBytes: 20 * GiB,
      archParams: arch,
      gpuLayers: 32,
      contextLength: 4096,
      gpuTotalGiB: 24,
      gpuBaselineGiB: 4,
    });
    expect(result.gpuGiB).toBeCloseTo(20, 6);
    expect(result.cpuOffloaded).toBe(true);
  });

  it("never returns negative sizes when the baseline exceeds the GPU", () => {
    const result = estimateMemory({
      sizeBytes: 2 * GiB,
      archParams: arch,
      gpuLayers: 32,
      contextLength: 4096,
      gpuTotalGiB: 4,
      gpuBaselineGiB: 8,
    });
    expect(result.gpuGiB).toBe(0);
    expect(result.cpuOffloaded).toBe(true);
  });
});

const rule = (overrides: Partial<RecurrenceRule>): RecurrenceRule => ({
  frequency: "daily",
  interval: 1,
  ...overrides,
});

describe("RecurrenceMatcher.matchRecurrenceRule", () => {
  const start = new Date(2026, 0, 1); // Thu 1 Jan 2026

  it("rejects targets before the start date", () => {
    expect(
      matchRecurrenceRule(rule({ frequency: "daily" }), start, new Date(2025, 11, 31)),
    ).toBe(false);
  });

  it("matches daily rules on the configured interval", () => {
    const daily = rule({ frequency: "daily", interval: 3 });
    expect(matchRecurrenceRule(daily, start, new Date(2026, 0, 4))).toBe(true);
    expect(matchRecurrenceRule(daily, start, new Date(2026, 0, 5))).toBe(false);
    // interval 0 is clamped to 1
    expect(
      matchRecurrenceRule(rule({ frequency: "daily", interval: 0 }), start, new Date(2026, 0, 2)),
    ).toBe(true);
  });

  it("aligns weekly rules to the week containing the start date", () => {
    const weekly = rule({ frequency: "weekly", interval: 1 });
    // start is Thursday: without weekdays, only Thursdays match
    expect(matchRecurrenceRule(weekly, start, new Date(2026, 0, 8))).toBe(true);
    expect(matchRecurrenceRule(weekly, start, new Date(2026, 0, 9))).toBe(false);

    const weeklyDays = rule({
      frequency: "weekly",
      interval: 1,
      weekdays: [1, 3],
    });
    expect(matchRecurrenceRule(weeklyDays, start, new Date(2026, 0, 5))).toBe(true);
    expect(matchRecurrenceRule(weeklyDays, start, new Date(2026, 0, 6))).toBe(false);

    const biweekly = rule({ frequency: "weekly", interval: 2 });
    expect(matchRecurrenceRule(biweekly, start, new Date(2026, 0, 15))).toBe(true);
    expect(matchRecurrenceRule(biweekly, start, new Date(2026, 0, 22))).toBe(false);
  });

  it("matches monthly rules on a fixed day of month", () => {
    const monthly = rule({ frequency: "monthly", interval: 1, dayOfMonth: 15 });
    expect(matchRecurrenceRule(monthly, start, new Date(2026, 0, 15))).toBe(true);
    expect(matchRecurrenceRule(monthly, start, new Date(2026, 1, 14))).toBe(false);
    expect(matchRecurrenceRule(monthly, start, new Date(2026, 1, 15))).toBe(true);
    expect(
      matchRecurrenceRule(rule({ frequency: "monthly", interval: 2, dayOfMonth: 1 }), start, new Date(2026, 1, 1)),
    ).toBe(false);
  });

  it("infers the day from the start date and clamps short months", () => {
    const start31 = new Date(2026, 0, 31);
    const monthly = rule({ frequency: "monthly", interval: 1 });
    expect(matchRecurrenceRule(monthly, start31, new Date(2026, 1, 28))).toBe(true);
    expect(matchRecurrenceRule(monthly, start31, new Date(2026, 2, 31))).toBe(true);
  });

  it("matches the last day of month with dayOfMonth = -1", () => {
    const lastDay = rule({ frequency: "monthly", interval: 1, dayOfMonth: -1 });
    expect(matchRecurrenceRule(lastDay, start, new Date(2026, 0, 31))).toBe(true);
    expect(matchRecurrenceRule(lastDay, start, new Date(2026, 1, 28))).toBe(true);
    expect(matchRecurrenceRule(lastDay, start, new Date(2026, 1, 27))).toBe(false);
  });

  it("matches nth weekday of month rules", () => {
    const thirdMonday = rule({
      frequency: "monthly",
      interval: 1,
      monthlyType: "nthDayOfWeek",
      nthDayOfWeek: { occurrence: 3, dayOfWeek: 1 },
    });
    expect(matchRecurrenceRule(thirdMonday, start, new Date(2026, 0, 19))).toBe(true);
    expect(matchRecurrenceRule(thirdMonday, start, new Date(2026, 0, 12))).toBe(false);
    // wrong weekday
    expect(matchRecurrenceRule(thirdMonday, start, new Date(2026, 0, 20))).toBe(false);
    // missing config
    expect(
      matchRecurrenceRule(
        rule({ frequency: "monthly", monthlyType: "nthDayOfWeek" }),
        start,
        new Date(2026, 0, 19),
      ),
    ).toBe(false);
  });

  it("matches the last occurrence of a weekday", () => {
    const lastFriday = rule({
      frequency: "monthly",
      interval: 1,
      monthlyType: "nthDayOfWeek",
      nthDayOfWeek: { occurrence: -1, dayOfWeek: 5 },
    });
    expect(matchRecurrenceRule(lastFriday, start, new Date(2026, 0, 30))).toBe(true);
    expect(matchRecurrenceRule(lastFriday, start, new Date(2026, 0, 23))).toBe(false);
  });

  it("matches yearly rules filtered by month", () => {
    const yearly = rule({
      frequency: "yearly",
      interval: 1,
      months: [2],
      yearlyType: "specificDate",
      dayOfMonth: 29,
    });
    expect(matchRecurrenceRule(yearly, start, new Date(2028, 1, 29))).toBe(true);
    expect(matchRecurrenceRule(yearly, start, new Date(2028, 1, 28))).toBe(false);
    // month not listed
    expect(matchRecurrenceRule(yearly, start, new Date(2028, 2, 29))).toBe(false);
    // interval mismatch
    expect(
      matchRecurrenceRule(rule({ frequency: "yearly", interval: 3, dayOfMonth: 1 }), start, new Date(2027, 0, 1)),
    ).toBe(false);
  });

  it("matches yearly nth-weekday rules and defaults months to the start month", () => {
    const yearlyNth = rule({
      frequency: "yearly",
      interval: 1,
      yearlyType: "nthDayOfWeek",
      nthDayOfWeek: { occurrence: 2, dayOfWeek: 4 },
    });
    expect(matchRecurrenceRule(yearlyNth, start, new Date(2026, 0, 8))).toBe(true);
    expect(matchRecurrenceRule(yearlyNth, start, new Date(2026, 1, 12))).toBe(false);
  });

  it("rejects unknown frequencies", () => {
    const bogus = { frequency: "hourly", interval: 1 } as unknown as RecurrenceRule;
    expect(matchRecurrenceRule(bogus, start, new Date(2026, 0, 2))).toBe(false);
  });
});

// ── ModelResolution ────────────────────────────────────────

interface FakeProviderListing {
  listModels?: () => Promise<unknown>;
}

const registry = vi.hoisted(() => ({
  providers: new Map<string, FakeProviderListing>(),
}));

vi.mock("../../providers/index.ts", () => ({
  getProvider: (id: string) => registry.providers.get(id),
}));

import {
  parseModelQuant,
  findBestQuantFallback,
  resolveModelForInstances,
} from "../ModelResolution.ts";
import type { InstanceEntry, Provider } from "../../types/ProviderTypes.ts";

describe("ModelResolution.findBestQuantFallback", () => {
  it("parses @quant and path-style quantization suffixes", () => {
    expect(parseModelQuant("qwen3-32b@q4_k_m")).toEqual({
      base: "qwen3-32b",
      quant: "Q4_K_M",
    });
    expect(
      parseModelQuant("lmstudio-community/qwen3-32b-GGUF/qwen3-32b-Q8_0.gguf"),
    ).toEqual({
      base: "lmstudio-community/qwen3-32b-GGUF/qwen3-32b",
      quant: "Q8_0",
    });
    expect(parseModelQuant("plain-model")).toEqual({
      base: "plain-model",
      quant: null,
    });
  });

  it("returns null when no candidate shares the base name", () => {
    expect(
      findBestQuantFallback("qwen3-32b@q4_k_m", [
        { key: "llama-3-8b@q4_k_m", size_bytes: 1 },
      ]),
    ).toBeNull();
  });

  it("picks the largest file among other quants of the same base", () => {
    const models = [
      { key: "qwen3-32b@q4_k_m", size_bytes: 999 }, // same quant → skipped
      { key: "qwen3-32b@q8_0", size_bytes: 500 },
      { key: "qwen3-32b@q2_k", size_bytes: 200 },
      { id: "other-model@q4_k_m", size_bytes: 9000 },
    ];
    expect(findBestQuantFallback("qwen3-32b@q4_k_m", models)).toBe(
      "qwen3-32b@q8_0",
    );
  });

  it("matches on the leaf name when the base path differs", () => {
    const models = [
      {
        key: "lmstudio-community/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf",
        size_bytes: 42,
      },
    ];
    expect(findBestQuantFallback("qwen3.6-27b@q4_k_m", models)).toBe(
      "lmstudio-community/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf",
    );
  });
});

describe("ModelResolution.resolveModelForInstances", () => {
  beforeEach(() => {
    registry.providers.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const instance = (id: string): InstanceEntry => ({
    id,
    type: "vllm",
    baseUrl: "http://127.0.0.1:1",
    concurrency: 1,
    instanceNumber: 1,
    // resolveModelForInstances only reads `id`; the provider object is unused.
    provider: {} as unknown as Provider,
  });

  it("keeps instances with an exact model match", async () => {
    registry.providers.set("vllm", {
      listModels: async () => ({ models: [{ key: "qwen3-32b@q4_k_m" }] }),
    });
    const result = await resolveModelForInstances("qwen3-32b@q4_k_m", [
      instance("vllm"),
    ]);
    expect(result.usable.map((i) => i.id)).toEqual(["vllm"]);
    expect(result.modelOverrides.size).toBe(0);
  });

  it("resolves a quant fallback and records the override", async () => {
    registry.providers.set("vllm", {
      listModels: async () => ({
        data: [{ id: "qwen3-32b@q8_0", size_bytes: 10 }],
      }),
    });
    const result = await resolveModelForInstances("qwen3-32b@q4_k_m", [
      instance("vllm"),
    ]);
    expect(result.usable.map((i) => i.id)).toEqual(["vllm"]);
    expect(result.modelOverrides.get("vllm")).toBe("qwen3-32b@q8_0");
  });

  it("skips providers that cannot list models", async () => {
    vi.useFakeTimers();
    registry.providers.set("vllm", {});
    const pending = resolveModelForInstances("qwen3-32b@q4_k_m", [
      instance("vllm"),
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(result.usable).toEqual([]);
    expect(result.modelOverrides.size).toBe(0);
  });

  it("drops instances whose listModels call fails", async () => {
    registry.providers.set("bad", {
      listModels: async () => {
        throw new Error("boom");
      },
    });
    registry.providers.set("good", {
      listModels: async () => ({ models: [{ key: "m@q4_k_m" }] }),
    });
    const result = await resolveModelForInstances("m@q4_k_m", [
      instance("bad"),
      instance("good"),
    ]);
    expect(result.usable.map((i) => i.id)).toEqual(["good"]);
  });

  it("times out slow instances and still returns the fast one", async () => {
    vi.useFakeTimers();
    registry.providers.set("slow", {
      listModels: () => Promise.withResolvers<unknown>().promise,
    });
    registry.providers.set("fast", {
      listModels: async () => ({ models: [{ key: "m@q4_k_m" }] }),
    });
    const pending = resolveModelForInstances("m@q4_k_m", [
      instance("slow"),
      instance("fast"),
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result.usable.map((i) => i.id)).toEqual(["fast"]);
  });
});

// ── media ──────────────────────────────────────────────────

type ExecCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

const childProcess = vi.hoisted(() => ({
  handler: null as
    | ((file: string, args: string[], cb: ExecCallback) => void)
    | null,
}));

vi.mock("child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) => {
    if (!childProcess.handler) {
      callback(null, "", "");
      return;
    }
    childProcess.handler(file, args, callback);
  },
}));

import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  constrainImageDimensions,
  extractVideoFrames,
} from "../media.ts";

const solidImage = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();

describe("media.constrainImageDimensions", () => {
  it("passes GIFs through untouched", async () => {
    const result = await constrainImageDimensions("R0lGODlh", "image/gif");
    expect(result).toEqual({ data: "R0lGODlh", mediaType: "image/gif" });
  });

  it("passes images that already fit the limit", async () => {
    const buffer = await solidImage(40, 20);
    const data = buffer.toString("base64");
    const result = await constrainImageDimensions(data, "image/png", 2000);
    expect(result).toEqual({ data, mediaType: "image/png" });
  });

  it("downscales an oversized PNG and keeps the PNG format", async () => {
    const buffer = await solidImage(3000, 1500);
    const result = await constrainImageDimensions(
      buffer.toString("base64"),
      "image/png",
      500,
    );
    expect(result.mediaType).toBe("image/png");
    expect(result.data).not.toBe(buffer.toString("base64"));
    const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(metadata.width).toBe(500);
    expect(metadata.height).toBe(250);
  });

  it("keeps WebP output for WebP input", async () => {
    const buffer = await solidImage(1200, 600);
    const result = await constrainImageDimensions(
      buffer.toString("base64"),
      "image/webp",
      300,
    );
    expect(result.mediaType).toBe("image/webp");
    const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(300);
  });

  it("converts other formats to JPEG", async () => {
    const buffer = await solidImage(800, 400);
    const result = await constrainImageDimensions(
      buffer.toString("base64"),
      "image/bmp",
      200,
    );
    expect(result.mediaType).toBe("image/jpeg");
    const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(metadata.format).toBe("jpeg");
  });

  it("passes data through when sharp cannot read it", async () => {
    const result = await constrainImageDimensions("bm90LWFuLWltYWdl", "image/png");
    expect(result).toEqual({ data: "bm90LWFuLWltYWdl", mediaType: "image/png" });
  });
});

describe("media.extractVideoFrames", () => {
  beforeEach(() => {
    childProcess.handler = null;
  });

  it("extracts frames through ffmpeg and returns data URLs", async () => {
    childProcess.handler = (file, args, callback) => {
      if (args.includes("-version")) {
        callback(null, "", "");
        return;
      }
      const outputPattern = args[args.indexOf("-f") + 2];
      const directory = dirname(outputPattern);
      void (async () => {
        await writeFile(
          join(directory, "frame_0001.jpg"),
          Buffer.from("frame-one"),
        );
        await writeFile(
          join(directory, "frame_0002.jpg"),
          Buffer.from("frame-two"),
        );
        callback(null, "", "Duration: 00:00:05.00");
      })();
    };

    const frames = await extractVideoFrames(
      "data:video/mp4;base64," + Buffer.from("fake-video").toString("base64"),
      { fps: 2, maxFrames: 3 },
    );
    expect(frames).toEqual([
      "data:image/jpeg;base64," + Buffer.from("frame-one").toString("base64"),
      "data:image/jpeg;base64," + Buffer.from("frame-two").toString("base64"),
    ]);
  });

  it("rejects malformed data URLs before touching the filesystem", async () => {
    await expect(extractVideoFrames("not-a-data-url")).rejects.toThrow(
      /Invalid video data URL format/,
    );
  });

  it("reports ffmpeg failures with the stderr tail", async () => {
    childProcess.handler = (_file, args, callback) => {
      if (args.includes("-version")) {
        callback(null, "", "");
        return;
      }
      callback(new Error("spawn failed"), "", "Invalid data found");
    };
    await expect(
      extractVideoFrames(
        "data:video/mp4;base64," + Buffer.from("bad").toString("base64"),
      ),
    ).rejects.toThrow(/ffmpeg failed .*Invalid data found/);
  });

  it("reports zero-frame runs with the parsed duration", async () => {
    childProcess.handler = (_file, args, callback) => {
      if (args.includes("-version")) {
        callback(null, "", "");
        return;
      }
      callback(null, "", "Duration: 00:00:07.12, start: 0");
    };
    await expect(
      extractVideoFrames(
        "data:video/mp4;base64," + Buffer.from("empty").toString("base64"),
      ),
    ).rejects.toThrow(/produced 0 frames .*duration: 00:00:07\.12/);
  });

  it("fails fast when ffmpeg is not installed", async () => {
    // Dynamic import is required: the ffmpeg probe is cached per module
    // instance, so only a fresh module graph re-runs the probe.
    vi.resetModules();
    childProcess.handler = (_file, args, callback) => {
      if (args.includes("-version")) {
        callback(new Error("ENOENT"), "", "");
        return;
      }
      callback(null, "", "");
    };
    const freshMedia = await import("../media.ts");
    await expect(
      freshMedia.extractVideoFrames(
        "data:video/mp4;base64," + Buffer.from("x").toString("base64"),
      ),
    ).rejects.toThrow(/ffmpeg is not installed/);
  });
});

// ── ContextWindowManager: assistant compression strategy ────

import ContextWindowManager from "../ContextWindowManager.ts";
import type { ChatMessage } from "../../types/admin.ts";

const longText = (chars: number, prefix: string) =>
  prefix + "x".repeat(chars - prefix.length);

describe("ContextWindowManager assistant compression", () => {
  it("summarizes old assistant and tool messages once cheaper strategies fail", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do the task" },
      // Two old model calls, each far larger than the budget.
      {
        role: "assistant",
        content: longText(20_000, "first answer "),
        thinking: "long private reasoning",
        toolCalls: [
          { name: "custom_lookup", args: { q: "x" }, result: "ok" },
          { name: "another_lookup", args: {}, result: undefined },
        ],
      },
      { role: "tool", content: longText(400, "tool payload ") },
      { role: "assistant", content: longText(20_000, "second answer ") },
      // Four recent model calls stay verbatim (recency protection).
      { role: "assistant", content: "recent 1" },
      { role: "assistant", content: "recent 2" },
      { role: "assistant", content: "recent 3" },
      { role: "assistant", content: "recent 4" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 8000,
      maxOutputTokens: 1024,
    });

    expect(result.truncated).toBe(true);
    expect(result.strategy).toBe("assistant_compression");
    expect(result.estimatedTokens).toBeLessThan(8000);

    const compressedFirst = result.messages[2];
    expect(compressedFirst.content).toContain("[Earlier response — used: custom_lookup, another_lookup]");
    expect(compressedFirst.content).toContain("first answer ");
    expect(compressedFirst.thinking).toBeUndefined();
    expect(compressedFirst.toolCalls).toEqual([
      { name: "custom_lookup", args: { q: "x" }, result: "[result truncated for context budget]" },
      { name: "another_lookup", args: {}, result: undefined },
    ]);

    const compressedSecond = result.messages[4];
    expect(compressedSecond.content).toContain("[Earlier response]");
    expect(compressedSecond.content).not.toContain("x".repeat(500));

    const compressedTool = result.messages[3];
    expect(compressedTool.content).toBe("[tool result truncated for context budget]");

    // System, user and the protected recent window are untouched.
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[5]).toBe(messages[5]);
    expect(result.messages[8]).toBe(messages[8]);
  });

  it("leaves requests that already fit the budget alone", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "short answer" },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 100_000,
      maxOutputTokens: 1024,
    });
    expect(result).toEqual({
      messages,
      truncated: false,
      strategy: null,
      estimatedTokens: ContextWindowManager.estimateTokens(messages),
    });
  });

  it("estimates a single message including tool calls, thinking and images", () => {
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "assistant",
      content: "abcd",
      thinking: "efgh",
      images: ["data:image/png;base64,AAAA"],
      toolCalls: [{ name: "t", args: { a: 1 }, result: "res" }],
    });
    // 4 per-message overhead + 1 text + 1 thinking + 1000 image + name/args/result
    expect(tokens).toBeGreaterThan(1006);
    expect(tokens).toBeLessThan(1020);
  });
});

// ── openai-compat: data URL → content part conversion ──────

import {
  prepareOpenAICompatMessages,
  MEDIA_STRATEGIES,
} from "../openai-compat.ts";

describe("openai-compat.convertCompatDataUrlToPart", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  it("maps images to image_url parts (including unknown MIME types)", () => {
    const parts = prepareOpenAICompatMessages(
      [
        {
          role: "user",
          images: [
            `data:image/png;base64,${b64("png")}`,
            "https://example.test/photo.jpg",
            "data:application/octet-stream;base64,AAAA",
          ],
        },
      ],
      { mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK },
    );
    expect(parts[0].content).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64("png")}` } },
      { type: "image_url", image_url: { url: "https://example.test/photo.jpg" } },
      { type: "image_url", image_url: { url: "data:application/octet-stream;base64,AAAA" } },
    ]);
  });

  it("turns video and audio into text placeholders in TEXT_FALLBACK", () => {
    const parts = prepareOpenAICompatMessages(
      [
        {
          role: "user",
          video: [`data:video/mp4;base64,${b64("vid")}`],
          audio: [`data:audio/wav;base64,${b64("wav")}`],
        },
      ],
      { mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK },
    );
    expect(parts[0].content).toEqual([
      {
        type: "text",
        text: "[Attached audio file — audio input not supported by this model]",
      },
      {
        type: "text",
        text: "[Attached video file — video input not supported by this model]",
      },
    ]);
  });

  it("keeps video_url and input_audio parts for FULL_MULTIMODAL", () => {
    const parts = prepareOpenAICompatMessages(
      [
        {
          role: "user",
          video: [`data:video/mp4;base64,${b64("vid")}`],
          audio: [`data:audio/wav;base64,${b64("wav")}`],
        },
      ],
      { mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL },
    );
    expect(parts[0].content).toEqual([
      {
        type: "input_audio",
        input_audio: { data: b64("wav"), format: "wav" },
      },
      { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64("vid")}` } },
    ]);
  });

  it("describes PDFs and decodes text/JSON attachments", () => {
    const parts = prepareOpenAICompatMessages(
      [
        {
          role: "user",
          pdf: [`data:application/pdf;base64,${b64("pdf")}`],
        },
        {
          role: "user",
          pdf: [`data:text/plain;base64,${b64("hello world")}`],
        },
        {
          role: "user",
          pdf: [`data:application/json;base64,${b64('{"a":1}')}`],
        },
      ],
      { mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK },
    );
    expect(parts[0].content).toEqual([
      {
        type: "text",
        text: "[Attached PDF document — PDF input not supported by this model]",
      },
    ]);
    expect(parts[1].content).toEqual([
      { type: "text", text: "[Attached file (text/plain)]:\nhello world" },
    ]);
    expect(parts[2].content).toEqual([
      { type: "text", text: '[Attached file (application/json)]:\n{"a":1}' },
    ]);
  });

  it("keeps only images under IMAGES_ONLY and appends text content", () => {
    const parts = prepareOpenAICompatMessages(
      [
        {
          role: "user",
          content: "describe",
          images: [`data:image/jpeg;base64,${b64("jpg")}`],
          audio: [`data:audio/wav;base64,${b64("wav")}`],
        },
      ],
      { mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY },
    );
    expect(parts[0].content).toEqual([
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64("jpg")}` } },
      { type: "text", text: "describe" },
    ]);
  });

  it("returns plain string content when a message carries no media", () => {
    const parts = prepareOpenAICompatMessages([
      { role: "user", content: "plain" },
    ]);
    expect(parts[0]).toEqual({ role: "user", content: "plain" });
  });
});

// ── SseUtilities.buildJsonResponseFromEvents ────────────────

import { buildJsonResponseFromEvents } from "../SseUtilities.ts";
import type { SseEvent } from "../../types/SseTypes.ts";
import type { ChatRequest } from "../../types/schemas.ts";

// The route passes the parsed request body through unchanged; only the
// provider/model fallbacks are read here, so a minimal body is sufficient.
const requestBody = { provider: "openai", model: "gpt-test" } as unknown as ChatRequest;

describe("SseUtilities.buildJsonResponseFromEvents", () => {
  it("maps an error event to a ProviderError with its status", () => {
    const result = buildJsonResponseFromEvents(
      [{ type: "error", message: "upstream exploded", statusCode: 502 }],
      requestBody,
    );
    expect("error" in result).toBe(true);
    const error = result.error;
    expect(error.message).toBe("upstream exploded");
    expect(error.statusCode).toBe(502);
    expect(error.provider).toBe("server");
  });

  it("defaults an error without a message or status", () => {
    const result = buildJsonResponseFromEvents([{ type: "error" }], requestBody);
    expect(result.error.message).toBe("Unknown error");
    expect(result.error.statusCode).toBe(500);
  });

  it("assembles text, thinking, images, audio and tool events", () => {
    const events: SseEvent[] = [
      { type: "chunk", content: "Hello " },
      { type: "chunk", content: "world" },
      { type: "thinking", content: "pondering" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      {
        type: "tool_execution",
        status: "calling",
        tool: { name: "search", args: { q: "x" } },
      },
      {
        type: "tool_execution",
        status: "done",
        tool: { name: "search", args: { q: "x" }, result: "hit" },
      },
      {
        type: "tool_execution",
        status: "error",
        tool: { name: "fetch", args: { u: "y" }, result: "nope" },
      },
      { type: "audio", data: "BBBB", mimeType: "audio/mpeg", minioRef: "minio://a" },
      {
        type: "done",
        provider: "anthropic",
        model: "claude-test",
        usage: { inputTokens: 3, outputTokens: 4 },
        estimatedCost: 0.01,
        audioRef: "minio://audio",
        traceId: "trace-1",
        conversationId: "conv-1",
      },
    ];

    const result = buildJsonResponseFromEvents(events, requestBody);
    expect(result.response).toMatchObject({
      text: "Hello world",
      thinking: "pondering",
      images: [{ data: "AAAA", mimeType: "image/png", minioRef: null }],
      audio: [{ data: "BBBB", mimeType: "audio/mpeg", minioRef: "minio://a" }],
      toolCalls: [{ name: "search", args: { q: "x" } }],
      toolResults: [
        { name: "search", args: { q: "x" }, result: "hit", status: "done" },
        { name: "fetch", args: { u: "y" }, result: "nope", status: "error" },
      ],
      provider: "anthropic",
      model: "claude-test",
      usage: { inputTokens: 3, outputTokens: 4 },
      estimatedCost: 0.01,
      audioRef: "minio://audio",
      traceId: "trace-1",
      conversationId: "conv-1",
    });
  });

  it("falls back to the request body and nulls empty sections", () => {
    const result = buildJsonResponseFromEvents([], requestBody);
    expect(result.response).toEqual({
      text: null,
      thinking: null,
      images: undefined,
      audio: undefined,
      toolCalls: undefined,
      toolResults: undefined,
      provider: "openai",
      model: "gpt-test",
      usage: null,
      estimatedCost: null,
    });
  });
});

// ── StreamChunkDispatcher ───────────────────────────────────

import {
  dispatchChunk,
  createStreamState,
  type StreamState,
} from "../StreamChunkDispatcher.ts";

const emittedEvents = (): {
  events: Array<{ type: string; [key: string]: unknown }>;
  emit: (event: { type: string; [key: string]: unknown }) => void;
} => {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  return { events, emit: (event) => events.push(event) };
};

describe("StreamChunkDispatcher tool call chunks", () => {
  it("appends a new tool call and completes it by id", async () => {
    const state: StreamState = createStreamState();
    const { events, emit } = emittedEvents();
    const context = { emit, project: "p", username: "u" };

    await dispatchChunk(
      {
        type: "toolCall",
        id: "call-1",
        responsesItemId: "item-1",
        name: "search",
        args: { q: "cats" },
        status: "calling",
        thoughtSignature: "sig",
      },
      state,
      context,
    );
    expect(state.toolCalls).toEqual([
      {
        id: "call-1",
        responsesItemId: "item-1",
        name: "search",
        args: { q: "cats" },
        result: undefined,
        status: "calling",
        thoughtSignature: "sig",
        reasoningItem: undefined,
      },
    ]);
    expect(events[0]).toMatchObject({ type: "toolCall", name: "search", id: "call-1" });

    await dispatchChunk(
      {
        type: "toolCall",
        id: "call-1",
        name: "search",
        args: { q: "cats", limit: 5 },
        result: "found",
        status: "done",
      },
      state,
      context,
    );
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toMatchObject({
      id: "call-1",
      result: "found",
      status: "done",
      args: { q: "cats", limit: 5 },
    });
    expect(events[1]).toMatchObject({ type: "toolCall", result: "found", status: "done" });
  });

  it("completes a call by name when the chunk has no id", async () => {
    const state: StreamState = createStreamState();
    const { emit } = emittedEvents();
    await dispatchChunk(
      { type: "toolCall", name: "lookup", args: {}, status: "calling" },
      state,
      { emit, project: "p", username: "u" },
    );
    await dispatchChunk(
      { type: "toolCall", name: "lookup", result: "hit", status: "done" },
      state,
      { emit, project: "p", username: "u" },
    );
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].result).toBe("hit");
  });

  it("ignores completion chunks that match no open call", async () => {
    const state: StreamState = createStreamState();
    const { emit } = emittedEvents();
    await dispatchChunk(
      { type: "toolCall", id: "ghost", name: "ghost", status: "error" },
      state,
      { emit, project: "p", username: "u" },
    );
    expect(state.toolCalls).toEqual([]);
  });
});

describe("StreamChunkDispatcher metadata and thinking chunks", () => {
  it("routes usage to the callback when provided, otherwise into state", async () => {
    const state: StreamState = createStreamState();
    const { emit } = emittedEvents();
    const context = { emit, project: "p", username: "u" };
    const seen: unknown[] = [];

    await dispatchChunk(
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      state,
      context,
      { onUsage: (usage) => seen.push(usage) },
    );
    expect(seen).toEqual([{ inputTokens: 1, outputTokens: 2 }]);
    expect(state.usage).toBeNull();

    await dispatchChunk(
      { type: "usage", usage: { inputTokens: 5, outputTokens: 6 } },
      state,
      context,
    );
    expect(state.usage).toEqual({ inputTokens: 5, outputTokens: 6 });

    // usage chunk without a usage payload resets the accumulator
    await dispatchChunk({ type: "usage" }, state, context);
    expect(state.usage).toBeNull();
  });

  it("records rate limits, stop reasons and thinking signatures", async () => {
    const state: StreamState = createStreamState();
    const { emit } = emittedEvents();
    const context = { emit, project: "p", username: "u" };

    await dispatchChunk(
      { type: "rateLimits", rateLimits: { remaining: 9 } },
      state,
      context,
    );
    expect(state.rateLimits).toEqual({ remaining: 9 });

    await dispatchChunk(
      { type: "stopReason", stopReason: "max_tokens" },
      state,
      context,
    );
    expect(state.stopReason).toBe("max_tokens");

    await dispatchChunk(
      { type: "thinking_signature", signature: "sig-1" },
      state,
      context,
    );
    expect(state.thinkingSignature).toBe("sig-1");
  });

  it("emits thinking with running character counts", async () => {
    const state: StreamState = createStreamState();
    const { events, emit } = emittedEvents();
    const context = { emit, project: "p", username: "u" };

    await dispatchChunk({ type: "thinking", content: "abcd" }, state, context);
    await dispatchChunk({ type: "thinking", content: "ef" }, state, context);

    expect(state.thinking).toBe("abcdef");
    expect(state.outputCharacters).toBe(6);
    expect(events.filter((e) => e.type === "thinking").map((e) => e.content)).toEqual([
      "abcd",
      "ef",
    ]);
    expect(state.firstTokenTime).not.toBeNull();
  });

  it("accumulates toolCallDelta characters as quarter tokens", async () => {
    const state: StreamState = createStreamState();
    const { emit } = emittedEvents();
    await dispatchChunk(
      { type: "toolCallDelta", characters: 10 },
      state,
      { emit, project: "p", username: "u" },
    );
    expect(state.outputCharacters).toBe(3);
  });

  it("treats unknown object chunk types as empty plain text", async () => {
    const state: StreamState = createStreamState();
    const { events, emit } = emittedEvents();
    const handled = await dispatchChunk(
      { type: "unknown", content: "raw text" },
      state,
      { emit, project: "p", username: "u" },
    );
    expect(handled).toBe(true);
    // Plain-text dispatch only consumes raw strings; object chunks contribute nothing.
    expect(state.text).toBe("");
    expect(events).toEqual([]);
  });

  it("treats null and string chunks as plain text", async () => {
    const state: StreamState = createStreamState();
    const { events, emit } = emittedEvents();
    const context = { emit, project: "p", username: "u" };

    expect(await dispatchChunk(null, state, context)).toBe(true);
    expect(await dispatchChunk("hello", state, context)).toBe(true);
    expect(state.text).toBe("hello");
    expect(events).toEqual([
      { type: "chunk", content: "hello", outputCharacters: 5 },
    ]);
  });
});
