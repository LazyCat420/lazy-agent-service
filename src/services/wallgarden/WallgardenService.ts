import logger from "../../logger.js";
import { getInstancesByType } from "../../providers/instance-registry.js";
import type { InstanceEntry } from "../../types/ProviderTypes.js";

// ── Prism Service URL ───────────────────────────────────────
const PRISM_URL = process.env.REAL_PRISM_URL || "http://10.0.0.16:7777";

// ── Model Cache ─────────────────────────────────────────────
interface VllmBoxInfo {
  id: string;           // e.g. "vllm", "vllm-2"
  nickname: string;     // e.g. "Jetson", "Gold Spark"
  url: string;          // e.g. "http://10.0.0.30:8000"
  model: string | null; // currently loaded model ID
  status: "online" | "offline";
}

let modelCache: VllmBoxInfo[] = [];
let modelCacheTimestamp = 0;
const MODEL_CACHE_TTL_MS = 60_000;

// ── Tool Definition ─────────────────────────────────────────
const TOPIC_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "suggest_topics",
    description:
      "Suggest new topics related to the user's interest graph. Each topic should be 1-3 words.",
    parameters: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: {
            type: "string",
            description:
              "A 1-3 word topic phrase, representing a broader genre, theme, or tangential subject.",
          },
          minItems: 5,
          maxItems: 100,
        },
      },
      required: ["topics"],
    },
  },
};

// ── System Prompts ──────────────────────────────────────────
const BRAINSTORM_SYSTEM_PROMPT = `/no_think
You are a creative topic brainstorming discovery engine. You must call the suggest_topics tool to provide exactly 50 to 100 new topics related to the user's interests.
CRITICAL INSTRUCTIONS:
1. Act as a lateral-thinking discovery algorithm. We want to find interesting YouTube videos.
2. Provide a balanced mix: roughly 30% Similar Media, 40% Broader Genres/Themes, and 30% Intellectual Tangents.
3. ABSOLUTELY DO NOT generate narrow subcategories, specific character names, episode titles, or cast members. (e.g., If the user likes "The Simpsons", DO NOT suggest "Homer Simpson". DO suggest "90s Sitcoms", "Adult Animation").
4. Expand broadly from what is provided.
5. YOU MUST RETURN VALID JSON matching the suggest_topics schema. Do not return markdown. Do not return plain text.`;

const SIMILAR_SYSTEM_PROMPT = `/no_think
You are a creative topic brainstorming discovery engine. You must call the suggest_topics tool to provide exactly 50 to 100 topics related to the user's search query.
CRITICAL INSTRUCTIONS:
1. Act as a lateral-thinking discovery algorithm. We want to find interesting YouTube videos.
2. Provide a balanced mix: roughly 30% Similar Media, 40% Broader Genres/Themes, and 30% Intellectual Tangents.
3. ABSOLUTELY DO NOT generate narrow subcategories, specific character names, episode titles, or cast members. (e.g., If the user searches "The Simpsons", DO NOT suggest "Homer Simpson". DO suggest "90s Sitcoms", "Adult Animation").
4. YOU MUST RETURN VALID JSON matching the suggest_topics schema. Do not return markdown. Do not return plain text.`;

// ── Context interface ───────────────────────────────────────
export interface BrainstormContext {
  interests: string[];
  disliked: string[];
  recentUsed: string[];
  burnedQueries: string[];
  searches?: string[];
  numTopics?: number;
  model?: string;
  provider?: string;
}

export interface SimilarContext extends BrainstormContext {
  query: string;
}

// ── Helpers ─────────────────────────────────────────────────

