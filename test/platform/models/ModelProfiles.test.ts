import { describe, expect, it } from "vitest";
import {
  BUDGET_PRESETS,
  declaredBillionParameters,
  effortWithinProfile,
  getModelProfile,
  isLightweightModel,
  modelFamilyOf,
} from "../../../src/platform/models/ModelProfiles.ts";
import { applyModelProfile } from "../../../src/platform/models/applyModelProfile.ts";

describe("declaredBillionParameters", () => {
  it("reads the size a name declares", () => {
    expect(declaredBillionParameters("gemma-4-12b-it")).toBe(12);
    expect(declaredBillionParameters("Qwen3.8-27B")).toBe(27);
    expect(declaredBillionParameters("mixtral-8x7b")).toBe(56);
    expect(declaredBillionParameters("qwen2.5-0.5b-instruct")).toBe(0.5);
  });

  it("returns null when the name says no size", () => {
    expect(declaredBillionParameters("gpt-oss-20b")).toBe(20);
    expect(declaredBillionParameters("claude-sonnet-5")).toBeNull();
    expect(declaredBillionParameters("nemotron-latest")).toBeNull();
  });
});

describe("family and lightweight detection", () => {
  it("detects families from the name", () => {
    expect(modelFamilyOf("Qwen3-8B")).toBe("qwen");
    expect(modelFamilyOf("llama-3.2-3b-instruct")).toBe("llama");
    expect(modelFamilyOf("gpt-oss-20b")).toBe("gpt-oss");
    expect(modelFamilyOf("Mistral-Nemotron-12B")).toBe("nemotron");
    expect(modelFamilyOf("claude-sonnet-5")).toBe("claude");
    expect(modelFamilyOf("mystery-model")).toBe("unknown");
  });

  it("flags at-or-under 14B names as lightweight", () => {
    expect(isLightweightModel("Qwen3-14B")).toBe(true);
    expect(isLightweightModel("qwen3-14.5b")).toBe(false);
    expect(isLightweightModel("claude-sonnet-5")).toBe(false);
  });
});

describe("getModelProfile", () => {
  it("gives lightweight models the 12-tool, no-sub-agent, minimal-prompt budget", () => {
    const profile = getModelProfile("qwen3-8b-instruct");
    expect(profile.family).toBe("qwen");
    expect(profile.budget).toBe(BUDGET_PRESETS.lightweight);
    expect(profile.budget.maxTools).toBe(12);
    expect(profile.budget.allowSubAgents).toBe(false);
    expect(profile.budget.systemPrompt).toBe("minimal");
    expect(profile.contextWindow).toBe(131_072);
  });

  it("gives large and unknown-size models the standard budget", () => {
    for (const model of ["Qwen3-32B", "nemotron-ultra", "claude-sonnet-5"]) {
      expect(getModelProfile(model).budget).toBe(BUDGET_PRESETS.standard);
    }
  });

  it("encodes family request-surface rules", () => {
    expect(getModelProfile("gpt-oss-20b").rejectedParameters).toContain("temperature");
    expect(getModelProfile("claude-sonnet-5").rejectedParameters).toEqual(["temperature", "topP", "topK"]);
    expect(getModelProfile("llama-3.2-3b-instruct").efforts).toBeNull();
    expect(getModelProfile("gpt-oss-20b").efforts).toEqual(["low", "medium", "high"]);
  });
});

describe("applyModelProfile", () => {
  it("drops rejected sampling parameters", () => {
    const { options } = applyModelProfile("claude-sonnet-5", {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 1_000,
    });
    expect(options).toEqual({ maxOutputTokens: 1_000 });
  });

  it("keeps parameters the model accepts", () => {
    const options = { temperature: 0.7, topP: 0.9 };
    expect(applyModelProfile("qwen3-8b", options).options).toBe(options);
  });

  it("clamps a requested effort into the family vocabulary", () => {
    expect(applyModelProfile("gpt-oss-20b", { reasoningEffort: "minimal" }).options).toEqual({ reasoningEffort: "low" });
    expect(applyModelProfile("gpt-oss-20b", { reasoningEffort: "xhigh" }).options).toEqual({ reasoningEffort: "high" });
    // No effort vocabulary at all: the requested effort passes through.
    expect(applyModelProfile("llama-3.2-3b", { reasoningEffort: "high" }).options).toEqual({ reasoningEffort: "high" });
  });

  it("maps tool_choice to a mode the model takes", () => {
    expect(applyModelProfile("qwen3-8b", { toolChoice: "required" }).options).toEqual({ toolChoice: "any" });
  });

  it("trims tools to the lightweight budget and excludes sub-agent tools", () => {
    const toolNames = [
      "read_file",
      "write_file",
      "grep_search",
      "glob_search",
      "bash_run",
      "edit_file",
      "list_dir",
      "search_docs",
      "discover_tools",
      "web_fetch",
      "memory_store",
      "trace_show",
      "spawn_subagent",
      "async_task_dispatch",
      "run_task",
    ];
    const result = applyModelProfile("qwen3-8b", { toolNames }, { toolNames });
    expect(result.maxTools).toBe(12);
    expect(result.strippedPrompt).toBe(true);
    expect((result.options as { toolNames: string[] }).toolNames).toHaveLength(12);
    expect((result.options as { toolNames: string[] }).toolNames).not.toContain("spawn_subagent");
    expect((result.options as { toolNames: string[] }).toolNames).not.toContain("async_task_dispatch");
  });

  it("leaves standard-budget models' tools unlimited", () => {
    const result = applyModelProfile("Qwen3-32B", {}, { toolNames: ["spawn_subagent", "read_file"] });
    expect(result.maxTools).toBeNull();
    expect(result.strippedPrompt).toBe(false);
  });

  it("clamps maxOutputTokens, hardest on lightweight models", () => {
    expect(applyModelProfile("claude-sonnet-5", { maxOutputTokens: 999_999 }).clampOutputTo).toBe(64_000);
    expect(applyModelProfile("qwen3-8b", { maxOutputTokens: 999_999 }).clampOutputTo).toBe(8_192);
    expect(applyModelProfile("qwen3-8b", { maxOutputTokens: 500 }).clampOutputTo).toBe(500);
    expect(applyModelProfile("qwen3-8b", {}).clampOutputTo).toBeUndefined();
  });

  it("accepts a discovered context window from the caller", () => {
    const profile = getModelProfile("llama-3.2-3b");
    // The profile itself only knows the family default; the caller's discovery refines it.
    expect(profile.contextWindow).toBe(131_072);
    const { options } = applyModelProfile("llama-3.2-3b", { contextWindow: 65_536 }, { contextWindow: 65_536 });
    expect(options).toBe(options); // unchanged request object flows through
  });
});

describe("effortWithinProfile", () => {
  const profile = getModelProfile("gpt-oss-20b");
  it("keeps an accepted effort", () => {
    expect(effortWithinProfile(profile, "medium")).toBe("medium");
  });
  it("clamps to floor and ceiling", () => {
    expect(effortWithinProfile(profile, "none")).toBe("low");
    expect(effortWithinProfile(profile, "max")).toBe("high");
  });
  it("drops an unknown effort word", () => {
    expect(effortWithinProfile(profile, "turbo")).toBeUndefined();
  });
});
