/**
 * ModelProfiles — one table of what each model's request surface accepts.
 *
 * A profile is derived from the model name: family detection (qwen, llama,
 * gpt-oss, nemotron, claude, gemini, …) and — for local names — the
 * parameter count the name declares. Every field is what is true of the
 * model whatever the request:
 *
 *   rejectedParameters  sampling parameters the model rejects or ignores —
 *                       dropped, never sent
 *   efforts             the reasoning-effort vocabulary, weakest →
 *                       strongest (null = no effort control)
 *   toolChoice          the tool_choice modes it accepts
 *   contextWindow       the model's context window in tokens (null = unknown;
 *                       callers may override via discoverContextWindow)
 *   maxOutputTokens     the clamp applied to a requested output token count
 *   budget              the prompt/tool budget preset: "lightweight" for
 *                       small local models (at most 12 tools, no sub-agents,
 *                       minimal system prompt), "standard" for the rest
 */

export type SamplingParameter =
  | "temperature"
  | "topP"
  | "topK"
  | "frequencyPenalty"
  | "presencePenalty";

export type ToolChoiceMode = "auto" | "any" | "tool" | "none";

export type ModelFamily =
  | "qwen"
  | "llama"
  | "gpt-oss"
  | "nemotron"
  | "gemma"
  | "mistral"
  | "deepseek"
  | "glm"
  | "claude"
  | "openai"
  | "gemini"
  | "unknown";

export interface BudgetPreset {
  name: "standard" | "lightweight";
  /** At most this many tools reach the model (discovery tools included). */
  maxTools: number | null;
  /** Sub-agent and async-task tools (and their prompt addendum) are dropped. */
  allowSubAgents: boolean;
  /** "minimal" leaves out the directory tree and the orchestrator addendum. */
  systemPrompt: "full" | "minimal";
}

export const BUDGET_PRESETS: Record<BudgetPreset["name"], BudgetPreset> = {
  standard: { name: "standard", maxTools: null, allowSubAgents: true, systemPrompt: "full" },
  lightweight: { name: "lightweight", maxTools: 12, allowSubAgents: false, systemPrompt: "minimal" },
};

/** Local models at or under this many billion parameters get the lightweight preset. */
export const LIGHTWEIGHT_MAX_BILLION_PARAMETERS = 14;

export interface ModelProfile {
  model: string;
  family: ModelFamily;
  rejectedParameters: SamplingParameter[];
  /** Accepted efforts, weakest → strongest; null = no effort control. */
  efforts: string[] | null;
  toolChoice: ToolChoiceMode[];
  /** Context window in tokens; null when the name declares nothing. */
  contextWindow: number | null;
  /** Ceiling applied to a requested maxOutputTokens; null = no clamp. */
  maxOutputTokens: number | null;
  budget: BudgetPreset;
}

const ALL_SAMPLING: SamplingParameter[] = [
  "temperature",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
];
const ALL_TOOL_CHOICE: ToolChoiceMode[] = ["auto", "any", "tool", "none"];
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

interface FamilyTraits {
  rejectedParameters?: SamplingParameter[];
  /** null = the family takes no effort control at all. */
  efforts: string[] | null;
  toolChoice?: ToolChoiceMode[];
  /** Default context window for the family; null when nothing is known. */
  contextWindow: number | null;
  maxOutputTokens?: number | null;
}

