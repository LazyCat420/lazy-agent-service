import type { Provider } from "./provider.ts";

export interface ProviderInstanceConfig {
  url: string;
  concurrency?: number;
  nickname?: string;
}

export interface InstanceEntry {
  id: string;
  type: string;
  baseUrl: string;
  concurrency: number;
  instanceNumber: number;
  nickname?: string;
  provider: Provider;
}

// Basic interfaces for chat structures
export interface ChatMessageContent {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: string;
  content?: string | ChatMessageContent[];
  name?: string;
  images?: string[];
  toolCalls?: Array<{
    id?: string | null;
    name: string;
    args?: Record<string, unknown> | unknown;
  }>;
  thinking?: string;
  thinkingSignature?: string;
  /** Tool result correlation — maps this message to the tool_use that produced it. */
  tool_call_id?: string;
  /** Generic message ID — fallback for tool correlation. */
  id?: string;
}

export interface ProviderResponseUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  text?: string;
  thinking?: string;
  images?: Array<{ data: string; mimeType: string }>;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  provider?: string;
  model?: string;
  usage?: ProviderResponseUsage;
  estimatedCost?: number;
}

export interface ProviderOptions {
  maxTokens?: number;
  temperature?: number;
  deliveryMode?: "STABLE" | "BALANCED" | "CREATIVE";
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  serviceTier?: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: string;
  thinkingBudget?: number | string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  signal?: AbortSignal;
  webSearch?: boolean | string;
  webFetch?: boolean;
  codeExecution?: boolean;
  urlContext?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  _retryAttempt?: number;
  reasoningSummary?: boolean | string;
  verbosity?: string;
  seed?: number | string;
  responseFormat?: string | { type: string };
  responseSchema?: Record<string, unknown>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
  parallelToolCalls?: boolean;
  /** prism's forced final turn: "none" keeps the tool block but calls with tool_choice "none". */
  toolChoice?: string;
  candidateCount?: number;
  responseMimeType?: string;
  store?: boolean;
  mediaResolution?: string;
  topLogprobs?: number;
  responseLogprobs?: boolean;
  logprobs?: number;
  model?: string;
  format?: string;
  instructions?: string;
  language?: string;
  prompt?: string | number;
  // Context length
  minContextLength?: number;
  evalBatchSize?: number;
  contextLength?: number;
  _loadedContextLength?: number;
  _loadedEvalBatchSize?: number;
  _loadedPhysicalBatchSize?: number;
  // Embedding
  dimensions?: number;
  // Extended sampling
  minP?: number;
  // LM Studio load config
  context_length?: number;
  flash_attention?: boolean;
  offload_kv_cache_to_gpu?: boolean;
  eval_batch_size?: number;
  parallel?: number;
  unified_kv_cache?: boolean;
  // Image generation
  forceImageGeneration?: boolean;
  imageCount?: number;
  // System prompt
  systemPrompt?: string;
  // OpenAI Responses API
  responsesAPI?: boolean;
  // Provider routing
  agent?: string;
  username?: string;
  project?: string;
  // ElevenLabs-specific
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  // Google embedding task type
  taskType?: string;
}
