import fs from "node:fs";
import path from "node:path";
import logger from "../utils/logger.ts";
import type { RuntimeOverrides } from "../types/run.ts";
import { CapabilityRegistry } from "./CapabilityRegistry.ts";

export interface ModelConstraints {
  provider_by_model?: Record<string, string>;
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
  decision_policy?: { capabilities: string[]; data_classifications: Array<"public">; max_latency_ms: number };
  profile_id: string;
  version: string;
  contract_version?: string;
  role: string;
  description?: string;
  system_prompt: string;
  model_constraints: ModelConstraints;
  tool_policy: ToolPolicy;
  allowed_global_capabilities?: string[];
  allowed_local_tools?: string[];
  budget_limits: BudgetLimits;
  plugins?: ProfilePlugins;
  local_tool_policy?: Record<string, { effect: "read" | "write" | "destructive"; requires_confirmation?: boolean }>;
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

    if (data.decision_policy) {
      const policy = data.decision_policy;
      if (!Array.isArray(policy.capabilities) || policy.capabilities.some((c: unknown) => c !== "semantic.choice.v1") || !Array.isArray(policy.data_classifications) || policy.data_classifications.some((c: unknown) => c !== "public") || !Number.isInteger(policy.max_latency_ms) || policy.max_latency_ms < 1 || policy.max_latency_ms > 2000) throw new Error("Invalid shadow decision policy");
    }

    if (data.model_constraints.provider_by_model) {
      for (const [model, provider] of Object.entries(data.model_constraints.provider_by_model)) {
        if (!data.model_constraints.allowed_models.includes(model) || !data.model_constraints.allowed_providers.includes(provider)) throw new Error("Model route outside profile policy");
      }
    }

    // 1. Validate contract_version if provided
    if (data.contract_version) {
      const match = /^(\d+)\./.exec(data.contract_version);
      if (!match || match[1] !== "1") {
        throw new Error(
          `Profile manifest '${data.profile_id}' specifies incompatible contract major version '${data.contract_version}'. Supported major: 1`,
        );
      }
    }

    // 2. Synthesize or validate tool_policy
    if (!data.tool_policy) {
      if (data.allowed_global_capabilities || data.allowed_local_tools) {
        data.tool_policy = {
          mode: "STRICT_WHITELIST",
          whitelist: [
            ...(data.allowed_global_capabilities || []),
            ...(data.allowed_local_tools || []),
          ],
        };
      } else {
        throw new Error("Profile manifest missing required field: tool_policy");
      }
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

    // 3. Validate allowed_local_tools if declared
    if (data.allowed_local_tools) {
      if (!Array.isArray(data.allowed_local_tools)) {
        throw new Error("allowed_local_tools must be an array");
      }
      for (const localTool of data.allowed_local_tools) {
        if (typeof localTool !== "string") {
          throw new Error("Each entry in allowed_local_tools must be a string");
        }
        if (localTool.startsWith("global.")) {
          throw new Error(`Local tool '${localTool}' cannot declare global namespace`);
        }
        if (!/^[a-z0-9_-]+\.[a-z0-9_.]+(@\d+(\.\d+)?)?$/.test(localTool)) {
          throw new Error(`Invalid local tool declaration '${localTool}': must match pattern <app>.<domain>.<action>`);
        }
      }
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

    // Validate capabilities: a profile cannot grant a nonexistent global capability or unsupported version
    const toolsToValidate = Array.from(new Set([
      ...tool_policy.whitelist,
      ...(data.allowed_global_capabilities || []),
    ]));

    const capValidation = CapabilityRegistry.validateProfileCapabilities(toolsToValidate);
    if (!capValidation.valid) {
      throw new Error(
        `Profile manifest '${data.profile_id}' grants nonexistent or unauthorized capability: ${capValidation.unauthorized.join(", ")}`,
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
      return null;
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

    const temperature = overrides.sampling_temperature;
    const range = profile.model_constraints.temperature_range;
    if (temperature !== undefined && range && (temperature < range[0] || temperature > range[1])) throw new Error("Temperature outside profile limits");
    if (overrides.provider && !profile.model_constraints.allowed_providers.includes(String(overrides.provider))) throw new Error("Requested provider is outside profile policy");

    if (overrides.model && !profile.model_constraints.allowed_models.includes(overrides.model)) {
      throw new Error(
        `Requested model '${overrides.model}' is not permitted by profile '${profile.profile_id}'. Allowed models: ${profile.model_constraints.allowed_models.join(", ")}`,
      );
    }

    if (overrides.budget) {
      const b = overrides.budget;
      for (const value of Object.values(b)) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Budgets must be nonnegative integers");
      }
      const retries = b.max_retries ?? b.maxRetries;
      if (retries !== undefined && retries > (profile.budget_limits.max_retries ?? 0)) throw new Error("Retry budget exceeds profile limit");
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
        if (toolName && !profile.tool_policy.whitelist.some(registered => registered === toolName || (!toolName.includes("@") && registered.split("@")[0] === toolName))) {
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
    if (!this.initialized && this.profiles.size === 0) {
      try {
        const dir = path.resolve(process.cwd(), "profiles");
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            const raw = fs.readFileSync(path.join(dir, file), "utf-8");
            const parsed = JSON.parse(raw);
            const profile = this.validateProfileSchema(parsed);
            this.registerProfile(profile);
          }
        }
        this.initialized = true;
      } catch (err: any) {
        logger.error(`[ProfileRegistry] Failed loading profiles: ${err.message}`);
      }
    }
    return Array.from(new Set(Array.from(this.profiles.values()).map((p) => p.profile_id)));
  }
}
