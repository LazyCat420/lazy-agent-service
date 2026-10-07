import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ProviderError } from "../utils/errors.ts";
import EmbeddingService from "../services/EmbeddingService.ts";
import EmbeddingCorpusService from "../services/EmbeddingCorpusService.ts";

const router = express.Router();

/**
 * POST /embed
 * Body: {
 *   provider?,         // optional — shared harness embedding default
 *   model?,            // optional, falls back to provider default
 *   text?,             // optional — text content
 *   texts?,            // optional — 1–32 strings; returns { embeddings[] } instead
 *   images?,           // optional — array of base64 / data URL strings
 *   audio?,            // optional — base64 / data URL string
 *   video?,            // optional — base64 / data URL string
 *   pdf?,              // optional — base64 / data URL string
 *   taskType?,         // optional — e.g. SEMANTIC_SIMILARITY, RETRIEVAL_DOCUMENT
 *   dimensions?,       // optional — output dimensionality (128–3072)
 * }
 * Response: { embedding, dimensions, provider, model }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        provider: pName,
        model,
        text,
        images,
        audio,
        video,
        pdf,
        taskType,
        dimensions,
        traceId,
      } = req.body;

      // Text batch: one vector per input, in input order, same space as `text`.
      if (req.body.texts !== undefined) {
        if (text || images || audio || video || pdf) {
          throw new ProviderError("server", "Send either texts or a single content input, not both", 400);
        }
        const result = await EmbeddingService.generateMany(req.body.texts, {
          provider: pName,
          model,
          taskType: taskType || req.body.input_type,
          dimensions,
          project: req.project,
          username: req.username,
          clientIp: req.clientIp,
          source: "api",
          endpoint: "/embed",
          traceId: traceId || null,
        });
        res.json(result);
        return;
      }

      // At least one content input is required
      const hasContent =
        text || (images && images.length > 0) || audio || video || pdf;
      if (!hasContent) {
        throw new ProviderError(
          "server",
          "At least one content input is required (text, images, audio, video, or pdf)",
          400,
        );
      }

      // Build content for provider — text-only vs multimodal
      let content: string | Record<string, unknown>[];
      const isMultimodal =
        (images && images.length > 0) || audio || video || pdf;

      if (!isMultimodal && text) {
        content = text;
      } else {
        const parts: Record<string, unknown>[] = [];

        if (text) {
          parts.push({ text });
        }

        const parseDataUrl = (data: string, fallbackMime: string) => {
          if (typeof data === "string" && data.includes(";base64,")) {
            const segments = data.split(";base64,");
            return {
              data: segments[1],
              mimeType: segments[0].replace("data:", ""),
            };
          }
          return { data, mimeType: fallbackMime };
        };

        if (images && images.length > 0) {
          for (const image of images) {
            const { data, mimeType } = parseDataUrl(image, "image/jpeg");
            parts.push({ inlineData: { data, mimeType } });
          }
        }

        if (audio) {
          const { data, mimeType } = parseDataUrl(audio, "audio/mpeg");
          parts.push({ inlineData: { data, mimeType } });
        }

        if (video) {
          const { data, mimeType } = parseDataUrl(video, "video/mp4");
          parts.push({ inlineData: { data, mimeType } });
        }

        if (pdf) {
          const { data, mimeType } = parseDataUrl(pdf, "application/pdf");
          parts.push({ inlineData: { data, mimeType } });
        }

        content = parts;
      }

      const result = await EmbeddingService.generate(content, {
        provider: pName,
        model,
        taskType: taskType || req.body.input_type,
        dimensions,
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
        source: "api",
        endpoint: "/embed",
        traceId: traceId || null,
      });

      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * GET /embed/corpora — every registered corpus: docs, docs not yet in the current
 * embedding space, and the last re-embed pass.
 */
router.get(
  "/corpora",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await EmbeddingCorpusService.status());
  }),
);

/**
 * POST /embed/corpora/run — start a re-embed pass now (it also runs on a schedule).
 * Answers at once; the pass runs in the background.
 */
router.post(
  "/corpora/run",
  asyncHandler(async (_req: Request, res: Response) => {
    EmbeddingCorpusService.runAll().catch(() => undefined);
    res.status(202).json({ started: true });
  }),
);

export default router;
