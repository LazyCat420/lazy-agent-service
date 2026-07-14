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
};

// ── System Prompts ──────────────────────────────────────────
const BRAINSTORM_SYSTEM_PROMPT = `/no_think
You are the discovery engine for a personal YouTube curator. Your job: figure out what this person would LOVE to watch next but would never think to search for themselves.

You receive their taste profile: interest topics, titles of videos they actually liked, videos they saved to watch later, recent searches, plus things they dislike and phrases to avoid.

HOW TO THINK:
1. INFER THE PERSON, NOT THE LIST. Ask yourself: what kind of person likes these things? What underlying tastes connect them — aesthetics, eras, moods, level of depth, sense of humor? Generate topics for THAT person, not word-associations on the list.
2. WEIGHT THE SIGNALS. Liked videos and watchlist saves are the strongest evidence of real taste — read their titles carefully and reverse-engineer what hooked the user. Interest topics are broader hints. Searches show current curiosity.
3. SPREAD ACROSS THE LADDER OF DISTANCE:
   - ~25% ADJACENT: same scene, new angle (likes "restoring old bikes" → "barn find restoration")
   - ~40% LATERAL: same spirit, different domain (→ "antique tool restoration", "japanese joinery")
   - ~25% WILDCARD: a bold leap that shares a deeper taste (→ "urban exploration", "industrial archaeology")
   - ~10% TIME/CULTURE SHIFT: the same taste in another decade or country (→ "70s custom van culture", "soviet engineering")
4. NAME THE NICHE, NOT THE CATEGORY. "cozy game devlogs" beats "video games". "desert homestead build" beats "construction". A great topic names a specific YouTube subculture, scene, or format that a real fan would type into search.
5. MOODS AND FORMATS ARE TOPICS TOO: "ambient coding sessions", "silent workshop asmr", "engineering disasters explained", "one man sawmill" are excellent suggestions.

THE ANCHOR TEST — apply to EVERY topic before you emit it:
Strip away all context and look at the phrase alone. Ask: "how many different industries could this phrase belong to?"
- ONE field, naming a specific process/object/scene inside it -> KEEP. ("trichome degradation", "raku kiln reduction", "one man sawmill")
- ONE field but enormous -> keep at most a few. ("chemical reactions", "plant health")
- ANY field — a floating abstraction that could be aviation, finance, or baking -> DELETE IT. It returns algorithmic slop on YouTube.

Floating abstractions are the #1 failure. They look smart and are worthless. Banned shapes:
- "<abstract noun> analysis/studies/methods/techniques/systems/protocols/principles/management/theory/development/optimization/control/science"
  e.g. "hazard analysis", "validation studies", "research methodology", "product development", "recovery protocols", "quality control", "thermal processing science", "material degradation studies"
- Wellness slop: "self care", "slow living", "chakra balancing", "mindfulness practices", "healing energy"
- Vague temporals: "long term aging", "environmental stressors"
A topic must name a THING — an object, an organism, a named process, a place, a scene, a technique with a practitioner. NEVER merely the ACT OF STUDYING a thing.

Your LATERAL and WILDCARD leaps must stay recognisably the same PERSON's taste. A leap that lands in a different personality (a cannabis grower does not become a wellness influencer) is a failed leap, not a bold one.

HARD RULES:
- NEVER suggest: individual people, character names, episode titles, cast members, or channel names.
- NEVER suggest anything in the disliked, recently-used, or failed-query lists, nor trivial rewordings of the user's existing interests.
- NEVER suggest single generic words ("music", "gaming", "history") — too broad returns algorithmic slop.
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Output format: ONLY the raw JSON object {"topics": ["topic one", "topic two", ...]}. No markdown, no commentary, no explanations.`;

