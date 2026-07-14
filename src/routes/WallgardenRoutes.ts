import { Router, type Request, type Response } from "express";
import logger from "../logger.js";
import {
  discoverModels,
  brainstormTopics,
  generateSimilarTopics,
  rateTopics,
  type BrainstormContext,
  type SimilarContext,
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
