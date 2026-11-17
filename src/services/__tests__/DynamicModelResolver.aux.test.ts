/**
 * Auxiliary fallback chains (W4) — DynamicModelResolver.resolveAuxModel.
 *
 * Side-task capabilities (web Q&A, vision, compression) resolve through the
 * same tiering as the main chain (explicit env → role tiering → whatever is
 * online) but each chain is independent: breaking one capability's provider
 * must not affect the others.
 *
 * The online-check is injected via DynamicModelResolver.setMockStatuses, the
 * same stub the existing resolver tests use — no network probes run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DynamicModelResolver,
  normalizeLocalModelId,
} from "../DynamicModelResolver.js";
import type { HostModelStatus } from "../DynamicModelResolver.js";
import logger from "../../utils/logger.ts";

const jetson: HostModelStatus = {
  instanceId: "vllm",
  baseUrl: "http://jetson:8080",
  nickname: "Jetson",
  models: ["qwen3-vl-8b", "qwen3-4b"],
  online: true,
};

const goldSpark: HostModelStatus = {
  instanceId: "vllm-2",
  baseUrl: "http://gold-spark:8000",
  nickname: "Gold Spark",
  models: ["llama-3.1-nemotron-70b-instruct", "qwen3-vl-32b"],
  online: true,
};

const withEnv = (env?: Record<string, string | undefined>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
};

describe("resolveAuxModel", () => {
  let cleanupEnv: (() => void) | null = null;

  beforeEach(() => {
    DynamicModelResolver.setMockStatuses([jetson, goldSpark]);
  });

  afterEach(() => {
    DynamicModelResolver.setMockStatuses(null);
    cleanupEnv?.();
    cleanupEnv = null;
  });

  it("explicit env provider+model wins over role tiering", () => {
    cleanupEnv = withEnv({
      AUX_WEB_PROVIDER: "vllm-2",
      AUX_WEB_MODEL: "llama-3.1-nemotron-70b-instruct",
    });
    expect(DynamicModelResolver.resolveAuxModel("web")).toEqual({
      provider: "vllm-2",
      model: "llama-3.1-nemotron-70b-instruct",
    });
  });

  it("explicit env model without provider lands on an online host serving it", () => {
    cleanupEnv = withEnv({
      AUX_COMPRESSION_MODEL: "llama-3.1-nemotron-70b-instruct",
    });
    expect(DynamicModelResolver.resolveAuxModel("compression")).toEqual({
      provider: "vllm-2",
      model: "llama-3.1-nemotron-70b-instruct",
    });
  });

  it("falls through to role tiering when the env provider is offline", () => {
    cleanupEnv = withEnv({ AUX_WEB_PROVIDER: "nonexistent-box" });
    // web → light role → prefers Jetson (vllm)
    expect(DynamicModelResolver.resolveAuxModel("web")).toMatchObject({
      provider: "vllm",
    });
  });

  it("web and compression map to light roles (prefer Jetson)", () => {
    cleanupEnv = withEnv();
    for (const cap of ["web", "compression"] as const) {
      expect(DynamicModelResolver.resolveAuxModel(cap)).toMatchObject({
        provider: "vllm",
      });
    }
  });

  it("vision resolves a vision-capable model via VISION_PATTERNS", () => {
    cleanupEnv = withEnv(undefined as never);
    const r = DynamicModelResolver.resolveAuxModel("vision");
    expect(r.provider).toBe("vllm");
    expect(r.model).toMatch(/vl/i);
  });

  it("falls back to whichever allowed provider is online when Jetson is down", () => {
    DynamicModelResolver.setMockStatuses([goldSpark, { ...jetson, online: false }]);
    const r = DynamicModelResolver.resolveAuxModel("compression");
    expect(r.provider).toBe("vllm-2");
    expect(r.model.length).toBeGreaterThan(0);
  });

  it("vision falls through to an online host when the preferred box is down", () => {
    DynamicModelResolver.setMockStatuses([{ ...jetson, online: false }, goldSpark]);
    const r = DynamicModelResolver.resolveAuxModel("vision");
    expect(r.provider).toBe("vllm-2");
    expect(r.model).toBe("qwen3-vl-32b");
  });

  it("capabilities resolve independently: breaking web's provider does not break vision", () => {
    cleanupEnv = withEnv({
      // Web pinned to a box that is offline…
      AUX_WEB_PROVIDER: "dead-box",
      // …while vision is pinned to a live one.
      AUX_VISION_PROVIDER: "vllm-2",
      AUX_VISION_MODEL: "qwen3-vl-32b",
    });
    expect(DynamicModelResolver.resolveAuxModel("web").provider).toBe("vllm");
    expect(DynamicModelResolver.resolveAuxModel("vision")).toEqual({
      provider: "vllm-2",
      model: "qwen3-vl-32b",
    });
  });

  it("returns a default instead of throwing when no host is online", () => {
    DynamicModelResolver.setMockStatuses([
      { ...jetson, online: false },
      { ...goldSpark, online: false },
    ]);
    const r = DynamicModelResolver.resolveAuxModel("web");
    expect(r.provider).toBeTruthy();
    expect(r.model).toBeTruthy();
  });

  // Compile-time guard: resolveAuxModel's parameter is the union
  // "web" | "vision" | "compression". The call below is intentionally
  // commented out — with TS it must NOT typecheck:
  //   DynamicModelResolver.resolveAuxModel("unknown");
  it("rejects unknown capabilities at compile time", () => {
    // @ts-expect-error — unknown capability is rejected by the type system.
    const bad: "web" | "vision" | "compression" = "unknown";
    // Runtime is a fallback default; the real guard is the type error above.
    expect(typeof DynamicModelResolver.resolveAuxModel(bad)).toBe("object");
  });
});

/**
 * SliceReviewer MEDIUM follow-up: the served-id matcher may only bridge a
 * single extra `-segment` (`base` ↔ `base-<one segment>`) and must log every
 * rewrite, so a request is never silently routed to a different model
 * (`base-<seg>-<seg>`, a different base name, or another `/` namespace).
 */
