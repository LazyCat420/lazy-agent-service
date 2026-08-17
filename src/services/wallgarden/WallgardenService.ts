import logger from "../../logger.js";
import { getInstancesByType } from "../../providers/instance-registry.js";
import type { InstanceEntry } from "../../types/ProviderTypes.js";
import { prismAttributionHeaders } from "../../utils/PrismAttribution.js";

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
// Shared across brainstorm/extract so the quality bar can't drift apart.
const ANCHOR_TEST_BLOCK = `THE ANCHOR TEST — apply to EVERY topic before you emit it:
Strip away all context and look at the phrase alone. Ask: "how many different industries could this phrase belong to?"
- ONE field, naming a specific process/object/scene inside it -> KEEP. ("trichome degradation", "raku kiln reduction", "one man sawmill")
- ONE field but enormous -> keep at most a few. ("chemical reactions", "plant health")
- ANY field — a floating abstraction that could be aviation, finance, or baking -> DELETE IT. It returns algorithmic slop on YouTube.

Floating abstractions are the #1 failure. They look smart and are worthless. Banned shapes:
- "<abstract noun> analysis/studies/methods/techniques/systems/protocols/principles/management/theory/development/optimization/control/science"
  e.g. "hazard analysis", "validation studies", "research methodology", "product development", "recovery protocols", "quality control", "thermal processing science", "material degradation studies"
- Wellness slop: "self care", "slow living", "chakra balancing", "mindfulness practices", "healing energy"
- Vague temporals: "long term aging", "environmental stressors"
- Umbrella filler words — NEVER emit a topic containing: "content", "videos", "guide", "tips", "hacks", "ideas", "basics", "101", "compilation".
A topic must name a THING — an object, an organism, a named process, a place, a scene, a technique with a practitioner. NEVER merely the ACT OF STUDYING a thing.`;

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

${ANCHOR_TEST_BLOCK}

Your LATERAL and WILDCARD leaps must stay recognisably the same PERSON's taste. A leap that lands in a different personality (a cannabis grower does not become a wellness influencer) is a failed leap, not a bold one.

HARD RULES:
- NEVER suggest: individual people, character names, episode titles, cast members, or channel names.
- NEVER suggest anything in the disliked, recently-used, or failed-query lists, nor trivial rewordings of the user's existing interests.
- NEVER suggest single generic words ("music", "gaming", "history") — too broad returns algorithmic slop.
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Output format: ONLY the raw JSON object {"topics": ["topic one", "topic two", ...]}. No markdown, no commentary, no explanations.`;

const EXTRACT_SYSTEM_PROMPT = `/no_think
You label videos a user LIKED on YouTube. For each video you receive an id, its title, and its channel. Name 1-3 specific niche topics the video actually belongs to — the YouTube subculture, scene, or format a fan would type into search to find more videos exactly like it.

This is extraction, not brainstorming: name what IS there, grounded in the title. Use the channel name as context for inferring the niche, never as a topic itself.

${ANCHOR_TEST_BLOCK}

