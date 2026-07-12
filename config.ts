// ─── Environment Accessors ──────────────────────────────────
// Typed accessor layer over process.env. The Vault service is
// the single source of truth — boot.js hydrates process.env
// from the Vault before any module imports run.
//
// This file contains NO defaults and NO secrets.

// ── Helpers ────────────────────────────────────────────────────

export interface ProviderInstance {
  url: string;
  concurrency: number;
  nickname?: string;
}

/**
 * Parse indexed env vars into an array of provider instance objects.
 *
 * For a prefix of "PROVIDER_LM_STUDIO", this reads:
 *   PROVIDER_LM_STUDIO_1_URL, PROVIDER_LM_STUDIO_1_CONCURRENCY, PROVIDER_LM_STUDIO_1_NICKNAME
 *   PROVIDER_LM_STUDIO_2_URL, PROVIDER_LM_STUDIO_2_CONCURRENCY, PROVIDER_LM_STUDIO_2_NICKNAME
 *   ... up to 10 instances
 *
 * Returns: [{ url, concurrency, nickname? }, ...]
 */
function parseProviderInstances(envPrefix: string): ProviderInstance[] {
  const instances: ProviderInstance[] = [];
  for (let i = 1; i <= 10; i++) {
    const url = process.env[`${envPrefix}_${i}_URL`];
    if (!url) continue;
    const concurrency = parseInt(process.env[`${envPrefix}_${i}_CONCURRENCY`] ?? "", 10) || 1;
    const nickname = process.env[`${envPrefix}_${i}_NICKNAME`];
    const entry: ProviderInstance = { url, concurrency };
    if (nickname) entry.nickname = nickname;
    instances.push(entry);
  }
  return instances;
}

// ── Server ─────────────────────────────────────────────────────
export const PRISM_SERVICE_PORT = process.env.PRISM_SERVICE_PORT || 7778;

// ── AI Provider API Keys ───────────────────────────────────────
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const GOOGLE_CLOUD_GEMINI_API_KEY = process.env.GOOGLE_CLOUD_GEMINI_API_KEY;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const INWORLD_BASIC = process.env.INWORLD_BASIC;

// ── Local Provider Instances ───────────────────────────────────
// Parsed from indexed env vars: PROVIDER_<TYPE>_<N>_URL, _CONCURRENCY, _NICKNAME
export const PROVIDER_LM_STUDIO = parseProviderInstances("PROVIDER_LM_STUDIO");
export const PROVIDER_VLLM = parseProviderInstances("PROVIDER_VLLM");
export const PROVIDER_OLLAMA = parseProviderInstances("PROVIDER_OLLAMA");
export const PROVIDER_LLAMA_CPP = parseProviderInstances("PROVIDER_LLAMA_CPP");

// ── MongoDB ────────────────────────────────────────────────────
export const MONGO_URI = process.env.MONGO_URI;
export const MONGO_DB_NAME = process.env.PRISM_SERVICE_MONGO_DB_NAME || process.env.PRISM_MONGO_DB_NAME || process.env.MONGO_DB_NAME || "prism";

// ── MinIO (Optional — files stored inline in MongoDB if not set) ──
export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
export const MINIO_BUCKET_NAME = process.env.PRISM_SERVICE_MINIO_BUCKET_NAME || process.env.PRISM_MINIO_BUCKET_NAME || process.env.MINIO_BUCKET_NAME;

// ── Tools API ──────────────────────────────────────────────────
export const TOOLS_SERVICE_URL = process.env.TOOLS_SERVICE_URL;

// ── Default Model Names ───────────────────────────────────────
// Vault-backed model identifiers — swap models without code deploys.

export const LIVE_AUDIO_MODEL = process.env.LIVE_AUDIO_MODEL;
export const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL;
export const GOOGLE_TTS_MODEL = process.env.GOOGLE_TTS_MODEL;
export const GOOGLE_EMBEDDING_MODEL = process.env.GOOGLE_EMBEDDING_MODEL;

// ── LM Studio Tuning ──────────────────────────────────────────
export const LM_STUDIO_EVAL_BATCH_SIZE = parseInt(process.env.LM_STUDIO_EVAL_BATCH_SIZE ?? "", 10) || 4096;
export const LM_STUDIO_PHYSICAL_BATCH_SIZE = parseInt(process.env.LM_STUDIO_PHYSICAL_BATCH_SIZE ?? "", 10) || 4096;
export const LM_STUDIO_DEFAULT_MAX_CONTEXT = parseInt(process.env.LM_STUDIO_DEFAULT_MAX_CONTEXT ?? "", 10) || 262144;

import fs from "node:fs";

// Detect if we are inside the Docker container
const isDocker = fs.existsSync("/.dockerenv") || fs.existsSync("/opt/venv/bin/python");

const defaultInterpreter = isDocker
  ? "/opt/venv/bin/python"
  : "/home/lazycat/github/projects/sun/trading-service/.venv/bin/python";

const defaultExecScript = isDocker
  ? "/app/python/scripts/execute_tool.py"
  : "/home/lazycat/github/projects/sun/trading-service/scripts/execute_tool.py";

const defaultCwd = isDocker
  ? "/app/python"
  : "/home/lazycat/github/projects/sun/trading-service";

const defaultPythonPath = isDocker
  ? "/app/python"
  : [
      "/home/lazycat/github/projects/sun/trading-service",
      "/home/lazycat/github/projects/sun/trading-client"
    ].join(process.platform === "win32" ? ";" : ":");

export const LAZY_TOOL_SERVICE_PORT = Number(process.env.LAZY_TOOL_SERVICE_PORT || "7778");
export const LAZY_TOOL_SERVICE_URL = process.env.LAZY_TOOL_SERVICE_URL || `http://localhost:${LAZY_TOOL_SERVICE_PORT}`;
export const PYTHON_INTERPRETER = process.env.PYTHON_INTERPRETER || defaultInterpreter;
export const PYTHON_EXEC_SCRIPT = process.env.PYTHON_EXEC_SCRIPT || defaultExecScript;
export const PYTHON_CWD = process.env.PYTHON_CWD || defaultCwd;
export const PYTHONPATH = process.env.PYTHONPATH || defaultPythonPath;
export const LAZY_TOOL_SERVICE_API_KEY = process.env.LAZY_TOOL_SERVICE_API_KEY;
export const EXECUTION_TIMEOUT_MS = Number(process.env.EXECUTION_TIMEOUT_MS || "30000");
export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || "60000");
export const TRADING_SERVICE_URL = process.env.TRADING_SERVICE_URL || "http://localhost:3031";
export const TRADING_SERVICE_API_KEY = process.env.TRADING_SERVICE_API_KEY;
export const HTML_NOTES_URL = process.env.HTML_NOTES_URL || "http://localhost:8035";

const CONFIG = {
  LAZY_TOOL_SERVICE_PORT,
  LAZY_TOOL_SERVICE_URL,
  MONGODB_URI: MONGO_URI,
  PYTHON_INTERPRETER,
  PYTHON_EXEC_SCRIPT,
  PYTHON_CWD,
  PYTHONPATH,
  LAZY_TOOL_SERVICE_API_KEY,
  EXECUTION_TIMEOUT_MS,
  CACHE_TTL_MS,
  TRADING_SERVICE_URL,
  TRADING_SERVICE_API_KEY,
  HTML_NOTES_URL,
};
export default CONFIG;