describe("normalizeLocalModelId single-segment guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the exact-match path silent and unchanged", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      normalizeLocalModelId("Qwen3.8-Flash-Next", ["Qwen3.8-Flash-Next", "qwen3-4b"]),
    ).toBe("Qwen3.8-Flash-Next");
    // Exact match wins even when a suffixed sibling is also served.
    expect(
      normalizeLocalModelId("GLM-5.3-Flash-EXL3", [
        "GLM-5.3-Flash-EXL3-TF",
        "GLM-5.3-Flash-EXL3",
      ]),
    ).toBe("GLM-5.3-Flash-EXL3");
    expect(warn).not.toHaveBeenCalled();
  });

  it("allows a one-segment suffix rewrite in both directions and warns", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      normalizeLocalModelId("GLM-5.3-Flash-EXL3", ["GLM-5.3-Flash-EXL3-TF"]),
    ).toBe("GLM-5.3-Flash-EXL3-TF");
    // Reverse: settings pinned to `-TF`, box serves the plain id.
    expect(
      normalizeLocalModelId("GLM-5.3-Flash-EXL3-TF", ["GLM-5.3-Flash-EXL3"]),
    ).toBe("GLM-5.3-Flash-EXL3");
    // The finding's case is one segment: allowed, but never silent.
    expect(normalizeLocalModelId("Qwen3.8-Flash", ["Qwen3.8-Flash-Next"])).toBe(
      "Qwen3.8-Flash-Next",
    );
    expect(warn).toHaveBeenCalledTimes(3);
    const [message, meta] = warn.mock.calls[0] as unknown as [
      string,
      { requested: string; served: string; servedIds: string[] },
    ];
    expect(message).toContain("GLM-5.3-Flash-EXL3");
    expect(message).toContain("GLM-5.3-Flash-EXL3-TF");
    expect(meta.requested).toBe("GLM-5.3-Flash-EXL3");
    expect(meta.served).toBe("GLM-5.3-Flash-EXL3-TF");
    expect(meta.servedIds).toEqual(["GLM-5.3-Flash-EXL3-TF"]);
  });

  it("rejects two-segment and different-base candidates without warning", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // base → base-<seg>-<seg> is never a one-segment suffix.
    expect(normalizeLocalModelId("Qwen3.8-Flash", ["Qwen3.8-Flash-Next-Pro"])).toBe(
      "Qwen3.8-Flash",
    );
    // …and never across a different base name or `/` namespace.
    expect(normalizeLocalModelId("Qwen3.8-Flash", ["Qwen2.5-VL-7B"])).toBe(
      "Qwen3.8-Flash",
    );
    expect(normalizeLocalModelId("Qwen3.8-Flash", ["Qwen3.8-Flash/team"])).toBe(
      "Qwen3.8-Flash",
    );
    // Shared prefix that is not a whole `-` segment: different model.
    expect(normalizeLocalModelId("Qwen3", ["Qwen3.8-Flash-Next"])).toBe("Qwen3");
    // Two single-suffix candidates stay ambiguous → unchanged.
    expect(
      normalizeLocalModelId("GLM-5.3-Flash-EXL3", [
        "GLM-5.3-Flash-EXL3-TF",
        "GLM-5.3-Flash-EXL3-AWQ",
      ]),
    ).toBe("GLM-5.3-Flash-EXL3");
    expect(warn).not.toHaveBeenCalled();
  });
});