HARD RULES:
- NEVER emit: individual people, character names, episode titles, or channel names.
- NEVER emit single generic words ("music", "gaming", "history").
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Emit topics for EVERY video you are given, keyed by its id.
- Output format: ONLY the raw JSON object {"extractions":[{"id":"<video id>","topics":["topic one","topic two"]}]}. No markdown, no commentary.`;

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
  tasteProfile?: string;  // LLM-written summary of the whole like history
  // Liked videos grouped into taste clusters; when present, each brainstorm
  // batch expands a DIFFERENT cluster instead of one blended context.
  likedClusters?: { name?: string; videos: string[] }[];
  // Burned/failed topics rendered as negative few-shots (avoid the SHAPE).
  failedExamples?: string[];
  numTopics?: number;
  model?: string;
  provider?: string;
}

export interface SimilarContext extends BrainstormContext {
  query: string;
}

export interface LikedVideoInput {
  id: string;           // youtube video id — used to map results back
  title: string;
  channel?: string;
  durationSecs?: number;
  ageDays?: number;
}

export interface VideoExtraction {
  id: string;
  topics: RatedTopic[];
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

/** Extract topics from a prism /chat response */
export function extractTopicsFromResponse(data: any): string[] {
  // The /chat response is { text, thinking, provider, model, usage, ... }
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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// Backoff before retry attempt N (attempt index 0 → first retry, then capped).
const RETRY_BACKOFF_MS = [1_000, 4_000];
const retryDelay = (attempt: number) =>
  RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];

/** Call prism /chat endpoint (non-streaming, no agent persona, no tools).
 *
 * Deliberately NOT /agent: that endpoint defaults to the full CODING persona
 * and attaches every tool schema (~106K tokens), which blows the local vLLM
 * context window and makes prism skip the model call entirely — returning an
 * empty 200. /chat is the plain server-to-server completion path. */
async function callPrismChat(
  model: string,
  provider: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number = 0.1,
  maxTokens: number = 4000,
): Promise<any> {
  const url = `${PRISM_URL}/chat?stream=false`;
  const body = {
    model,
    provider,
    messages,
    maxTokens, // camelCase — /chat silently drops snake_case max_tokens
    temperature,
    thinkingEnabled: false,
    skipConversation: true, // don't persist a conversation doc per call
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Prism attributes requests by header only — without these the call is
      // filed under its catch-all "default"/"anonymous" project.
      ...prismAttributionHeaders("youtube-wallgarden"),
    },
    body: JSON.stringify(body),
    // Kept below nginx's 110s and the browser's 120s so each layer sees a
    // real error from the layer below instead of racing its own timer.
    signal: AbortSignal.timeout(100_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Prism /chat returned ${resp.status}: ${errText.substring(0, 300)}`);
  }

  const data: any = await resp.json();
  // Empty text is a gateway/provider failure, never valid model output —
  // distinct from "the model answered but we couldn't parse topics".
  if (!data || typeof data.text !== "string" || !data.text.trim()) {
    throw new Error(
      `Prism /chat returned empty text (provider=${data?.provider ?? provider}, ` +
      `model=${data?.model ?? model}, usage=${JSON.stringify(data?.usage ?? null)})`
    );
  }
  return data;
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

  const clusters = (ctx.likedClusters || []).filter(c => c && Array.isArray(c.videos) && c.videos.length > 0);
  const failedExamples = (ctx.failedExamples || []).slice(-10).join(", ");

  const buildMessage = (n: number, batchIndex: number = 0) => {
    // When taste clusters are provided, each batch expands a DIFFERENT corner
    // of the user's taste instead of word-associating on one blended blob.
    const cluster = clusters.length > 0 ? clusters[batchIndex % clusters.length] : null;
    const likedLine = cluster
      ? cluster.videos.slice(0, 10).join("; ")
      : likedVideos;
    const clusterInstruction = cluster
      ? `\nTHIS BATCH: branch out from this specific cluster of my liked videos${cluster.name ? ` ("${cluster.name}")` : ""}. Ignore my other clusters for this batch — go deep and lateral from THIS scene only.`
      : "";
    const profileLine = ctx.tasteProfile
      ? `WHO I AM AS A VIEWER: ${ctx.tasteProfile}\n\n`
      : "";
    const failedLine = failedExamples
      ? `\nTopics that FAILED for this user — study their SHAPE and avoid producing anything of the same shape, not just the same words: [${failedExamples}]`
      : "";

    return `${profileLine}My interest topics: [${liked}]
Videos I actually liked (strongest signal): [${likedLine}]
Videos I saved to watch later (strong signal): [${watchlist}]
Recent searches: [${searches}]
Disliked: [${disliked}]
Recently used (avoid these): [${recentUsed}]
Failed queries (don't reuse these exact phrases, they returned bad results): [${burnedList}]${failedLine}${clusterInstruction}

Suggest ${n} new topics.`;
  };

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
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: BRAINSTORM_SYSTEM_PROMPT },
            { role: "user", content: buildMessage(size, batchIndex) },
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
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
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

export interface RateResult {
  rated: RatedTopic[];
  /** Batches whose rating call failed outright — their topics fell back to
   * tier B. failedBatches === totalBatches means the rater never ran at all. */
  failedBatches: number;
  totalBatches: number;
}

