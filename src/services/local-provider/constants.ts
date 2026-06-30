import { PROVIDERS } from "../../constants.ts";

// Re-exported from utilities-library (single source of truth)
export { LOCAL_PROVIDER_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
export { THINKING_PATTERNS } from "@rodrigo-barraza/utilities-library/taxonomy";

/**
 * Providers that use native MCP tool execution (the provider's own
 * internal loop handles multi-step tool calling via native events).
 * These providers only need tools on the first pass — subsequent
 * passes should omit tools to force an eventual text response.
 */
export const NATIVE_MCP_TYPES = new Set<string>([PROVIDERS.LM_STUDIO, PROVIDERS.OLLAMA]);

/**
 * Providers that emit thinking tokens (<think> tags) by default.
 * When the client doesn't explicitly set thinkingEnabled, these
 * providers default to thinkingEnabled=true.
 */
export const DEFAULT_THINKING_TYPES = new Set<string>([PROVIDERS.LM_STUDIO, PROVIDERS.LLAMA_CPP, PROVIDERS.VLLM]);

/**
 * Providers that support model management (load/unload/ensure).
 * Only applicable to servers that can hot-swap models.
 */
export const MODEL_MANAGEMENT_TYPES = new Set<string>([PROVIDERS.LM_STUDIO]);




/**
 * Models trained for function calling / tool use.
 * Matched against the lowercased model key.
 */
export const FUNCTION_CALL_PATTERNS = [
  "qwen",
  "deepseek",
  "llama",
  "mistral",
  "gemma",
  "phi",
  "command",
  "hermes",
  "functionary",
  "gpt-oss",
  "nemotron",
  "minimax",
] as const;

/**
 * Models that support image/vision input.
 * Matched against the lowercased model key.
 */
export const VISION_PATTERNS = [
  "vl",
  "vision",
  "llava",
  "pixtral",
  "minicpm-v",
  "internvl",
  "cogvlm",
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "qwen3.6-vl",
  "molmo",
  "paligemma",
  "llama-3.2-vision",
  "llama-vision",
  "idefics",
  "phi-3-vision",
  "phi-3.5-vision",
  "phi-4-vision",
  "phi4mm",
  "minicpmv",
  "ovis",
  "deepseek-vl",
  "gemma-4",
] as const;

/**
 * Models that support video input.
 * Matched against the lowercased model key.
 */
export const VIDEO_PATTERNS = [
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "qwen3.6-vl",
  "llava-next-video",
  "llava-onevision",
  "internvl",
  "phi4mm",
  "gemma-4",
] as const;

/**
 * Models that support audio input.
 * Matched against the lowercased model key.
 */
export const AUDIO_PATTERNS = [
  "qwen2-audio",
  "qwen-audio",
  "salmonn",
  "ultravox",
  "phi4mm",
  "minicpmo",
  "whisper",
  "granite-speech",
  "kimi-audio",
  "qwen2.5-omni",
  "qwen3-omni",
  "gemma-4-e2b",
  "gemma-4-e4b",
] as const;
