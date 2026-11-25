import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DynamicModelResolver } from "../../src/services/DynamicModelResolver.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";

describe("Dynamic Model Resolution & Role Tiering", () => {
  beforeEach(async () => {
    await ProfileRegistry.loadProfilesFromDisk();
  });

  afterEach(() => {
    DynamicModelResolver.setMockStatuses(null);
  });

  it("permits any dynamically loaded model on Gold Spark for trading-strategy-chat-v1", async () => {
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["GLM-5.3-Flash-EXL3-TF"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["nemotron35"],
        online: true,
      },
    ]);

    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(profile).not.toBeNull();

    // Model GLM-5.3-Flash-EXL3-TF is NOT in static allowed_models, but is live on Gold Spark (vllm-2)
    expect(() => {
      ProfileRegistry.validateOverrides(profile!, {
        model: "GLM-5.3-Flash-EXL3-TF",
      });
    }).not.toThrow();

    // Provider resolution correctly detects host as vllm-2
    const resolved = DynamicModelResolver.resolveProviderAndModel(
      profile!.role,
      profile!.model_constraints.allowed_providers,
      "GLM-5.3-Flash-EXL3-TF",
    );
    expect(resolved.provider).toBe("vllm-2");
    expect(resolved.model).toBe("GLM-5.3-Flash-EXL3-TF");
  });

  it("rejects a completely unhosted model that is neither in static whitelist nor live on any allowed host", async () => {
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["GLM-5.3-Flash-EXL3-TF"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["nemotron35"],
        online: true,
      },
    ]);

    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(() => {
      ProfileRegistry.validateOverrides(profile!, {
        model: "completely-unhosted-model-xyz",
      });
    }).toThrow("not permitted by profile 'trading-strategy-chat-v1'");
  });

  it("handles single-box fallback when Jetson is offline: Gold Spark absorbs junior analyst tasks", async () => {
    // Jetson is offline! Only Gold Spark is online.
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["GLM-5.3-Flash-EXL3-TF"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: [],
        online: false,
      },
    ]);

    const profile = await ProfileRegistry.loadProfile("trading-junior-analyst-v1");
    expect(profile).not.toBeNull();

    // Junior analyst role normally prefers Jetson, but single-box fallback routes to Gold Spark
    const resolved = DynamicModelResolver.resolveProviderAndModel(
      profile!.role,
      profile!.model_constraints.allowed_providers,
    );
    expect(resolved.provider).toBe("vllm-2");
    expect(resolved.model).toBe("GLM-5.3-Flash-EXL3-TF");

    // Live validation allows the Gold Spark model for the junior analyst
    expect(() => {
      ProfileRegistry.validateOverrides(profile!, {
        model: "GLM-5.3-Flash-EXL3-TF",
      });
    }).not.toThrow();
  });

  it("handles single-box fallback when Gold Spark is offline: Jetson absorbs strategy chat tasks", async () => {
    // Gold Spark is offline! Only Jetson is online.
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: [],
        online: false,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["nemotron35"],
        online: true,
      },
    ]);

    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(profile).not.toBeNull();

    // Strategy chat role normally prefers Gold Spark, but single-box fallback routes to Jetson
    const resolved = DynamicModelResolver.resolveProviderAndModel(
      profile!.role,
      profile!.model_constraints.allowed_providers,
    );
    expect(resolved.provider).toBe("vllm");
    expect(resolved.model).toBe("nemotron35");

    // Live validation allows the Jetson model for strategy chat
    expect(() => {
      ProfileRegistry.validateOverrides(profile!, {
        model: "nemotron35",
      });
    }).not.toThrow();
  });

  it("auto-detects the host in real time when model is requested without an endpoint", async () => {
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["deepseek-v4-large"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["qwen-small"],
        online: true,
      },
    ]);

    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");

    // Requesting deepseek-v4-large without provider resolves to vllm-2 (Gold Spark)
    const resolvedDeepseek = DynamicModelResolver.resolveProviderAndModel(
      profile!.role,
      profile!.model_constraints.allowed_providers,
      "deepseek-v4-large",
    );
    expect(resolvedDeepseek.provider).toBe("vllm-2");

    // Requesting qwen-small resolves to vllm (Jetson)
    const resolvedQwen = DynamicModelResolver.resolveProviderAndModel(
      profile!.role,
      profile!.model_constraints.allowed_providers,
      "qwen-small",
    );
    expect(resolvedQwen.provider).toBe("vllm");
  });

  it("resolves auto and unhosted stale default models to live /v1/models", async () => {
    const { resolveRunModelAndProvider } = await import(
      "../../src/services/RunExecutionEngine.ts"
    );
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["live-served-gold-model"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["live-served-jetson-model"],
        online: true,
      },
    ]);

    const autoResolved = DynamicModelResolver.resolveProviderAndModel(
      "strategy-news-researcher",
      ["vllm-2", "vllm"],
      "auto",
    );
    expect(autoResolved).toEqual({
      provider: "vllm-2",
      model: "live-served-gold-model",
    });

    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(profile).not.toBeNull();
    expect(profile!.model_constraints.default_model).toBe("auto");
    expect(() => {
      ProfileRegistry.validateOverrides(profile!, { model: "auto" });
    }).not.toThrow();

    const runRes = resolveRunModelAndProvider({} as any, profile as any);
    expect(runRes.selectedModel).toBe("live-served-gold-model");
    expect(runRes.preferredProvider).toBe("vllm-2");

    // Stale hardcoded default_model not present on any box still falls back to live /v1/models
    const staleProfile = {
      ...profile,
      model_constraints: {
        ...profile!.model_constraints,
        default_model: "stale-unhosted-model-v0",
      },
    };
    const fallbackRes = resolveRunModelAndProvider({} as any, staleProfile as any);
    expect(fallbackRes.selectedModel).toBe("live-served-gold-model");
    expect(fallbackRes.preferredProvider).toBe("vllm-2");
    expect(
      resolveRunModelAndProvider({ model: "auto" } as any, staleProfile as any).selectedModel,
    ).toBe("live-served-gold-model");
  });

  it("enforces allowed_providers policy for overrides and rejects unserved explicit models", async () => {
    const { resolveRunModelAndProvider } = await import(
      "../../src/services/RunExecutionEngine.ts"
    );
    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(profile).not.toBeNull();

    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["live-served-gold-model"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["live-served-jetson-model"],
        online: true,
      },
    ]);

    expect(
      DynamicModelResolver.resolveProviderAndModel("bull", ["vllm-2"], "auto"),
    ).toEqual({
      provider: "vllm-2",
      model: "live-served-gold-model",
    });
    expect(
      DynamicModelResolver.isModelAllowedForProfile("auto", ["vllm-3"], "bull").allowed,
    ).toBe(false);
    expect(
      DynamicModelResolver.resolveProviderAndModel("trading-strategy-chat", ["vllm-2"], "live-served-gold-model", "vllm"),
    ).not.toMatchObject({ provider: "vllm" });

    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["live-served-gold-model"],
        online: true,
      },
    ]);
    expect(() =>
      resolveRunModelAndProvider({ model: "absent-model-xyz" } as any, profile as any),
    ).toThrow(/MODEL_UNAVAILABLE/);
    expect(() =>
      resolveRunModelAndProvider(
        { model: "absent-model-xyz", runtime_overrides: { provider: "vllm-2" } } as any,
        profile as any,
      ),
    ).toThrow(/MODEL_UNAVAILABLE/);
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm-2",
        baseUrl: "http://10.0.0.141:8000",
        nickname: "Gold Spark",
        models: ["live-served-gold-model"],
        online: true,
      },
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["live-served-jetson-model"],
        online: true,
      },
    ]);
    expect(
      DynamicModelResolver.resolveProviderAndModel("trading-strategy-chat", ["vllm-2", "vllm"], "live-served-jetson-model", "vllm-2"),
    ).toEqual({ provider: "vllm", model: "live-served-jetson-model" });

    // Disallowed-host-only online still rejects models outside allowed_providers (codex:R1-F1 round 2)
    DynamicModelResolver.setMockStatuses([
      {
        instanceId: "vllm",
        baseUrl: "http://10.0.0.30:8000",
        nickname: "Jetson",
        models: ["live-served-jetson-model"],
        online: true,
      },
    ]);
    const goldOnlyProfile = {
      ...profile,
      model_constraints: {
        ...profile!.model_constraints,
        allowed_providers: ["vllm-2"],
      },
    };
    expect(
      DynamicModelResolver.isModelAllowedForProfile("live-served-jetson-model", ["vllm-2"], profile!.role).allowed,
    ).toBe(false);
    expect(() =>
      resolveRunModelAndProvider({ model: "live-served-jetson-model" } as any, goldOnlyProfile as any),
    ).toThrow(/MODEL_UNAVAILABLE/);
  });

  it("fails closed offline for dynamic auto and explicit requests while preserving concrete fixture defaults", async () => {
    const { resolveRunModelAndProvider } = await import(
      "../../src/services/RunExecutionEngine.ts"
    );
    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(profile).not.toBeNull();
    const staleProfile = {
      ...profile,
      model_constraints: {
        ...profile!.model_constraints,
        default_model: "stale-unhosted-model-v0",
      },
    };

    DynamicModelResolver.setMockStatuses([]);
    expect(() => resolveRunModelAndProvider({} as any, profile as any)).toThrow(
      /MODEL_UNAVAILABLE/,
    );
    expect(() => resolveRunModelAndProvider({ model: "auto" } as any, staleProfile as any)).toThrow(
      /MODEL_UNAVAILABLE/,
    );
    expect(() =>
      resolveRunModelAndProvider({ model: "absent-model-xyz" } as any, profile as any),
    ).toThrow(/MODEL_UNAVAILABLE/);
    expect(resolveRunModelAndProvider({} as any, staleProfile as any).selectedModel).toBe(
      "stale-unhosted-model-v0",
    );
  });
});