/** Grade topics by domain-anchoring. Unrated topics fall back to tier B. */
export async function rateTopics(
  topics: string[],
  modelHint?: string,
  providerHint?: string
): Promise<RateResult> {
  if (topics.length === 0) return { rated: [], failedBatches: 0, totalBatches: 0 };
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  // null = this batch's LLM call failed (as opposed to rated-but-skipped topics)
  const rateBatch = async (chunk: string[]): Promise<Record<string, TopicTier> | null> => {
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callPrismChat(
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
        if (!match) throw new Error("No JSON object in rating response");
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
        logger.warn(`[WallgardenService] Topic rating batch attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return null;
  };

  const chunks: string[][] = [];
  for (let i = 0; i < topics.length; i += RATE_BATCH_SIZE) {
    chunks.push(topics.slice(i, i + RATE_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map(rateBatch));
  const failedBatches = results.filter(r => r === null).length;
  if (failedBatches > 0) {
    logger.error(
      `[WallgardenService] Topic rating degraded: ${failedBatches}/${chunks.length} batches failed — their topics fall back to tier B`
    );
  }
  const ratings: Record<string, TopicTier> = Object.assign({}, ...results.filter(Boolean));

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
  return {
    rated: rated.filter(r => r.tier !== "C"),
    failedBatches,
    totalBatches: chunks.length,
  };
}

// ── Liked-video topic extraction ────────────────────────────
// Turns liked videos into the specific niches they belong to. Grounded in the
// given titles (temperature low), so unlike the brainstormer this cannot
// drift: it names what the user demonstrably already loves.

// 8 videos × ≤3 topics = ≤24 topics per call, under the measured 25-topic
// output ceiling (50+ in one call yields ZERO usable output — see
// BRAINSTORM_BATCH_SIZE above).
const EXTRACT_BATCH_SIZE = 8;

/** Parse {"extractions":[{"id","topics":[...]}]} defensively. Exported for tests. */
export function extractVideoExtractionsFromResponse(data: any): { id: string; topics: string[] }[] {
  const text = data?.text || "";
  const clean = (arr: any[]): { id: string; topics: string[] }[] =>
    arr
      .map((e: any) => ({
        id: typeof e?.id === "string" ? e.id.trim() : "",
        topics: Array.isArray(e?.topics)
          ? e.topics
              .map((t: any) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
              .filter((t: string) => t.length > 1 && t.length < 60)
          : [],
      }))
      .filter(e => e.id && e.topics.length > 0);

  // Direct parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.extractions)) return clean(parsed.extractions);
    if (Array.isArray(parsed)) return clean(parsed);
  } catch { /* fall through */ }

  // Outer-object regex parse (handles markdown fences / prose around it)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed?.extractions)) return clean(parsed.extractions);
    } catch { /* fall through */ }
  }

  // Truncation salvage: scrape complete {"id":...,"topics":[...]} objects out
  // of a reply that got cut mid-array.
  const salvaged: { id: string; topics: string[] }[] = [];
  const objRe = /\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"topics"\s*:\s*(\[[^\]]*\])\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    try {
      const topics = JSON.parse(m[2]);
      if (Array.isArray(topics)) {
        salvaged.push({ id: m[1], topics });
      }
    } catch { /* skip this object */ }
  }
  if (salvaged.length > 0) {
    logger.warn(`[WallgardenService] Extraction response malformed; salvaged ${salvaged.length} entries`);
    return clean(salvaged);
  }

  logger.warn("[WallgardenService] Could not extract video extractions from response text");
  return [];
}

export async function extractVideoTopics(
  videos: LikedVideoInput[],
  modelHint?: string,
  providerHint?: string
): Promise<VideoExtraction[]> {
  if (videos.length === 0) return [];
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  const runBatch = async (chunk: LikedVideoInput[], batchIndex: number): Promise<{ id: string; topics: string[] }[]> => {
    const lines = chunk.map(v => {
      const bits = [`id: ${v.id}`, `title: ${v.title}`];
      if (v.channel) bits.push(`channel: ${v.channel}`);
      if (typeof v.durationSecs === "number") bits.push(`duration: ${Math.round(v.durationSecs / 60)}min`);
      if (typeof v.ageDays === "number") bits.push(`age: ${Math.round(v.ageDays)}d`);
      return "- " + bits.join(" | ");
    });
    const userMessage = `Videos I liked:\n${lines.join("\n")}\n\nName 1-3 niche topics per video.`;

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Extraction is grounded — start cool and get colder on retries.
        const temperature = Math.max(0.1, 0.3 - attempt * 0.1);
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: EXTRACT_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature,
        );
        const extractions = extractVideoExtractionsFromResponse(data);
        if (extractions.length > 0) return extractions;
        throw new Error("No extractions parsed from response");
      } catch (err: any) {
        logger.warn(
          `[WallgardenService] Extract batch ${batchIndex + 1} attempt ${attempt + 1} failed: ${err.message}`
        );
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return [];
  };

  const chunks: LikedVideoInput[][] = [];
  for (let i = 0; i < videos.length; i += EXTRACT_BATCH_SIZE) {
    chunks.push(videos.slice(i, i + EXTRACT_BATCH_SIZE));
  }
  const settled = await Promise.all(chunks.map((c, i) => runBatch(c, i)));
  const flat = settled.flat();

  // One rating pass over the union, then map tiers back per video. C-tier
  // topics are dropped here exactly like the brainstorm path.
  const uniqueTopics = Array.from(new Set(flat.flatMap(e => e.topics)));
  const { rated, failedBatches } = await rateTopics(uniqueTopics, model, provider);
  if (failedBatches > 0) {
    logger.error(
      `[WallgardenService] Extraction rating pass degraded (${failedBatches} failed batches)`
    );
  }
  const ratedByTopic = new Map(rated.map(r => [r.topic.toLowerCase(), r]));

  const out: VideoExtraction[] = [];
  for (const e of flat) {
    const topics = e.topics
      .map(t => ratedByTopic.get(t.toLowerCase()))
      .filter((r): r is RatedTopic => Boolean(r));
    if (topics.length > 0) out.push({ id: e.id, topics });
  }
  logger.info(
    `[WallgardenService] Extracted topics for ${out.length}/${videos.length} liked videos ` +
    `(${uniqueTopics.length} unique topics, ${rated.length} survived rating) via ${provider}/${model}`
  );
  return out;
}

// ── Taste profile ───────────────────────────────────────────
// One call over the user's ENTIRE like history (input-side scaling is safe —
// the 25-item ceiling is an output-array failure mode). The resulting
// paragraph is cached client-side and prepended to brainstorm/similar.
const TASTE_SYSTEM_PROMPT = `/no_think
You are given every video a person has liked on YouTube ("title (channel)" per line), plus their current interest topics. Write WHO THIS PERSON IS as a viewer.

Rules for the profile:
- At most 120 words. Concrete, not horoscope-vague: name their recurring obsessions, preferred formats and depth (long-form process video vs quick explainers), aesthetics and eras they gravitate to, and what visibly hooks them.
- Written in second person plural-free prose ("Watches ...", "Drawn to ..."), no preamble.

Then name their distinct taste clusters (2-6). Each cluster: a short name a YouTube fan would recognise, plus the liked titles that are evidence for it.

Output ONLY the raw JSON object:
{"profile":"...","clusters":[{"name":"...","evidence":["title one","title two"]}]}
No markdown, no commentary.`;

export interface TasteProfile {
  profile: string;
  clusters: { name: string; evidence: string[] }[];
}

/** Parse the taste-profile response defensively. Exported for tests. */
export function extractProfileFromResponse(data: any): TasteProfile | null {
  const text = data?.text || "";
  const tryParse = (s: string): TasteProfile | null => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed.profile === "string" && parsed.profile.trim()) {
        return {
          profile: parsed.profile.trim(),
          clusters: Array.isArray(parsed.clusters)
            ? parsed.clusters
                .map((c: any) => ({
                  name: typeof c?.name === "string" ? c.name.trim() : "",
                  evidence: Array.isArray(c?.evidence)
                    ? c.evidence.filter((e: any) => typeof e === "string")
                    : [],
                }))
                .filter((c: any) => c.name)
            : [],
        };
      }
    } catch { /* fall through */ }
    return null;
  };

  const direct = tryParse(text);
  if (direct) return direct;
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const fromMatch = tryParse(objMatch[0]);
    if (fromMatch) return fromMatch;
  }
  // Salvage just the profile string from a truncated reply — the clusters are
  // nice-to-have, the paragraph is the payload.
  const profMatch = text.match(/"profile"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (profMatch) {
    try {
      const profile = JSON.parse(`"${profMatch[1]}"`);
      if (profile.trim()) {
        logger.warn("[WallgardenService] Taste profile response malformed; salvaged profile text only");
        return { profile: profile.trim(), clusters: [] };
      }
    } catch { /* give up */ }
  }
  logger.warn("[WallgardenService] Could not extract taste profile from response text");
  return null;
}

export async function generateTasteProfile(
  videos: string[],
  interests: string[] = [],
  modelHint?: string,
  providerHint?: string
): Promise<TasteProfile> {
  if (videos.length === 0) throw new Error("No liked videos to profile");
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  const userMessage = `Liked videos (${videos.length}):\n${videos.map(v => `- ${v}`).join("\n")}\n\nCurrent interest topics: [${interests.slice(0, 20).join(", ")}]`;

  const MAX_RETRIES = 2;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await callPrismChat(
        model,
        provider,
        [
          { role: "system", content: TASTE_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        0.3,
        1200,
      );
      const profile = extractProfileFromResponse(data);
      if (profile) {
        logger.info(
          `[WallgardenService] Taste profile generated from ${videos.length} likes ` +
          `(${profile.clusters.length} clusters) via ${provider}/${model}`
        );
        return profile;
      }
      throw new Error("No profile parsed from response");
    } catch (err: any) {
      lastError = err;
      logger.warn(`[WallgardenService] Taste profile attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
    }
  }
  throw lastError || new Error("Taste profile generation failed");
}

// ── Grounding gate ──────────────────────────────────────────
// Judges candidate topics by the ACTUAL YouTube results they return —
// evidence instead of guessing. Fail-open by design: an item the judge
// skips defaults to MIXED, because grounding must never brick the feed.
const JUDGE_SYSTEM_PROMPT = `/no_think
You judge YouTube search topics by their ACTUAL top search results. For each topic you receive the titles (and channels) currently returned for it.

Verdicts:
- REAL = the results are a coherent niche: enthusiast/practitioner channels, specific recurring scene vocabulary, videos a fan of this topic would genuinely want. The topic names a real YouTube subculture.
- MIXED = some real signal amid filler; the topic works but isn't sharp.
- SLOP = generic listicles, clickbait compilations, corporate explainers, or results unrelated to each other — the topic is a floating phrase the algorithm fills with junk.

Judge EVERY topic you are given. Output ONLY the raw JSON object {"verdicts":[{"t":"topic","verdict":"REAL"}]}. No markdown, no commentary.`;

export type GroundingVerdict = "REAL" | "MIXED" | "SLOP";
export interface GroundingItem {
  topic: string;
  titles: string[];
  channels?: string[];
}
export interface JudgedTopic {
  topic: string;
  verdict: GroundingVerdict;
}

const JUDGE_BATCH_SIZE = 10;

export interface JudgeResult {
  judged: JudgedTopic[];
  /** Batches whose judge call failed outright — their topics fell back to
   * MIXED (fail-open by design; grounding must never brick the feed). */
  failedBatches: number;
  totalBatches: number;
}

export async function judgeTopicGrounding(
  items: GroundingItem[],
  modelHint?: string,
  providerHint?: string
): Promise<JudgeResult> {
  if (items.length === 0) return { judged: [], failedBatches: 0, totalBatches: 0 };
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  // null = this batch's LLM call failed (vs. a verdict the judge skipped)
  const judgeBatch = async (chunk: GroundingItem[]): Promise<Record<string, GroundingVerdict> | null> => {
    const lines = chunk.map(i => {
      const titles = i.titles.slice(0, 8).map(t => `"${t}"`).join(", ");
      const channels = (i.channels || []).slice(0, 8).filter(Boolean);
      const chanPart = channels.length ? ` | channels: ${channels.join(", ")}` : "";
      return `- topic: "${i.topic}" | results: [${titles}]${chanPart}`;
    });
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: lines.join("\n") },
          ],
          0.1, // grading, not brainstorming
        );
        const text = data?.text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object in judge response");
        const parsed = JSON.parse(match[0]);
        const out: Record<string, GroundingVerdict> = {};
        for (const v of parsed?.verdicts || []) {
          const t = typeof v?.t === "string" ? v.t.trim().toLowerCase() : "";
          if (t && (v.verdict === "REAL" || v.verdict === "MIXED" || v.verdict === "SLOP")) {
            out[t] = v.verdict;
          }
        }
        return out;
      } catch (err: any) {
        logger.warn(`[WallgardenService] Grounding judge batch attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return null;
  };

  const chunks: GroundingItem[][] = [];
  for (let i = 0; i < items.length; i += JUDGE_BATCH_SIZE) {
    chunks.push(items.slice(i, i + JUDGE_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map(judgeBatch));
  const failedBatches = results.filter(r => r === null).length;
  if (failedBatches > 0) {
    logger.error(
      `[WallgardenService] Grounding judge degraded: ${failedBatches}/${chunks.length} batches failed — their topics default to MIXED`
    );
  }
  const verdicts: Record<string, GroundingVerdict> = Object.assign({}, ...results.filter(Boolean));

  const judged = items.map(i => ({
    topic: i.topic,
    verdict: verdicts[i.topic.toLowerCase()] || ("MIXED" as GroundingVerdict),
  }));
  logger.info(
    `[WallgardenService] Judged ${judged.length} topics: ` +
    `${judged.filter(j => j.verdict === "REAL").length} REAL, ` +
    `${judged.filter(j => j.verdict === "MIXED").length} MIXED, ` +
    `${judged.filter(j => j.verdict === "SLOP").length} SLOP`
  );
  return { judged, failedBatches, totalBatches: chunks.length };
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

  const profileLine = ctx.tasteProfile ? `WHO I AM AS A VIEWER: ${ctx.tasteProfile}\n\n` : "";
  const userMessage = `${profileLine}Search query: "${ctx.query}"
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
      const data = await callPrismChat(
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
      if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
    }
  }

  throw lastError || new Error("Similar topic generation failed after all retries");
}

