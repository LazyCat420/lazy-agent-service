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

// Detect if we are inside the Docker container. The old second probe
// (/opt/venv/bin/python) dated from when a python venv was baked into the
// image; the image is node-only now, so /.dockerenv is the whole signal.
const isDocker = fs.existsSync("/.dockerenv");

// TWO PORTS, TWO MEANINGS — they are not interchangeable:
//   LAZY_TOOL_BIND_PORT   (7778) — what this process listens on. Same value
//                                  src/index.ts binds; compose maps 5591:7778.
//   LAZY_TOOL_SERVICE_PORT (5591) — the EXTERNAL host port other services and
//                                  prism dial. Set to 5591 by the vault .env.
// This used to be one variable defaulting to 7778 here and 5591 in
// PrismRegistrationService.ts, so with the deployed env set the self-URL below
// resolved to localhost:5591 — a port nothing listens on inside the container.
export const LAZY_TOOL_BIND_PORT = Number(process.env.LAZY_TOOL_BIND_PORT || "7778");
export const LAZY_TOOL_SERVICE_PORT = Number(process.env.LAZY_TOOL_SERVICE_PORT || "5591");

// Self-referential: always the BIND port, never the external one.
export const LAZY_TOOL_SERVICE_URL = `http://127.0.0.1:${LAZY_TOOL_BIND_PORT}`;
export const LAZY_TOOL_SERVICE_API_KEY = process.env.LAZY_TOOL_SERVICE_API_KEY;
export const EXECUTION_TIMEOUT_MS = Number(process.env.EXECUTION_TIMEOUT_MS || "30000");
// Slow external-fetch tools need a longer bridge deadline than the 30s
// default: their own internal retry budgets (e.g. lazy_web_search's 20s+10s
// httpx attempts) meet or exceed it, so the bridge aborted them right before
// their retry could answer — the #1 tool-failure cause in 7d telemetry
// (2026-07-23: ~40 "operation was aborted" failures across 9 tools).
export const SLOW_TOOL_TIMEOUT_MS = Number(process.env.SLOW_TOOL_TIMEOUT_MS || "60000");
export const SLOW_TOOLS = new Set(
  (process.env.SLOW_TOOLS ||
    "lazy_web_search,scrape_url,read_url,get_sec_filings,run_tool_chain,get_market_map_data,get_ticker_summary,get_finnhub_news")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || "60000");
// trading-service runs as a separate container — "localhost" inside this
// container never reaches it; default to the NAS host IP (same as HTML_NOTES_URL).
export const TRADING_SERVICE_URL = process.env.TRADING_SERVICE_URL
  || (isDocker ? "http://10.0.0.16:3031" : "http://localhost:3031");
export const TRADING_SERVICE_API_KEY = process.env.TRADING_SERVICE_API_KEY;
// html-notes runs as a separate container — "localhost" inside this container
// never reaches it; default to the NAS host IP.
export const HTML_NOTES_URL = process.env.HTML_NOTES_URL || "http://10.0.0.16:8035";
// treesearch-service (cannabis strain / genomics / forum warehouse) runs as a separate
// container — same reasoning as above, default to the NAS host IP.
export const TREESEARCH_SERVICE_URL = process.env.TREESEARCH_SERVICE_URL || "http://10.0.0.16:8005";

// News providers for the shared news_search tool (NewsSearchService). Keys are
// hydrated from the vault via boot.ts like everything else here — no defaults,
// no secrets in this file. A provider without a key is simply skipped, so it is
// fine for only some of these to be set.
export const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
export const WORLDNEWSAPI_KEY = process.env.WORLDNEWSAPI_KEY;
export const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY;
export const THENEWSAPI_KEY = process.env.THENEWSAPI_KEY;
export const NEWSAPI_API_KEY = process.env.NEWSAPI_API_KEY;

const CONFIG = {
  LAZY_TOOL_BIND_PORT,
  LAZY_TOOL_SERVICE_PORT,
  LAZY_TOOL_SERVICE_URL,
  MONGODB_URI: MONGO_URI,
  LAZY_TOOL_SERVICE_API_KEY,
  EXECUTION_TIMEOUT_MS,
  SLOW_TOOL_TIMEOUT_MS,
  SLOW_TOOLS,
  CACHE_TTL_MS,
  TRADING_SERVICE_URL,
  TRADING_SERVICE_API_KEY,
  HTML_NOTES_URL,
  TREESEARCH_SERVICE_URL,
  GNEWS_API_KEY,
  WORLDNEWSAPI_KEY,
  CURRENTS_API_KEY,
  THENEWSAPI_KEY,
  NEWSAPI_API_KEY,
};
export default CONFIG;