/** Query a single vLLM box for its currently loaded model */
async function queryVllmBox(url: string): Promise<string | null> {
  try {
    const resp = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const models = data?.data;
    if (Array.isArray(models) && models.length > 0) {
      return models[0].id || null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract topics from a prism /agent response */
function extractTopicsFromResponse(data: any): string[] {
  // The /agent response is { text, thinking, provider, model, usage, ... }
  // Tool calls may be in the response depending on prism's agentic loop
  const text = data?.text || "";

  // Try to parse as JSON first (prism may return the tool call result as text)
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.topics)) {
      return parsed.topics.map((t: any) =>
        typeof t === "string" ? t.trim().toLowerCase() : ""
      ).filter(Boolean);
    }
    if (Array.isArray(parsed)) {
      return parsed.map((t: any) =>
        typeof t === "string" ? t.trim().toLowerCase() : ""
      ).filter(Boolean);
    }
  } catch {
    // Not JSON, try regex extraction
  }

  // Try to extract JSON array from text
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) {
        return arr.map((t: any) =>
          typeof t === "string" ? t.trim().toLowerCase() : ""
        ).filter(Boolean);
      }
    } catch { /* ignore */ }
  }

  // Try to find topics in tool call format within text
  const toolCallMatch = text.match(/"topics"\s*:\s*\[[\s\S]*?\]/);
  if (toolCallMatch) {
    try {
      const wrapper = `{${toolCallMatch[0]}}`;
      const parsed = JSON.parse(wrapper);
      if (Array.isArray(parsed.topics)) {
        return parsed.topics.map((t: any) =>
          typeof t === "string" ? t.trim().toLowerCase() : ""
        ).filter(Boolean);
      }
    } catch { /* ignore */ }
  }

  logger.warn("[WallgardenService] Could not extract topics from response text");
  return [];
}

/** Resolve which provider/model to use — Gold Spark first, Jetson fallback */
async function resolveProviderAndModel(
  preferredModel?: string,
  preferredProvider?: string
): Promise<{ model: string; provider: string }> {
  // If user explicitly specified both, use them
  if (preferredModel && preferredProvider) {
    return { model: preferredModel, provider: preferredProvider };
  }

  // Discover what's available
  const boxes = await discoverModels();
  
  // Prefer Gold Spark (vllm-2)
  const goldSpark = boxes.find(b => b.id === "vllm-2" && b.status === "online" && b.model);
  if (goldSpark && goldSpark.model) {
    return { model: goldSpark.model, provider: "vllm-2" };
  }

  // Fallback to Jetson (vllm)
  const jetson = boxes.find(b => b.id === "vllm" && b.status === "online" && b.model);
  if (jetson && jetson.model) {
    return { model: jetson.model, provider: "vllm" };
  }

  // Fallback to any online vllm box
  const anyOnline = boxes.find(b => b.status === "online" && b.model);
  if (anyOnline && anyOnline.model) {
    return { model: anyOnline.model, provider: anyOnline.id };
  }

  throw new Error("No vLLM boxes are online with loaded models");
}