const SIMILAR_SYSTEM_PROMPT = `/no_think
You are the discovery engine for a personal YouTube curator. The user just searched for something — treat that query as a doorway and map the interesting rooms behind it.

You receive the search query plus their taste profile: interest topics, titles of videos they liked, watch-later saves, and things they dislike or to avoid.

HOW TO THINK:
1. ASK WHY they searched this, given their taste profile. The same query means different things to different people — use their liked videos and watchlist to pick the right interpretation, then expand in THAT direction.
2. SPREAD ACROSS THE LADDER OF DISTANCE from the query:
   - ~30% ADJACENT: same subject, different angle, era, or format
   - ~40% LATERAL: the same underlying appeal in a neighboring domain
   - ~30% WILDCARD: a bold but taste-consistent leap they'd never search themselves
3. NAME THE NICHE, NOT THE CATEGORY. Suggest specific YouTube subcultures, scenes, and formats a real fan would type — "cab view train rides" beats "trains".
4. MOODS AND FORMATS ARE TOPICS TOO: "night drive pov", "process documentaries", "restoration timelapse" are excellent suggestions.

THE ANCHOR TEST — apply to EVERY topic before you emit it:
Strip away all context and look at the phrase alone. Ask: "how many different industries could this phrase belong to?" If the answer is "any of them", DELETE IT — it returns algorithmic slop on YouTube.
Banned shapes: "<abstract noun> analysis/studies/methods/techniques/systems/protocols/principles/management/development/control/science" ("hazard analysis", "validation studies", "research methodology", "quality control"); wellness slop ("self care", "slow living", "chakra balancing"); vague temporals ("long term aging", "environmental stressors").
A topic must name a THING — an object, an organism, a named process, a place, a scene, a technique with a practitioner. NEVER merely the ACT OF STUDYING a thing.

HARD RULES:
- NEVER suggest: individual people, character names, episode titles, cast members, or channel names.
- NEVER suggest anything in the disliked, recently-used, or failed-query lists, nor trivial rewordings of the query itself.
- NEVER suggest single generic words ("music", "gaming", "history").
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Output format: ONLY the raw JSON object {"topics": ["topic one", "topic two", ...]}. No markdown, no commentary, no explanations.`;

