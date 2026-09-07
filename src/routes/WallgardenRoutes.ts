import { Router, type Request, type Response } from "express";
import logger from "../logger.js";
import {
  discoverModels,
  brainstormTopics,
  generateSimilarTopics,
  rateTopics,
  extractVideoTopics,
  generateTasteProfile,
  judgeTopicGrounding,
  classifyCandidateVideos,
  type BrainstormContext,
  type SimilarContext,
  type LikedVideoInput,
  type GroundingItem,
  type ClassifyCandidatesInput,
  JETSON_PROVIDER,
} from "../services/wallgarden/WallgardenService.js";

const router = Router();

// ── GET /wallgarden/models ──────────────────────────────────
// Discovers what model is loaded on the Jetson. Only the Jetson is returned:
// wallgarden is pinned to it, so advertising any other box would put a choice
// in the dashboard dropdown that the backend refuses to honour.
router.get("/models", async (_req: Request, res: Response) => {
  try {
    const boxes = (await discoverModels()).filter(b => b.id === JETSON_PROVIDER);
    res.json({ boxes });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /models error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/brainstorm ─────────────────────────────
// Takes user interests/context, calls vLLM via prism /chat,
// returns a clean topic array
router.post("/brainstorm", async (req: Request, res: Response) => {
  try {
    const {
      interests = [],
      disliked = [],
      recentUsed = [],
      burnedQueries = [],
      searches = [],
      likedVideos = [],
      watchlist = [],
      tasteProfile,
      likedClusters,
      failedExamples,
      topicOutcomes,
      promptVariant,
      rateFit,
      numTopics,
      model,
      provider,
    } = req.body as BrainstormContext;

    if (!interests || interests.length === 0) {
      return res.status(400).json({ error: "interests array is required and must be non-empty" });
    }

    const raw = await brainstormTopics({
      interests,
      disliked,
      recentUsed,
      burnedQueries,
      searches,
      likedVideos,
      watchlist,
      tasteProfile,
      likedClusters,
      failedExamples,
      topicOutcomes,
      // Forwarded (it used to die here) so the arm shows in the service log.
      promptVariant,
      numTopics,
      model,
      provider,
    });

    // Grade for domain-anchoring AND fit for this viewer, drop the floating
    // abstractions and the other-person topics, and hand the client a
    // starting weight per topic. `rateFit: false` is the free-baseline arm.
    const withFit = rateFit !== false;
    const roles = new Map(raw.map(t => [t.topic.toLowerCase(), t.role] as const));
    const byTopic = new Map(raw.map(t => [t.topic.toLowerCase(), t] as const));
    const { rated, failedBatches, totalBatches } = await rateTopics(
      raw.map(t => t.topic),
      model,
      provider,
      withFit
        ? { taste: { tasteProfile, likedTitles: likedVideos, interests }, roles }
        : { roles },
    );
    const enriched = rated.map(r => {
      const src = byTopic.get(r.topic.toLowerCase());
      return { ...r, role: r.role || src?.role, cluster: src?.cluster };
    });

    res.json({
      // `topics` stays a plain string[] so older clients keep working.
      topics: enriched.map(r => r.topic),
      rated: enriched,
      count: enriched.length,
      generated: raw.length,
      degraded: failedBatches > 0,
      ratingFailedBatches: failedBatches,
      ratingTotalBatches: totalBatches,
      promptVariant: promptVariant || null,
      rateFit: withFit,
    });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /brainstorm error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/extract-topics ─────────────────────────
// Takes liked-video records, returns the specific niches each belongs to
// (rated for domain anchoring; C-tier dropped).
router.post("/extract-topics", async (req: Request, res: Response) => {
  try {
    const { videos, model, provider } = req.body as {
      videos?: LikedVideoInput[];
      model?: string;
      provider?: string;
    };

    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: "videos array is required and must be non-empty" });
    }
    if (videos.length > 40) {
      return res.status(400).json({ error: "at most 40 videos per request" });
    }
    const valid = videos.filter(v => v && typeof v.id === "string" && typeof v.title === "string" && v.title.trim());
    if (valid.length === 0) {
      return res.status(400).json({ error: "no valid videos (each needs id + title)" });
    }

    const extractions = await extractVideoTopics(valid, model, provider);
    res.json({ extractions, count: extractions.length });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /extract-topics error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/taste-profile ──────────────────────────
// Summarizes the user's ENTIRE like history into a compact viewer profile.
router.post("/taste-profile", async (req: Request, res: Response) => {
  try {
    const { videos, interests = [], model, provider } = req.body as {
      videos?: string[];
      interests?: string[];
      model?: string;
      provider?: string;
    };
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: "videos array is required and must be non-empty" });
    }
    const clean = videos.filter(v => typeof v === "string" && v.trim()).slice(0, 300);
    const result = await generateTasteProfile(clean, interests, model, provider);
    res.json({ profile: result.profile, clusters: result.clusters, count: clean.length });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /taste-profile error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/judge-topics ───────────────────────────
// Grounding gate: judges candidate topics by their ACTUAL YouTube results.
router.post("/judge-topics", async (req: Request, res: Response) => {
  try {
    const { items, model, provider } = req.body as {
      items?: GroundingItem[];
      model?: string;
      provider?: string;
    };
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required and must be non-empty" });
    }
    const valid = items.filter(i => i && typeof i.topic === "string" && Array.isArray(i.titles));
    if (valid.length === 0) {
      return res.status(400).json({ error: "no valid items (each needs topic + titles[])" });
    }
    const { judged, failedBatches, totalBatches } = await judgeTopicGrounding(valid, model, provider);
    res.json({
      verdicts: judged,
      count: judged.length,
      degraded: failedBatches > 0,
      judgeFailedBatches: failedBatches,
      judgeTotalBatches: totalBatches,
    });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /judge-topics error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/similar ────────────────────────────────
// Takes a video title/query + context, returns similar topics
router.post("/similar", async (req: Request, res: Response) => {
  try {
    const {
      query,
      interests = [],
      disliked = [],
      recentUsed = [],
      burnedQueries = [],
      likedVideos = [],
      watchlist = [],
      tasteProfile,
      failedExamples,
      topicOutcomes,
      seeds,
      rateFit,
      numTopics,
      model,
      provider,
    } = req.body as SimilarContext;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "query string is required" });
    }

    const topics = await generateSimilarTopics({
      query,
      seeds: Array.isArray(seeds) ? seeds.filter(x => typeof x === "string") : undefined,
      interests,
      disliked,
      recentUsed,
      burnedQueries,
      likedVideos,
      watchlist,
      tasteProfile,
      // This route used to drop failedExamples on the floor — the client has
      // always sent it, and it now carries measured-ignored topics.
      failedExamples,
      topicOutcomes,
      numTopics,
      model,
      provider,
    });

    // /similar output used to enter the client's pool ungraded at weight 4.
    // Same rater as brainstorm; these are adjacent to something the user
    // already engaged with, so every one is role "adjacent".
    const withFit = rateFit !== false;
    const roles = new Map(topics.map(t => [t.toLowerCase(), "adjacent" as const]));
    const { rated, failedBatches, totalBatches } = await rateTopics(
      topics,
      model,
      provider,
      withFit ? { taste: { tasteProfile, likedTitles: likedVideos, interests }, roles } : { roles },
    );

    res.json({
      // `topics` keeps the ungraded list so older clients see no change.
      topics,
      count: topics.length,
      rated,
      degraded: failedBatches > 0,
      ratingFailedBatches: failedBatches,
      ratingTotalBatches: totalBatches,
      rateFit: withFit,
    });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /similar error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/classify-candidates ───────────────────
// Classifies candidate videos against topic intent to filter out novelty/off-topic content.
router.post("/classify-candidates", async (req: Request, res: Response) => {
  try {
    const {
      topic,
      intent,
      includeFacets = [],
      excludeFacets = [],
      candidates = [],
      model,
      provider,
    } = req.body as ClassifyCandidatesInput;

    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "topic string is required" });
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: "candidates array is required and must be non-empty" });
    }
    if (candidates.length > 50) {
      return res.status(400).json({ error: "at most 50 candidates per request" });
    }

    const valid = candidates.filter(c => c && typeof c.id === "string" && typeof c.title === "string" && c.title.trim());
    if (valid.length === 0) {
      return res.status(400).json({ error: "no valid candidates (each needs id + title)" });
    }

    const result = await classifyCandidateVideos({
      topic: topic.trim(),
      intent,
      includeFacets,
      excludeFacets,
      candidates: valid,
      model,
      provider,
    });

    res.json({
      classifications: result.classifications,
      count: result.classifications.length,
      failed: result.failed,
    });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /classify-candidates error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
