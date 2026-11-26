import { describe, expect, it } from "vitest";
import { resolveCanonicalRunTokens, resolveFinalReserveMs, resolveRunMaxTokens } from "../RunBudgetPolicy.ts";
import { ProfileRegistry, type AgentProfile } from "../ProfileRegistry.ts";
import type { CreateRunRequest } from "../../types/run.ts";

const chatProfile = {
  profile_id: "trading-strategy-chat-v1",
  version: "1.2.0",
  role: "strategy-news-researcher",
  workflow_type: "interactive_agent",
  system_prompt: "test",
  model_constraints: { default_model: "auto", allowed_models: ["auto"], allowed_providers: ["vllm"], max_output_tokens: 2560 },
  tool_policy: { mode: "STRICT_WHITELIST", whitelist: [] },
  budget_limits: { max_tokens: 196608, max_tool_calls: 20, max_duration_ms: 480000, final_reserve_ms: 240000 },
  retention_class: "AUDITED_SESSION",
} satisfies AgentProfile;

const legacyProfile = {
  ...chatProfile,
  model_constraints: { default_model: "auto", allowed_models: ["auto"], allowed_providers: ["vllm"] },
  budget_limits: { max_tokens: 49152, max_tool_calls: 20, max_duration_ms: 300000 },
} satisfies AgentProfile;

/** Keeps a per-call cap but reserves no final-pass window — not funded. */
const capOnlyProfile = {
  ...chatProfile,
  profile_id: "html-notes-v1",
  budget_limits: { max_tokens: 196608, max_tool_calls: 20, max_duration_ms: 300000 },
} satisfies AgentProfile;

describe("resolveRunMaxTokens", () => {
  it("caps a legacy client request at the profile per-call limit", () => {
    const request = { budget: { max_tokens: 49152 } } satisfies Pick<CreateRunRequest, "budget">;
    expect(resolveRunMaxTokens(request, chatProfile)).toBe(2560);
  });

  it("honours a client asking for fewer tokens than the profile cap, including 0", () => {
    expect(resolveRunMaxTokens({ budget: { max_tokens: 0 } }, chatProfile)).toBe(0);
    expect(resolveRunMaxTokens({ budget: { max_tokens: 512 } }, chatProfile)).toBe(512);
    expect(resolveRunMaxTokens({ budget: { max_tokens: 99999 } }, chatProfile)).toBe(2560);
  });

  it("keeps request-first precedence for profiles without max_output_tokens", () => {
    const request = { budget: { max_tokens: 49152 } } satisfies Pick<CreateRunRequest, "budget">;
    expect(resolveRunMaxTokens(request, legacyProfile)).toBe(49152);
  });

  it("falls back to the profile values when the request sends none", () => {
    expect(resolveRunMaxTokens({}, chatProfile)).toBe(2560);
    expect(resolveRunMaxTokens({}, legacyProfile)).toBe(49152);
  });
});

describe("resolveCanonicalRunTokens", () => {
  it("lets a funded profile own the run ceiling over a legacy request", () => {
    const request = { budget: { max_tokens: 49152 } } satisfies Pick<CreateRunRequest, "budget">;
    expect(resolveCanonicalRunTokens(request, chatProfile)).toBe(196608);
  });

  it("keeps request-first precedence for a capped profile without a final-pass reserve", () => {
    const request = { budget: { max_tokens: 8192 } } satisfies Pick<CreateRunRequest, "budget">;
    expect(resolveCanonicalRunTokens(request, capOnlyProfile)).toBe(8192);
  });

  it("treats an explicit zero reserve as unfunded, like an absent one", () => {
    const zeroReserve = {
      ...capOnlyProfile,
      budget_limits: { ...capOnlyProfile.budget_limits, final_reserve_ms: 0 },
    } satisfies AgentProfile;
    const request = { budget: { max_tokens: 8192 } } satisfies Pick<CreateRunRequest, "budget">;
    expect(resolveCanonicalRunTokens(request, zeroReserve)).toBe(8192);
  });

  it("keeps request-first precedence for profiles without max_output_tokens", () => {
    const request = { budget: { max_tokens: 49152 } } satisfies Pick<CreateRunRequest, "budget">;
    expect(resolveCanonicalRunTokens(request, legacyProfile)).toBe(49152);
  });

  it("falls back to the profile run budget when the request sends none", () => {
    expect(resolveCanonicalRunTokens({}, chatProfile)).toBe(196608);
    expect(resolveCanonicalRunTokens({}, capOnlyProfile)).toBe(196608);
    expect(resolveCanonicalRunTokens({}, legacyProfile)).toBe(49152);
  });
});

describe("ProfileRegistry.validateProfileSchema budget_limits.final_reserve_ms", () => {
  it("accepts a funded reserve of 240000", () => {
    expect(() => ProfileRegistry.validateProfileSchema({ ...chatProfile })).not.toThrow();
  });

  it("rejects out-of-range or non-integer reserves", () => {
    for (const value of [-1, 600001, "x"]) {
      expect(() =>
        ProfileRegistry.validateProfileSchema({
          ...chatProfile,
          budget_limits: { ...chatProfile.budget_limits, final_reserve_ms: value },
        }),
      ).toThrow("budget_limits.final_reserve_ms must be an integer between 0 and 600000");
    }
  });
});

describe("resolveFinalReserveMs", () => {
  it("reproduces the legacy 90s / 30% default", () => {
    expect(resolveFinalReserveMs(300000, 0)).toBe(90000);
    expect(resolveFinalReserveMs(480000, 0)).toBe(90000);
  });

  it("honours a requested reserve up to 60% of the deadline", () => {
    expect(resolveFinalReserveMs(480000, 240000)).toBe(240000);
    expect(resolveFinalReserveMs(600000, 900000)).toBe(360000);
  });

  it("floors a requested reserve at 90s", () => {
    expect(resolveFinalReserveMs(480000, 30000)).toBe(90000);
  });

  it("reserves nothing for a zero or negative deadline", () => {
    expect(resolveFinalReserveMs(0, 240000)).toBe(0);
    expect(resolveFinalReserveMs(-1, 240000)).toBe(0);
  });
});

describe("trading-strategy-chat-v1 profile", () => {
  it("loads from disk, validates, and carries the funded budget", async () => {
    const profile = await ProfileRegistry.loadProfile("trading-strategy-chat-v1");
    expect(profile).not.toBeNull();
    expect(profile!.model_constraints.max_output_tokens).toBe(2560);
    expect(profile!.budget_limits.max_tokens).toBe(196608);
    expect(profile!.budget_limits.max_duration_ms).toBe(600000);
    expect(profile!.budget_limits.final_reserve_ms).toBe(300000);
    expect(profile!.budget_limits.max_tool_calls).toBe(20);
    expect(() => ProfileRegistry.validateProfileSchema(profile!)).not.toThrow();
  });
});
