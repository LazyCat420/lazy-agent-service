import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ProviderError } from "../utils/errors.ts";
import EmbeddingService from "../services/EmbeddingService.ts";
import EmbeddingCorpusService from "../services/EmbeddingCorpusService.ts";

const router = express.Router();

/** POST /embed body. Unknown extras pass through untouched. */
interface EmbedRequestBody {
  provider?: string;
  model?: string;
  text?: string;
  texts?: string[];
  images?: string[];
  audio?: string;
  video?: string;
  pdf?: string;
  taskType?: string;
  input_type?: string;
  dimensions?: number;
  traceId?: string | null;
  [key: string]: unknown;
}

/** Split a base64 data URL into payload + mime type; else keep the data and use the fallback mime. */
export function parseDataUrl(
  data: string,
  fallbackMime: string,
): { data: string; mimeType: string } {
  if (typeof data === "string" && data.includes(";base64,")) {
    const segments = data.split(";base64,");
    return {
      data: segments[1],
      mimeType: segments[0].replace("data:", ""),
    };
  }
  return { data, mimeType: fallbackMime };
}

function buildInlinePart(
  data: string,
  fallbackMime: string,
): Record<string, unknown> {
  return { inlineData: parseDataUrl(data, fallbackMime) };
}

/** True when the body carries at least one content input (text, images, audio, video, pdf). */
export function hasContentInput(body: EmbedRequestBody): boolean {
  const { text, images, audio, video, pdf } = body;
  return Boolean(
    text || (images && images.length > 0) || audio || video || pdf,
  );
}

/** Text-only vs multimodal content, preserving input order for images and media. */
export function buildEmbeddingContent(
  body: EmbedRequestBody,
): string | Record<string, unknown>[] {
  const { text, images, audio, video, pdf } = body;
  const hasImages = images && images.length > 0;
  const isMultimodal =
    hasImages || Boolean(audio) || Boolean(video) || Boolean(pdf);

  if (!isMultimodal && text) return text as string;

  const parts: Record<string, unknown>[] = [];
  if (text) parts.push({ text });
  if (hasImages) {
    for (const image of images) {
      parts.push(buildInlinePart(image, "image/jpeg"));
    }
  }
  if (audio) parts.push(buildInlinePart(audio, "audio/mpeg"));
  if (video) parts.push(buildInlinePart(video, "video/mp4"));
  if (pdf) parts.push(buildInlinePart(pdf, "application/pdf"));
  return parts;
}

/** EmbeddingService options shared by the single-input and batch branches. */
function buildEmbedOptions(req: Request, body: EmbedRequestBody) {
  return {
    provider: body.provider,
    model: body.model,
    taskType: body.taskType || body.input_type,
    dimensions: body.dimensions,
    project: req.project,
    username: req.username,
    clientIp: req.clientIp,
    source: "api",
    endpoint: "/embed",
    traceId: body.traceId || null,
  };
}

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
      const body: EmbedRequestBody = req.body;
      const options = buildEmbedOptions(req, body);

      // Text batch: one vector per input, in input order, same space as `text`.
      if (body.texts !== undefined) {
        if (body.text || body.images || body.audio || body.video || body.pdf) {
          throw new ProviderError("server", "Send either texts or a single content input, not both", 400);
        }
        res.json(await EmbeddingService.generateMany(body.texts, options));
        return;
      }

      // At least one content input is required
      if (!hasContentInput(body)) {
        throw new ProviderError(
          "server",
          "At least one content input is required (text, images, audio, video, or pdf)",
          400,
        );
      }

      res.json(await EmbeddingService.generate(buildEmbeddingContent(body), options));
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