// ── Context interface ───────────────────────────────────────
export interface BrainstormContext {
  interests: string[];
  disliked: string[];
  recentUsed: string[];
  burnedQueries: string[];
  searches?: string[];
  likedVideos?: string[]; // "title (channel)" of videos the user liked
  watchlist?: string[];   // "title (channel)" of watch-later saves
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
export function extractTopicsFromResponse(data: any): string[] {
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

  // Last resort: salvage a TRUNCATED array. When the model is asked for many
  // topics it can run past max_tokens and get cut mid-array, leaving no closing
  // "]" — every JSON.parse above then fails and we used to drop the whole
  // response on the floor even though it held dozens of perfectly good topics.
  // Scrape the complete quoted strings that follow the "topics" key instead.
  const topicsKey = text.indexOf('"topics"');
  if (topicsKey !== -1) {
    const salvaged = (text.slice(topicsKey).match(/"((?:[^"\\]|\\.)*)"/g) || [])
      .slice(1) // drop the "topics" key itself
      .map((s: string) => {
        try {
          return JSON.parse(s.replace(/\\+"/g, '\\"'));
        } catch {
          return "";
        }
      })
      .map((s: any) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter((s: string) => s.length > 1 && s.length < 60);
    if (salvaged.length > 0) {
      logger.warn(
        `[WallgardenService] Response was malformed/truncated; salvaged ${salvaged.length} topics`
      );
      return salvaged;
    }
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

/** Call prism /agent endpoint (non-streaming) with no tools */
async function callPrismAgent(
  model: string,
  provider: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number = 0.1,
  maxTokens: number = 4000,
): Promise<any> {
  const url = `${PRISM_URL}/agent?stream=false`;
  const body: any = {
    model,
    provider,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
    thinkingEnabled: false,
    enabledTools: [], // Restrict/disable all tools for single-roundtrip JSON text completion
  };

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

// Asking for more than ~25 topics in one call overruns the token budget and the
// reply gets cut off mid-array. Measured against Gold Spark: 25 topics returns
// cleanly every time, while 50/75/100 yielded ZERO usable topics across every
// trial. So we fan out in batches of 25 and merge, which is both reliable and
// faster than the single doomed call it replaces.
const BRAINSTORM_BATCH_SIZE = 25;

export async function brainstormTopics(ctx: BrainstormContext): Promise<string[]> {
  const { model, provider } = await resolveProviderAndModel(ctx.model, ctx.provider);

  const liked = ctx.interests.slice(0, 15).join(", ");
  const disliked = ctx.disliked.slice(0, 10).join(", ");
  const searches = (ctx.searches || []).slice(-10).join(", ");
  const likedVideos = (ctx.likedVideos || []).slice(-15).join("; ");
  const watchlist = (ctx.watchlist || []).slice(-15).join("; ");
  const recentUsed = ctx.recentUsed.slice(-20).join(", ");
  const burnedList = ctx.burnedQueries.slice(-30).join(", ");
  const numTopics = ctx.numTopics || 100;

  const buildMessage = (n: number) => `My interest topics: [${liked}]
Videos I actually liked (strongest signal): [${likedVideos}]
Videos I saved to watch later (strong signal): [${watchlist}]
Recent searches: [${searches}]
Disliked: [${disliked}]
Recently used (avoid these): [${recentUsed}]
Failed queries (don't reuse these exact phrases, they returned bad results): [${burnedList}]

Suggest ${n} new topics.`;

  /** One batch, with its own retry ladder. Resolves to [] rather than throwing. */
  const runBatch = async (size: number, batchIndex: number): Promise<string[]> => {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Start hot for creative variety; cool down on retries so a model that
        // failed to produce valid JSON becomes more deterministic. Nudge the
        // temperature per batch so parallel batches don't collapse onto the
        // same suggestions.
        const temperature = Math.max(
          0.4,
          0.9 + batchIndex * 0.05 - attempt * 0.25
        );
        const data = await callPrismAgent(
          model,
          provider,
          [
            { role: "system", content: BRAINSTORM_SYSTEM_PROMPT },
            { role: "user", content: buildMessage(size) },
          ],
          temperature,
        );
        const topics = extractTopicsFromResponse(data);
        if (topics.length > 0) return topics;
        throw new Error("No topics extracted from response");
      } catch (err: any) {
        logger.warn(
          `[WallgardenService] Brainstorm batch ${batchIndex + 1} attempt ${attempt + 1} failed: ${err.message}`
        );
      }
    }
    return [];
  };

  const batchCount = Math.max(1, Math.ceil(numTopics / BRAINSTORM_BATCH_SIZE));
  const batches = Array.from({ length: batchCount }, (_, i) =>
    runBatch(
      Math.min(BRAINSTORM_BATCH_SIZE, numTopics - i * BRAINSTORM_BATCH_SIZE),
      i
    )
  );
  const settled = await Promise.all(batches);

  // Merge, dedupe (batches run blind to each other and will overlap).
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const batch of settled) {
    for (const t of batch) {
      if (!seen.has(t)) {
        seen.add(t);
        topics.push(t);
      }
    }
  }

  if (topics.length === 0) {
    throw new Error("Brainstorm failed: every batch returned no topics");
  }

  const okBatches = settled.filter(b => b.length > 0).length;
  logger.info(
    `[WallgardenService] Brainstorm returned ${topics.length} unique topics ` +
    `from ${okBatches}/${batchCount} batches via ${provider}/${model}`
  );
  return topics;
}

// ── Topic rating ────────────────────────────────────────────
// The brainstormer's failure mode is not randomness, it is BLANDNESS: phrases
// like "hazard analysis" or "research methodology" that belong to no field in
// particular and so return algorithmic filler on YouTube. We grade every topic
// on how tightly it pins down a search space, then let the caller weight (or
// drop) accordingly. A tiny model pass beats a keyword blacklist here — tried
// both, and keyword rules kept killing good topics like "ceramic glaze science"
// purely for containing the word "science".
const RATE_SYSTEM_PROMPT = `/no_think
You rate YouTube search topics on DOMAIN ANCHORING.

Ask one question about each topic: if I showed you ONLY this phrase, with no context, how many different industries or fields could it belong to?

A = ONE field, and it names a specific process, object, or scene inside it. Typing it into YouTube returns focused, expert content. ("trichome degradation", "raku kiln reduction", "one man sawmill")
B = ONE field, but a huge one. A real subject, just broad. ("chemical reactions", "plant health", "fermentation")
C = ANY field. A floating abstraction, a corporate/academic process word, or a wellness-slop category. Typing it into YouTube returns generic algorithmic filler. ("hazard analysis", "validation studies", "research methodology", "self care", "long term aging")

Rate EVERY topic you are given. Output ONLY the raw JSON object {"ratings":[{"t":"topic","tier":"A"}]}. No markdown, no commentary.`;

export type TopicTier = "A" | "B" | "C";
export interface RatedTopic {
  topic: string;
  tier: TopicTier;
  weight: number;
}

// Tier -> starting weight in the client's topic pool. Tier C is not returned at
// all. Tier B is deliberately kept, just outranked: broad topics like "chemical
// reactions" are worth watching, they simply must not crowd out the specific
// ones.
const TIER_WEIGHT: Record<TopicTier, number> = { A: 8, B: 4, C: 0 };
const RATE_BATCH_SIZE = 25;

/** Grade topics by domain-anchoring. Unrated topics fall back to tier B. */
export async function rateTopics(
  topics: string[],
  modelHint?: string,
  providerHint?: string
): Promise<RatedTopic[]> {
  if (topics.length === 0) return [];
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  const rateBatch = async (chunk: string[]): Promise<Record<string, TopicTier>> => {
    try {
      const data = await callPrismAgent(
        model,
        provider,
        [
          { role: "system", content: RATE_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(chunk) },
        ],
        0.1, // grading, not brainstorming — keep it deterministic
      );
      const text = data?.text || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return {};
      const parsed = JSON.parse(match[0]);
      const out: Record<string, TopicTier> = {};
      for (const r of parsed?.ratings || []) {
        const t = typeof r?.t === "string" ? r.t.trim().toLowerCase() : "";
        if (t && (r.tier === "A" || r.tier === "B" || r.tier === "C")) {
          out[t] = r.tier;
        }
      }
      return out;
    } catch (err: any) {
      logger.warn(`[WallgardenService] Topic rating batch failed: ${err.message}`);
      return {};
    }
  };

  const chunks: string[][] = [];
  for (let i = 0; i < topics.length; i += RATE_BATCH_SIZE) {
    chunks.push(topics.slice(i, i + RATE_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map(rateBatch));
  const ratings: Record<string, TopicTier> = Object.assign({}, ...results);

  // A topic the rater skipped is treated as B: keep it, but never let an
  // unrated topic outrank one that actually earned an A.
  const rated = topics.map(t => {
    const tier: TopicTier = ratings[t.toLowerCase()] || "B";
    return { topic: t, tier, weight: TIER_WEIGHT[tier] };
  });
  const dropped = rated.filter(r => r.tier === "C").length;
  logger.info(
    `[WallgardenService] Rated ${topics.length} topics: ` +
    `${rated.filter(r => r.tier === "A").length}A ` +
    `${rated.filter(r => r.tier === "B").length}B ${dropped}C(dropped)`
  );
  return rated.filter(r => r.tier !== "C");
}

export async function generateSimilarTopics(ctx: SimilarContext): Promise<string[]> {
  const { model, provider } = await resolveProviderAndModel(ctx.model, ctx.provider);

  const liked = ctx.interests.slice(0, 15).join(", ");
  const disliked = ctx.disliked.slice(0, 10).join(", ");
  const likedVideos = (ctx.likedVideos || []).slice(-15).join("; ");
  const watchlist = (ctx.watchlist || []).slice(-15).join("; ");
  const recentUsed = ctx.recentUsed.slice(-20).join(", ");
  const burnedList = ctx.burnedQueries.slice(-30).join(", ");
  const numTopics = ctx.numTopics || 10;

  const userMessage = `Search query: "${ctx.query}"
My interest topics: [${liked}]
Videos I actually liked (strongest signal): [${likedVideos}]
Videos I saved to watch later (strong signal): [${watchlist}]
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

      const temperature = Math.max(0.4, 0.9 - attempt * 0.25);
      const data = await callPrismAgent(
        model,
        provider,
        [
          { role: "system", content: SIMILAR_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
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
