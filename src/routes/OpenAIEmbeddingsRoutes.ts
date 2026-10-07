import express, { Request, Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import EmbeddingService, { MAX_BATCH_TEXTS } from "../services/EmbeddingService.ts";
import { EMBEDDING_MODEL } from "../services/EmbeddingGemma2Client.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

/**
 * POST /v1/embeddings — the shared embedder in the OpenAI request/response shape,
 * so off-the-shelf clients (OpenAI SDKs, Oh My Pi, LangChain…) plug in with a base
 * URL of `http://<host>:5591/v1`. Same model, request queue and vector spaces as
 * `POST /embed`.
 *
 * Without `input_type` the symmetric `similarity` task is used: a generic client
 * embeds queries and documents through the same call, and only a symmetric
 * representation is comparable between the two. A client that can tell them apart
 * sends `input_type: "query" | "document"` (OpenAI SDKs: `extra_body`). The
 * response's extra `space` field names the vector space, for versioning an index.
 */
const router = express.Router();

const ACCEPTED_MODELS = new Set([EMBEDDING_MODEL, "google/embeddinggemma-2", "embeddinggemma"]);

function openAIError(res: Response, status: number, message: string, param: string | null = null) {
  const type = status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error";
  res.status(status).json({ error: { message, type, param, code: null } });
}

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { input, model, encoding_format: encoding, dimensions, input_type: inputType, user } = req.body || {};
    if (model !== undefined && !ACCEPTED_MODELS.has(model)) {
      return openAIError(res, 400, `Unknown embedding model "${model}"; this endpoint serves ${EMBEDDING_MODEL}`, "model");
    }
    const texts = typeof input === "string" ? [input] : input;
    if (!Array.isArray(texts) || !texts.length || texts.length > MAX_BATCH_TEXTS ||
      texts.some(text => typeof text !== "string" || !text.trim())) {
      return openAIError(res, 400, `input must be a non-empty string or 1–${MAX_BATCH_TEXTS} non-empty strings`, "input");
    }
    if (encoding !== undefined && encoding !== "float" && encoding !== "base64") {
      return openAIError(res, 400, "encoding_format must be float or base64", "encoding_format");
    }
    try {
      const result = await EmbeddingService.generateMany(texts, {
        taskType: inputType || "similarity",
        dimensions,
        project: req.project || "openai-compatible",
        username: req.username || (typeof user === "string" ? user : undefined),
        clientIp: req.clientIp,
        source: "openai",
        endpoint: "/v1/embeddings",
      });
      const encode = (vector: number[]) =>
        encoding === "base64" ? Buffer.from(new Float32Array(vector).buffer).toString("base64") : vector;
      const tokens = Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);
      res.json({
        object: "list",
        data: result.embeddings.map((embedding, index) => ({ object: "embedding", index, embedding: encode(embedding) })),
        model: result.model,
        usage: { prompt_tokens: tokens, total_tokens: tokens },
        space: result.space,
      });
    } catch (error: unknown) {
      openAIError(res, (error as { statusCode?: number }).statusCode || 500, getErrorMessage(error));
    }
  }),
);

export default router;