const FAMILY_TRAITS: Record<ModelFamily, FamilyTraits> = {
  // gpt-oss: reasoning-only sampling; effort vocabulary low → high.
  "gpt-oss": {
    rejectedParameters: ALL_SAMPLING,
    efforts: ["low", "medium", "high"],
    contextWindow: 131_072,
  },
  // Qwen3 thinking: no topK on many runtimes; thinking can be switched off.
  qwen: {
    rejectedParameters: ["topK"],
    efforts: ["none", "low", "medium", "high"],
    contextWindow: 131_072,
  },
  llama: { efforts: null, contextWindow: 131_072 },
  nemotron: { efforts: null, contextWindow: 131_072 },
  gemma: { efforts: null, contextWindow: 131_072 },
  mistral: { efforts: null, contextWindow: 131_072 },
  deepseek: { efforts: ["none", "low", "medium", "high"], contextWindow: 163_840 },
  glm: { efforts: ["none", "low", "medium", "high"], contextWindow: 131_072 },
  // Claude 4.7+: adaptive thinking / locked sampling — no sampling at all.
  claude: {
    rejectedParameters: ["temperature", "topP", "topK"],
    efforts: ["none", "medium", "high"],
    toolChoice: ["auto", "any", "tool", "none"],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
  openai: {
    rejectedParameters: ["presencePenalty", "frequencyPenalty"],
    efforts: ["minimal", "low", "medium", "high"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
  },
  gemini: {
    rejectedParameters: ["topK"],
    efforts: ["low", "medium", "high"],
    contextWindow: 1_000_000,
  },
  unknown: { efforts: null, contextWindow: null },
};

const FAMILY_PATTERNS: Array<[RegExp, ModelFamily]> = [
  [/gpt-?oss/i, "gpt-oss"],
  [/qwen/i, "qwen"],
  [/\bllama|llama-?\d/i, "llama"],
  [/nemotron/i, "nemotron"],
  [/gemma/i, "gemma"],
  [/mistral|mixtral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/\bglm/i, "glm"],
  [/claude/i, "claude"],
  [/^gpt|^o\d|openai/i, "openai"],
  [/gemini/i, "gemini"],
];

/** The model family a name belongs to ("Qwen3-8B" → "qwen", unknown → "unknown"). */
export function modelFamilyOf(model: string): ModelFamily {
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(model)) return family;
  }
  return "unknown";
}

/**
 * Billions of parameters a model's name declares ("gemma-4-12b-it" → 12,
 * "Qwen3.8-27B" → 27, "mixtral-8x7b" → 56), or null when it says none.
 */
export function declaredBillionParameters(model: string): number | null {
  const experts = /(\d+)x(\d+(?:\.\d+)?)b\b/i.exec(model);
  if (experts) return Number(experts[1]) * Number(experts[2]);
  const match = /(?:^|[-_:/.])(\d+(?:\.\d+)?)b(?:\b|[-_])/i.exec(model);
  return match ? Number(match[1]) : null;
}

/** True when the name declares a local model at or under 14B parameters. */
export function isLightweightModel(model: string): boolean {
  const size = declaredBillionParameters(model);
  return size !== null && size <= LIGHTWEIGHT_MAX_BILLION_PARAMETERS;
}

/** The profile of `model`, derived from its name. */
export function getModelProfile(model: string): ModelProfile {
  const family = modelFamilyOf(model);
  const traits = FAMILY_TRAITS[family];
  const lightweight = isLightweightModel(model);
  return {
    model,
    family,
    rejectedParameters: [...(traits.rejectedParameters ?? [])],
    efforts: traits.efforts ? [...traits.efforts] : null,
    toolChoice: [...(traits.toolChoice ?? ALL_TOOL_CHOICE)],
    contextWindow: traits.contextWindow,
    maxOutputTokens: traits.maxOutputTokens ?? null,
    budget: BUDGET_PRESETS[lightweight ? "lightweight" : "standard"],
  };
}

/** The effort `requested` within the profile's vocabulary: kept, clamped to its floor / ceiling, or dropped. */
export function effortWithinProfile(
  profile: ModelProfile,
  requested: string | undefined,
): string | undefined {
  if (!requested || !profile.efforts) return requested;
  if (profile.efforts.includes(requested)) return requested;
  const rank = EFFORT_ORDER.indexOf(requested);
  if (rank === -1) return undefined;
  const floor = profile.efforts[0];
  const ceiling = profile.efforts[profile.efforts.length - 1];
  if (rank < EFFORT_ORDER.indexOf(floor)) return floor;
  if (rank > EFFORT_ORDER.indexOf(ceiling)) return ceiling;
  // Between two accepted levels (a vocabulary with a gap): the next one up.
  return profile.efforts.find((effort) => EFFORT_ORDER.indexOf(effort) > rank);
}