// ── Candidate Classification Gate ───────────────────────────
// Classifies candidate videos against a specific topic intent to filter
// out novelty builds (e.g. LEGO/Minecraft fish tanks), off-topic crossover,
// and low-quality results before they enter the feed ranking.
const CLASSIFY_CANDIDATES_SYSTEM_PROMPT = `/no_think
You are the semantic relevance gate for a curated YouTube feed.
Given a target TOPIC, its intended DOMAIN/INTENT, and any EXCLUSIONS, evaluate whether candidate video titles/channels are genuinely on-topic or whether they are novelty/crossover bait, off-topic, or low-quality.

Classifications:
- ON_TOPIC: Genuinely represents the intended craft, enthusiast domain, practitioner scene, or informational subject. (e.g. for "fish tanks" [aquariums]: aquascaping guides, planted tank filtration, freshwater fish care).
- ADJACENT: Closely related enthusiast topic from a neighboring scene that an enthusiast would still welcome (e.g. for "fish tanks": aquatic plant propagation, pond building).
- NOVELTY: Novelty builds, toy/crossover content, viral spectacle, prank/experiment stunts, or gimmick projects that hijack the topic words without belonging to the actual hobby/niche (e.g. for "fish tanks": "I built a fish tank entirely from LEGO", "Minecraft working aquarium", "giant gummy fish tank challenge").
- OFF_TOPIC: Unrelated subject, completely different domain (e.g. "military tank battle", "synthesis" meaning corporate mergers when intended music production).

For each candidate video, return:
- id: video id
- classification: "ON_TOPIC" | "ADJACENT" | "NOVELTY" | "OFF_TOPIC"
- reason: brief 3-8 word explanation

Output ONLY the raw JSON object:
{"classifications":[{"id":"<id>","classification":"ON_TOPIC","reason":"aquascaping tutorial"}]}
No markdown, no commentary.`;

