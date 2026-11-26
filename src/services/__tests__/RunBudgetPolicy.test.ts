import { describe, expect, it } from "vitest";
import { resolveFinalReserveMs, resolveRunMaxTokens } from "../RunBudgetPolicy.ts";
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

describe("resolveRunMaxTokens", () => {
  it("lets the profile per-call cap win over a legacy client run budget", () => {
    const request = { budget: { max_tokens: 49152 } } satisfies CreateRunRequest;
    expect(resolveRunMaxTokens(request, chatProfile)).toBe(2560);
  });

  it("keeps request-first precedence for profiles without max_output_tokens", () => {
    const request = { budget: { max_tokens: 49152 } } satisfies CreateRunRequest;
    expect(resolveRunMaxTokens(request, legacyProfile)).toBe(49152);
  });

  it("falls back to the profile per-call cap, then the run budget, when the request sends none", () => {
    expect(resolveRunMaxTokens({}, chatProfile)).toBe(2560);
    expect(resolveRunMaxTokens({}, legacyProfile)).toBe(49152);
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
    expect(profile!.budget_limits.max_duration_ms).toBe(480000);
    expect(profile!.budget_limits.final_reserve_ms).toBe(240000);
    expect(profile!.budget_limits.max_tool_calls).toBe(20);
    expect(() => ProfileRegistry.validateProfileSchema(profile!)).not.toThrow();
  });
});
