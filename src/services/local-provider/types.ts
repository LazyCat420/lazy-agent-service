export interface ModelEntry {
  name: string;
  label: string;
  modelType: string;
  inputTypes: string[];
  outputTypes: string[];
  supportsSystemPrompt: boolean;
  streaming: boolean;
  defaultTemperature?: number;
  pricing: { inputPerMillion: number; outputPerMillion: number };
  tools?: string[];
  thinking?: boolean;
  vision?: boolean;
  contextLength?: number;
  size?: string;
  params?: string;
  quantization?: string;
  bitsPerWeight?: number;
  architecture?: string;
  publisher?: string;
  loaded?: boolean;
  instanceNumber?: number;
  providerType?: string;
  maxOutputTokens?: number;
  _raw?: unknown;
}

export interface ListModelsResponse {
  models?: Record<string, unknown>[];
  data?: Record<string, unknown>[];
}

export interface LmStudioRawModel {
  key: string;
  display_name?: string;
  type?: string;
  quantization?: {
    name?: string;
    bits_per_weight?: number;
  };
  max_context_length?: number;
  size_bytes?: number;
  params_string?: string;
  architecture?: string;
  publisher?: string;
  loaded_instances?: unknown[];
  capabilities?: Record<string, unknown>;
}

export interface OllamaRawModel {
  model?: string;
  name?: string;
  size?: number;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

export interface OpenAICompatRawModel {
  key?: string;
  id?: string;
  display_name?: string;
}

export interface GenericProvider {
  listModels?: () => Promise<ListModelsResponse>;
  checkHealth?: () => Promise<{
    ok: boolean;
    status: string;
    [key: string]: unknown;
  }>;
  loadModel?: (
    modelKey: string,
    options?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  unloadModel?: (modelInstanceId: string) => Promise<unknown>;
  ensureModelLoaded?: (
    modelKey: string,
    options?: Record<string, unknown>,
    signal?: AbortSignal,
    onStatus?: (status: unknown) => void,
  ) => Promise<unknown>;
  generateText?: (
    messages: unknown,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  generateTextStream?: (
    messages: unknown,
    model: string,
    options?: Record<string, unknown>,
  ) => AsyncGenerator<unknown>;
  generateEmbedding?: (
    content: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  captionImage?: (
    images: unknown,
    prompt: unknown,
    model: string,
    systemPrompt?: unknown,
  ) => Promise<unknown>;
}

export interface HuggingFaceMetadata {
  architectures: string[];
  modelType: string | null;
  pipelineTag: string | null;
  tags: string[];
  author: string | null;
  totalParams: number | null;
  totalSize: number | null;
  paramsByDtype: Record<string, number> | null;
}