export type CandidateClassification = "ON_TOPIC" | "ADJACENT" | "NOVELTY" | "OFF_TOPIC";

export interface CandidateItem {
  id: string;
  title: string;
  channel?: string;
  durationSecs?: number;
}

export interface CandidateClassificationResult {
  id: string;
  classification: CandidateClassification;
  reason?: string;
}

export interface ClassifyCandidatesInput {
  topic: string;
  intent?: string;
  includeFacets?: string[];
  excludeFacets?: string[];
  candidates: CandidateItem[];
  model?: string;
  provider?: string;
}

/** Parse candidate classifications defensively from model response */
export function extractCandidateClassificationsFromResponse(
  data: any
): CandidateClassificationResult[] {
  const text = data?.text || "";
  const clean = (arr: any[]): CandidateClassificationResult[] =>
    arr
      .map((c: any) => {
        const id = typeof c?.id === "string" ? c.id.trim() : "";
        const rawClass = typeof c?.classification === "string" ? c.classification.toUpperCase().trim() : "";
        const classification: CandidateClassification =
          rawClass === "ON_TOPIC" || rawClass === "ADJACENT" || rawClass === "NOVELTY" || rawClass === "OFF_TOPIC"
            ? rawClass
            : "ADJACENT";
        const reason = typeof c?.reason === "string" ? c.reason.trim() : undefined;
        return { id, classification, reason };
      })
      .filter(c => c.id);

  // Direct parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.classifications)) return clean(parsed.classifications);
    if (Array.isArray(parsed)) return clean(parsed);
  } catch { /* fall through */ }

  // Outer-object regex match
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed?.classifications)) return clean(parsed.classifications);
    } catch { /* fall through */ }
  }

  // Truncation salvage
  const salvaged: CandidateClassificationResult[] = [];
  const objRe = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"classification"\s*:\s*"([^"]+)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    const id = m[1];
    const rawClass = m[2].toUpperCase();
    const classification: CandidateClassification =
      rawClass === "ON_TOPIC" || rawClass === "ADJACENT" || rawClass === "NOVELTY" || rawClass === "OFF_TOPIC"
        ? rawClass
        : "ADJACENT";
    salvaged.push({ id, classification, reason: m[3] || undefined });
  }

  if (salvaged.length > 0) {
    logger.warn(`[WallgardenService] Classify candidates response malformed; salvaged ${salvaged.length} entries`);
    return clean(salvaged);
  }

  logger.warn("[WallgardenService] Could not extract classifications from response text");
  return [];
}

