import {
  effortWithinProfile,
  getModelProfile,
  type ModelProfile,
  type SamplingParameter,
  type ToolChoiceMode,
} from "./ModelProfiles.ts";

const OPTION_KEYS: Record<SamplingParameter, string> = {
  temperature: "temperature",
  topP: "topP",
  topK: "topK",
  frequencyPenalty: "frequencyPenalty",
  presencePenalty: "presencePenalty",
};

const ALL_TOOL_CHOICE: ToolChoiceMode[] = ["auto", "any", "tool", "none"];

/** Sub-agent / async-task tools, excluded from the lightweight preset. */
const SUB_AGENT_TOOL_PATTERN = /sub[-_]?agent|async[-_]?task|spawn[-_]?agent|dispatch[-_]?task|task[-_]?tool/i;

/** A requested maxOutputTokens on a lightweight model is clamped here. */
const LIGHTWEIGHT_MAX_OUTPUT_TOKENS = 8_192;

export interface ApplyModelProfileInput {
  /** Tool names the request would send; trimmed to the budget on lightweight models. */
  toolNames?: string[];
  /** Discovered (or caller-known) context window, overriding the family default. */
  contextWindow?: number;
}

export interface ApplyModelProfileResult<T> {
  /** The options an adapter receives: rejected parameters dropped, effort and tool_choice inside the profile. */
  options: T | undefined;
  /** The tool budget the caller must honour (null = unlimited). */
  maxTools: number | null;
  /** True when the system prompt must be sent in its minimal form. */
  strippedPrompt: boolean;
  /** The output token count to send (a clamped copy of the request), or undefined when the request set none. */
  clampOutputTo: number | undefined;
}

/**
 * The options an adapter receives for `modelName`: rejected sampling
 * parameters removed, the effort inside the vocabulary, tool_choice mapped
 * to a mode the model takes. Lightweight models additionally get their tool
 * list trimmed to the budget (discovery tools included, sub-agent and
 * async-task tools dropped) and their output clamped.
 *
 * Returns the input object unchanged when nothing changes.
 */
export function applyModelProfile<T extends Record<string, unknown>>(
  modelName: string,
  options: T | undefined,
  input: ApplyModelProfileInput = {},
): ApplyModelProfileResult<T> {
  const profile = getModelProfile(modelName);
  const lightweight = profile.budget.name === "lightweight";
  const maxTools = lightweight ? profile.budget.maxTools : null;
  const strippedPrompt = lightweight;

  let clampOutputTo: number | undefined;
  const requested = options?.maxOutputTokens as number | undefined;
  if (requested !== undefined && Number.isFinite(requested)) {
    let ceiling = profile.maxOutputTokens ?? Infinity;
    if (lightweight) ceiling = Math.min(ceiling, LIGHTWEIGHT_MAX_OUTPUT_TOKENS);
    clampOutputTo = Math.max(1, Math.min(requested, ceiling));
  }

  const needsTrim = lightweight && input.toolNames !== undefined
    && input.toolNames.length !== trimmedToolNames(input.toolNames, maxTools).length;
  const sanitized = needsTrim ? { ...(options as Record<string, unknown>), toolNames: trimmedToolNames(input.toolNames!, maxTools) } : sanitizeOptions(profile, options);

  return { options: sanitized as T | undefined, maxTools, strippedPrompt, clampOutputTo };
}

function trimmedToolNames(toolNames: string[], maxTools: number | null): string[] {
  const kept = toolNames.filter((name) => !SUB_AGENT_TOOL_PATTERN.test(name));
  return maxTools === null ? kept : kept.slice(0, maxTools);
}

function sanitizeOptions<T extends Record<string, unknown>>(
  profile: ModelProfile,
  options: T | undefined,
): T | undefined {
  if (!options) return options;
  let changed = false;
  const result: Record<string, unknown> = { ...options };
  for (const parameter of profile.rejectedParameters) {
    const key = OPTION_KEYS[parameter];
    if (result[key] !== undefined) {
      delete result[key];
      changed = true;
    }
  }
  for (const key of ["reasoningEffort", "thinkingLevel"] as const) {
    const requested = result[key] as string | undefined;
    if (!requested || requested === "none") continue;
    const effort = effortWithinProfile(profile, requested);
    if (effort !== requested) {
      if (effort === undefined) delete result[key];
      else result[key] = effort;
      changed = true;
    }
  }
  const toolChoice = result.toolChoice as string | undefined;
  if (toolChoice) {
    const mode = (toolChoice === "required" ? "any" : toolChoice) as ToolChoiceMode;
    if (mode !== toolChoice) {
      // OpenAI's "required" alias, normalized to the mode every model takes.
      result.toolChoice = "any";
      changed = true;
    }
    if (ALL_TOOL_CHOICE.includes(mode) && !profile.toolChoice.includes(mode)) {
      result.toolChoice = "auto";
      changed = true;
    }
  }
  return changed ? (result as T) : options;
}
