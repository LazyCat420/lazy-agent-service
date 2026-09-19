import fs from "node:fs";
import path from "node:path";
import logger from "../utils/logger.ts";
import type { RuntimeOverrides } from "../types/run.ts";

export interface ModelConstraints {
  default_model: string;
  allowed_models: string[];
  allowed_providers: string[];
  temperature_range?: [number, number];
}

export interface ToolPolicy {
  mode: "STRICT_WHITELIST" | "DENYLIST";
  whitelist: string[];
  denylist?: string[];
  require_signed_capability?: boolean;
}

export interface BudgetLimits {
  max_tokens: number;
  max_tool_calls: number;
  max_retries?: number;
  max_duration_ms: number;
  max_concurrent_workers?: number;
}

export interface ProfilePlugins {
  context_contributors?: string[];
  verifiers?: string[];
  worker_plugins?: string[];
}

export interface ObservabilityPolicy {
  telemetry_level?: "OFF" | "METRICS_ONLY" | "FULL_SPANS";
  redact_keys?: string[];
  sample_rate?: number;
}

export interface AgentProfile {
  profile_id: string;
  version: string;
  role: string;
  description?: string;
  system_prompt: string;
  model_constraints: ModelConstraints;
  tool_policy: ToolPolicy;
  budget_limits: BudgetLimits;
  plugins?: ProfilePlugins;
  retention_class: "EPHEMERAL" | "AUDITED_SESSION" | "PERMANENT_RECORD";
  observability_policy?: ObservabilityPolicy;

  // Backwards compatibility getters/properties
  id?: string;
  systemPrompt?: string;
  defaultModel?: string;
  baseTools?: string[];
}

export class ProfileRegistry {
  private static profiles: Map<string, AgentProfile> = new Map();
  private static initialized = false;