const CLASSIFY_BATCH_SIZE = 15;

export async function classifyCandidateVideos(
  input: ClassifyCandidatesInput
): Promise<{ classifications: CandidateClassificationResult[]; failed: boolean }> {
  if (!input.candidates || input.candidates.length === 0) {
    return { classifications: [], failed: false };
  }

  const { model, provider } = await resolveProviderAndModel(input.model, input.provider);

  const intentPart = input.intent ? `\nTarget Domain/Intent: ${input.intent}` : "";
  const incPart = input.includeFacets && input.includeFacets.length ? `\nInclude Facets: [${input.includeFacets.join(", ")}]` : "";
  const excPart = input.excludeFacets && input.excludeFacets.length ? `\nExclude / Novelty Patterns: [${input.excludeFacets.join(", ")}]` : "";

  const runBatch = async (
    chunk: CandidateItem[],
    batchIndex: number
  ): Promise<CandidateClassificationResult[]> => {
    const lines = chunk.map(c => {
      const parts = [`id: ${c.id}`, `title: "${c.title}"`];
      if (c.channel) parts.push(`channel: "${c.channel}"`);
      if (typeof c.durationSecs === "number") parts.push(`duration: ${Math.round(c.durationSecs / 60)}min`);
      return "- " + parts.join(" | ");
    });

    const userMessage = `Target Topic: "${input.topic}"${intentPart}${incPart}${excPart}

Candidate Videos to classify:
${lines.join("\n")}

Classify each video as ON_TOPIC, ADJACENT, NOVELTY, or OFF_TOPIC.`;

    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: CLASSIFY_CANDIDATES_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          0.1, // deterministic grading
          1200
        );

        const results = extractCandidateClassificationsFromResponse(data);
        if (results.length > 0) return results;
        throw new Error("No classifications parsed from response");
      } catch (err: any) {
        logger.warn(
          `[WallgardenService] Classify candidates batch ${batchIndex + 1} attempt ${attempt + 1} failed: ${err.message}`
        );
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return [];
  };

  const chunks: CandidateItem[][] = [];
  for (let i = 0; i < input.candidates.length; i += CLASSIFY_BATCH_SIZE) {
    chunks.push(input.candidates.slice(i, i + CLASSIFY_BATCH_SIZE));
  }

  const settled = await Promise.all(chunks.map((c, i) => runBatch(c, i)));
  const flat = settled.flat();
  const failed = flat.length === 0 && input.candidates.length > 0;

  // Map results back by ID; candidates skipped or unclassified fall back to ADJACENT
  const byId = new Map(flat.map(r => [r.id, r]));
  const fullResults = input.candidates.map(c => byId.get(c.id) || {
    id: c.id,
    classification: "ADJACENT" as CandidateClassification,
    reason: "unclassified",
  });

  logger.info(
    `[WallgardenService] Classified ${fullResults.length} candidates for "${input.topic}": ` +
    `${fullResults.filter(r => r.classification === "ON_TOPIC").length} ON_TOPIC, ` +
    `${fullResults.filter(r => r.classification === "ADJACENT").length} ADJACENT, ` +
    `${fullResults.filter(r => r.classification === "NOVELTY").length} NOVELTY, ` +
    `${fullResults.filter(r => r.classification === "OFF_TOPIC").length} OFF_TOPIC`
  );

  return { classifications: fullResults, failed };
}