/** Call prism /agent endpoint (non-streaming) */
async function callPrismAgent(
  model: string,
  provider: string,
  messages: Array<{ role: string; content: string }>,
  tools?: any[],
  temperature: number = 0.1,
  maxTokens: number = 2500,
): Promise<any> {
  const url = `${PRISM_URL}/agent?stream=false`;
  const body: any = {
    model,
    provider,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = { type: "function", function: { name: "suggest_topics" } };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Prism /agent returned ${resp.status}: ${errText.substring(0, 300)}`);
  }

  return resp.json();
}

// ── Public API ──────────────────────────────────────────────

export async function discoverModels(): Promise<VllmBoxInfo[]> {
  const now = Date.now();
  if (modelCache.length > 0 && now - modelCacheTimestamp < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }

  const instances = getInstancesByType("vllm");
  const results: VllmBoxInfo[] = [];

  for (const inst of instances) {
    const entry = inst as InstanceEntry;
    const model = await queryVllmBox(entry.baseUrl);
    results.push({
      id: entry.id,
      nickname: entry.nickname || entry.id,
      url: entry.baseUrl,
      model,
      status: model ? "online" : "offline",
    });
  }

  // If no instances in registry, try known defaults
  if (results.length === 0) {
    const defaults = [
      { id: "vllm", nickname: "Jetson", url: "http://10.0.0.30:8000" },
      { id: "vllm-2", nickname: "Gold Spark", url: "http://10.0.0.141:8000" },
    ];
    for (const d of defaults) {
      const model = await queryVllmBox(d.url);
      results.push({
        ...d,
        model,
        status: model ? "online" : "offline",
      });
    }
  }

  modelCache = results;
  modelCacheTimestamp = now;
  logger.info(`[WallgardenService] Discovered ${results.length} vLLM boxes: ${results.map(r => `${r.nickname}=${r.status}${r.model ? ` (${r.model})` : ""}`).join(", ")}`);
  return results;
}

export async function brainstormTopics(ctx: BrainstormContext): Promise<string[]> {
  const { model, provider } = await resolveProviderAndModel(ctx.model, ctx.provider);
  
  const liked = ctx.interests.slice(0, 15).join(", ");
  const disliked = ctx.disliked.slice(0, 10).join(", ");
  const searches = (ctx.searches || []).slice(-10).join(", ");
  const recentUsed = ctx.recentUsed.slice(-20).join(", ");
  const burnedList = ctx.burnedQueries.slice(-30).join(", ");
  const numTopics = ctx.numTopics || 100;

  const userMessage = `My interests: [${liked}]
Disliked: [${disliked}]
Recent searches: [${searches}]
Recently used (avoid these): [${recentUsed}]
Failed queries (don't reuse these exact phrases, they returned bad results): [${burnedList}]

Suggest ${numTopics} new topics.`;

  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`[WallgardenService] Brainstorm retry ${attempt + 1}/${MAX_RETRIES + 1}`);
      }

      const temperature = 0.1 + attempt * 0.15;
      const data = await callPrismAgent(
        model,
        provider,
        [
          { role: "system", content: BRAINSTORM_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        [TOPIC_TOOL_DEFINITION],
        temperature,
      );

      const topics = extractTopicsFromResponse(data);
      if (topics.length > 0) {
        logger.info(`[WallgardenService] Brainstorm returned ${topics.length} topics via ${provider}/${model}`);
        return topics;
      }

      throw new Error("No topics extracted from response");
    } catch (err: any) {
      lastError = err;
      logger.error(`[WallgardenService] Brainstorm attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  throw lastError || new Error("Brainstorm failed after all retries");
}

export async function generateSimilarTopics(ctx: SimilarContext): Promise<string[]> {
  const { model, provider } = await resolveProviderAndModel(ctx.model, ctx.provider);

  const liked = ctx.interests.slice(0, 15).join(", ");
  const disliked = ctx.disliked.slice(0, 10).join(", ");
  const recentUsed = ctx.recentUsed.slice(-20).join(", ");
  const burnedList = ctx.burnedQueries.slice(-30).join(", ");
  const numTopics = ctx.numTopics || 10;

  const userMessage = `Search query: "${ctx.query}"
My interests: [${liked}]
Disliked: [${disliked}]
Recently used (avoid these): [${recentUsed}]
Failed queries (don't reuse these exact phrases): [${burnedList}]

Suggest ${numTopics} topics related to "${ctx.query}".`;

  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`[WallgardenService] Similar retry ${attempt + 1}/${MAX_RETRIES + 1}`);
      }

      const temperature = 0.1 + attempt * 0.15;
      const data = await callPrismAgent(
        model,
        provider,
        [
          { role: "system", content: SIMILAR_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        [TOPIC_TOOL_DEFINITION],
        temperature,
      );

      const topics = extractTopicsFromResponse(data);
      if (topics.length > 0) {
        logger.info(`[WallgardenService] Similar topics for "${ctx.query}" returned ${topics.length} topics via ${provider}/${model}`);
        return topics;
      }

      throw new Error("No topics extracted from response");
    } catch (err: any) {
      lastError = err;
      logger.error(`[WallgardenService] Similar attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  throw lastError || new Error("Similar topic generation failed after all retries");
}
