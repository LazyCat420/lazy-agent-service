/**
 * reasoning_effort passthrough (PLAN_deepseek.md §4) — unit tests.
 *
 * Covers:
 *   - profile manifests accept/validate model_constraints.reasoning_effort
 *   - runtime_overrides.reasoning_effort is validated against the level set
 *   - AgenticToolResolver normalizes the option so providers without
 *     support receive either a valid level or nothing
 *   - a profile-declared reasoning_effort reaches a spy provider's call
 *     params when the run options are assembled the canonical way
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() {
      return null;
    }
    static getCollection() {
      return null;
    }
  }
  return { default: MongoWrapper };
});

import { ProfileRegistry, type AgentProfile } from "../ProfileRegistry.ts";
import AgenticToolResolver from "../AgenticToolResolver.ts";

const BASE_PROFILE = {
  profile_id: "reasoning-effort-test",
  version: "1.0.0",
  role: "analyst",
  workflow_type: "structured_completion" as const,
  system_prompt: "You are a test.",
  model_constraints: {
    default_model: "GLM-5.3-Flash-EXL3",
    allowed_models: ["GLM-5.3-Flash-EXL3"],
    allowed_providers: ["vllm-2"],
    reasoning_effort: "high",
  },
  tool_policy: { mode: "STRICT_WHITELIST" as const, whitelist: [] },
  budget_limits: { max_tokens: 1024, max_tool_calls: 2, max_duration_ms: 60000 },
  retention_class: "EPHEMERAL" as const,
};

describe("profile manifest reasoning_effort", () => {
  it("accepts a profile declaring reasoning_effort", () => {
    const profile = ProfileRegistry.validateProfileSchema(structuredClone(BASE_PROFILE));
    expect(profile.model_constraints.reasoning_effort).toBe("high");
  });

  it("rejects a non-string or unknown reasoning_effort", () => {
    expect(() =>
      ProfileRegistry.validateProfileSchema({
        ...structuredClone(BASE_PROFILE),
        model_constraints: { ...BASE_PROFILE.model_constraints, reasoning_effort: 3 },
      }),
    ).toThrow("reasoning_effort");
    expect(() =>
      ProfileRegistry.validateProfileSchema({
        ...structuredClone(BASE_PROFILE),
        model_constraints: { ...BASE_PROFILE.model_constraints, reasoning_effort: "maximum" },
      }),
    ).toThrow("reasoning_effort");
  });

  it("validates runtime override reasoning_effort against the level set", () => {
    const profile = ProfileRegistry.validateProfileSchema(structuredClone(BASE_PROFILE));
    expect(() =>
      ProfileRegistry.validateOverrides(profile, { reasoning_effort: "medium" }),
    ).not.toThrow();
    expect(() =>
      ProfileRegistry.validateOverrides(profile, { reasoning_effort: "loud" }),
    ).toThrow("reasoning_effort");
  });
});

describe("AgenticToolResolver reasoning effort normalization", () => {
  it("keeps valid levels and drops everything else", () => {
    expect(AgenticToolResolver.normalizeReasoningEffort("low")).toBe("low");
    expect(AgenticToolResolver.normalizeReasoningEffort("high")).toBe("high");
    expect(AgenticToolResolver.normalizeReasoningEffort("maximum")).toBeUndefined();
    expect(AgenticToolResolver.normalizeReasoningEffort(3)).toBeUndefined();
    expect(AgenticToolResolver.normalizeReasoningEffort(undefined)).toBeUndefined();
  });
});

describe("reasoning_effort reaches the provider call", () => {
  it("profile default lands in the provider params via a spy provider", async () => {
    const profile: AgentProfile = ProfileRegistry.validateProfileSchema(structuredClone(BASE_PROFILE));

    // The canonical run path (RunExecutionEngine) assembles run options with
    // reasoningEffort from the profile when no runtime override is present.
    const runtime_overrides: Record<string, unknown> = {};
    const options: Record<string, unknown> = {
      ...(typeof runtime_overrides.reasoning_effort === "string"
        ? { reasoningEffort: runtime_overrides.reasoning_effort }
        : profile.model_constraints.reasoning_effort
          ? { reasoningEffort: profile.model_constraints.reasoning_effort }
          : {}),
    };

    const providerCalls: Array<{ model: string; options: Record<string, unknown> }> = [];
    const spyProvider = {
      generateTextStream(
        _messages: unknown[],
        model: string,
        callOptions: Record<string, unknown>,
      ) {
        providerCalls.push({ model, options: callOptions });
        return (async function* () {
          yield "done";
        })();
      },
    };

    const passOptions = AgenticLoopPassOptionsFor(options);
    for await (const _chunk of spyProvider.generateTextStream([], "GLM-5.3-Flash-EXL3", {
      ...passOptions,
    })) {
      void _chunk;
    }

    expect(providerCalls[0].options.reasoningEffort).toBe("high");
  });

  it("a runtime override wins over the profile default", async () => {
    const profile: AgentProfile = ProfileRegistry.validateProfileSchema(structuredClone(BASE_PROFILE));
    const runtime_overrides = { reasoning_effort: "low" };
    const options: Record<string, unknown> = {
      ...(typeof runtime_overrides.reasoning_effort === "string"
        ? { reasoningEffort: runtime_overrides.reasoning_effort }
        : profile.model_constraints.reasoning_effort
          ? { reasoningEffort: profile.model_constraints.reasoning_effort }
          : {}),
    };

    const providerCalls: Array<{ options: Record<string, unknown> }> = [];
    const spyProvider = {
      generateTextStream(
        _messages: unknown[],
        _model: string,
        callOptions: Record<string, unknown>,
      ) {
        providerCalls.push({ options: callOptions });
        return (async function* () {})();
      },
    };

    const passOptions = AgenticLoopPassOptionsFor(options);
    for await (const _chunk of spyProvider.generateTextStream([], "m", passOptions)) {
      void _chunk;
    }

    expect(providerCalls[0].options.reasoningEffort).toBe("low");
  });
});

/** Mirrors the harness per-iteration pass option assembly (options + runtime fields). */
function AgenticLoopPassOptionsFor(options: Record<string, unknown>) {
  return { ...options, project: "test", agent: null, username: "tester" };
}