  /**
   * Validate that an object conforms to AgentProfile schema
   */
  static validateProfileSchema(data: any): AgentProfile {
    if (!data || typeof data !== "object") {
      throw new Error("Profile manifest must be a non-null object");
    }

    const requiredFields = [
      "profile_id",
      "version",
      "role",
      "system_prompt",
      "model_constraints",
      "tool_policy",
      "budget_limits",
      "retention_class",
    ];

    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null) {
        throw new Error(`Profile manifest missing required field: ${field}`);
      }
    }

    if (!/^[a-z0-9-]+$/.test(data.profile_id)) {
      throw new Error(
        `Invalid profile_id '${data.profile_id}': must match pattern ^[a-z0-9-]+$`,
      );
    }

    if (!/^\d+\.\d+\.\d+$/.test(data.version)) {
      throw new Error(
        `Invalid version '${data.version}': must follow semantic versioning X.Y.Z`,
      );
    }

    const { model_constraints, tool_policy, budget_limits } = data;

    if (
      !model_constraints.default_model ||
      !Array.isArray(model_constraints.allowed_models) ||
      !Array.isArray(model_constraints.allowed_providers)
    ) {
      throw new Error("Invalid model_constraints: default_model and allowed arrays required");
    }

    if (!model_constraints.allowed_models.includes(model_constraints.default_model)) {
      throw new Error(
        `default_model '${model_constraints.default_model}' must be in allowed_models: [${model_constraints.allowed_models.join(", ")}]`,
      );
    }

    if (!["STRICT_WHITELIST", "DENYLIST"].includes(tool_policy.mode)) {
      throw new Error(`Invalid tool_policy.mode: ${tool_policy.mode}`);
    }

    if (!Array.isArray(tool_policy.whitelist)) {
      throw new Error("tool_policy.whitelist must be an array");
    }

    if (
      typeof budget_limits.max_tokens !== "number" ||
      typeof budget_limits.max_tool_calls !== "number" ||
      typeof budget_limits.max_duration_ms !== "number"
    ) {
      throw new Error(
        "budget_limits requires numeric max_tokens, max_tool_calls, and max_duration_ms",
      );
    }

    // Attach backwards-compatibility getters
    const profile: AgentProfile = {
      ...data,
      get id() {
        return this.profile_id;
      },
      get systemPrompt() {
        return this.system_prompt;
      },
      get defaultModel() {
        return this.model_constraints.default_model;
      },
      get baseTools() {
        return this.tool_policy.whitelist;
      },
    };

    return profile;
  }

  /**
   * Load profile manifests from disk (e.g. ./profiles)
   */
  static async loadProfilesFromDisk(directoryPath?: string): Promise<number> {
    const dir = directoryPath || path.resolve(process.cwd(), "profiles");
    let count = 0;

    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), "utf-8");
          const parsed = JSON.parse(raw);
          const profile = this.validateProfileSchema(parsed);
          this.registerProfile(profile);
          count++;
          logger.info(`[ProfileRegistry] Loaded and validated profile: ${profile.profile_id}@${profile.version}`);
        } catch (err: any) {
          logger.error(`[ProfileRegistry] Failed loading profile from ${file}: ${err.message}`);
          throw err;
        }
      }
    }

    this.initialized = true;
    return count;
  }

  /**
   * Load a profile by profile_id and optional version
   */
  static async loadProfile(profileId: string, version?: string): Promise<AgentProfile | null> {
    if (!this.initialized && this.profiles.size === 0) {
      await this.loadProfilesFromDisk();
    }

    if (version) {
      const key = `${profileId}@${version}`;
      if (this.profiles.has(key)) {
        return this.profiles.get(key)!;
      }
    }

    // Exact id lookup
    if (this.profiles.has(profileId)) {
      return this.profiles.get(profileId)!;
    }

    // Version prefix search: find latest matching profileId or matching prefix (e.g. trading-analyst -> trading-analyst-v1)
    let latest: AgentProfile | null = null;
    for (const [key, profile] of this.profiles.entries()) {
      if (profile.profile_id === profileId || profile.profile_id.startsWith(`${profileId}-`)) {
        if (!latest || profile.version > latest.version) {
          latest = profile;
        }
      }
    }

    return latest;
  }

  /**
   * Register a profile into registry
   */
  static registerProfile(profile: AgentProfile): void {
    const validated = this.validateProfileSchema(profile);
    this.profiles.set(validated.profile_id, validated);
    this.profiles.set(`${validated.profile_id}@${validated.version}`, validated);
  }

  /**
   * Validate runtime overrides against profile bounds
   */
  static validateOverrides(profile: AgentProfile, overrides?: RuntimeOverrides): void {
    if (!overrides) return;

    if (overrides.model && !profile.model_constraints.allowed_models.includes(overrides.model)) {
      throw new Error(
        `Requested model '${overrides.model}' is not permitted by profile '${profile.profile_id}'. Allowed models: ${profile.model_constraints.allowed_models.join(", ")}`,
      );
    }

    if (overrides.budget) {
      const b = overrides.budget;
      const maxTokens = b.max_tokens ?? b.maxTokens;
      if (maxTokens !== undefined && maxTokens > profile.budget_limits.max_tokens) {
        throw new Error(
          `Requested max_tokens (${maxTokens}) exceeds profile limit (${profile.budget_limits.max_tokens})`,
        );
      }

      const maxToolCalls = b.max_tool_calls ?? b.maxToolCalls;
      if (maxToolCalls !== undefined && maxToolCalls > profile.budget_limits.max_tool_calls) {
        throw new Error(
          `Requested max_tool_calls (${maxToolCalls}) exceeds profile limit (${profile.budget_limits.max_tool_calls})`,
        );
      }

      const maxDurationMs = b.max_duration_ms ?? b.maxDurationMs;
      if (maxDurationMs !== undefined && maxDurationMs > profile.budget_limits.max_duration_ms) {
        throw new Error(
          `Requested max_duration_ms (${maxDurationMs}) exceeds profile limit (${profile.budget_limits.max_duration_ms})`,
        );
      }
    }

    if (Array.isArray(overrides.tools) && profile.tool_policy.mode === "STRICT_WHITELIST") {
      for (const tool of overrides.tools) {
        const toolName = typeof tool === "string" ? tool : tool.name;
        if (toolName && !profile.tool_policy.whitelist.includes(toolName)) {
          throw new Error(
            `Requested tool '${toolName}' is not allowed by profile '${profile.profile_id}' strict whitelist`,
          );
        }
      }
    }
  }

  static clear(): void {
    this.profiles.clear();
    this.initialized = false;
  }

  static getRegisteredProfileIds(): string[] {
    return Array.from(this.profiles.keys());
  }
}
