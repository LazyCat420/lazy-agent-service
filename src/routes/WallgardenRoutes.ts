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
  type BrainstormContext,
  type SimilarContext,
  type LikedVideoInput,
  type GroundingItem,
} from "../services/wallgarden/WallgardenService.js";

const router = Router();

// ── GET /wallgarden/models ──────────────────────────────────
// Discovers what models are loaded on each vLLM box
router.get("/models", async (_req: Request, res: Response) => {
  try {
    const boxes = await discoverModels();
    res.json({ boxes });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /models error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /wallgarden/brainstorm ─────────────────────────────
// Takes user interests/context, calls vLLM via prism /agent,
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
      numTopics,
      model,
      provider,
    });

    // Grade for domain-anchoring, drop the floating abstractions, and hand the
    // client a starting weight per topic so specific topics outrank broad ones
    // in the feed queue and the suggestion chips.
    const rated = await rateTopics(raw, model, provider);

    res.json({
      // `topics` stays a plain string[] so older clients keep working.
      topics: rated.map(r => r.topic),
      rated,
      count: rated.length,
      generated: raw.length,
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
    const verdicts = await judgeTopicGrounding(valid, model, provider);
    res.json({ verdicts, count: verdicts.length });
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
      numTopics,
      model,
      provider,
    } = req.body as SimilarContext;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "query string is required" });
    }

    const topics = await generateSimilarTopics({
      query,
      interests,
      disliked,
      recentUsed,
      burnedQueries,
      likedVideos,
      watchlist,
      tasteProfile,
      numTopics,
      model,
      provider,
    });

    res.json({ topics, count: topics.length });
  } catch (err: any) {
    logger.error(`[WallgardenRoutes] /similar error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
