import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import EmbeddingService from "../services/EmbeddingService.ts";
import { indexedEmbedding, type IndexedEmbedding } from "../services/SemanticEmbedding.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { PostSkillSchema, PutSkillSchema } from "../types/index.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.AGENT_SKILLS;

interface SkillDocument {
  _id?: ObjectId;
  project: string;
  username: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  embedding?: number[] | null;
  semanticEmbedding?: IndexedEmbedding | null;
}

/**
 * Generate an embedding vector for skill content.
 * Combines name + description + content for richer semantic representation.
 */
async function generateSkillEmbedding(
  skill: Pick<SkillDocument, "name" | "description" | "content">,
) {
  const text = [skill.name, skill.description, skill.content]
    .filter(Boolean)
    .join("\n");
  return indexedEmbedding(await EmbeddingService.generate(text, {
    taskType: "RETRIEVAL_DOCUMENT",
    source: "skill-creation",
    endpoint: "/skills",
  }));
}

/**
 * GET /skills
 * List all skills for the given project + username.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const skills = await db
        .collection<SkillDocument>(COLLECTION)
        .find({ project, username })
        .sort({ createdAt: -1 })
        // Don't return embedding vectors to the client — they're large
        .project<SkillDocument>({ embedding: 0, semanticEmbedding: 0 })
        .toArray();

      res.json(
        skills.map((skill) => ({
          ...skill,
          id: skill._id ? skill._id.toString() : "",
        })),
      );
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /skills
 * Create a new skill. Generates an embedding vector at creation time.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const validated = PostSkillSchema.parse(req.body);

      const document: SkillDocument = {
        project,
        username,
        name: validated.name,
        description: validated.description,
        content: validated.content,
        enabled: validated.enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Generate embedding for semantic similarity search
      try {
        document.semanticEmbedding = await generateSkillEmbedding(document);
      } catch (error: unknown) {
        logger.warn(
          `[Skills] Embedding generation failed: ${getErrorMessage(error)}`,
        );
        document.semanticEmbedding = null;
      }

      const result = await db
        .collection<SkillDocument>(COLLECTION)
        .insertOne(document);

      logger.info(`Skill created: ${document.name} (${result.insertedId})`);
      const { embedding: _, semanticEmbedding: _semantic, ...response } = document;
      res.status(201).json({ ...response, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /skills/:id
 * Update an existing skill. Re-generates embedding if content changes.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const validated = PutSkillSchema.parse(req.body);

      const updates: Partial<SkillDocument> = {
        ...(validated.name !== undefined && { name: validated.name }),
        ...(validated.description !== undefined && {
          description: validated.description,
        }),
        ...(validated.content !== undefined && { content: validated.content }),
        ...(validated.enabled !== undefined && { enabled: validated.enabled }),
        updatedAt: new Date(),
      };

      // Re-generate embedding if any semantic content changed
      const contentChanged =
        validated.name !== undefined ||
        validated.description !== undefined ||
        validated.content !== undefined;

      if (contentChanged) {
        try {
          // Need current doc to merge fields for embedding
          const current = await db
            .collection<SkillDocument>(COLLECTION)
            .findOne({ _id: new ObjectId(req.params.id as string) });

          if (current) {
            const merged = {
              name: updates.name ?? current.name,
              description: updates.description ?? current.description,
              content: updates.content ?? current.content,
            };
            updates.semanticEmbedding = await generateSkillEmbedding(merged);
          }
        } catch (error: unknown) {
          logger.warn(
            `[Skills] Embedding re-generation failed: ${getErrorMessage(error)}`,
          );
        }
      }

      const result = await db
        .collection<SkillDocument>(COLLECTION)
        .findOneAndUpdate(
          { _id: new ObjectId(req.params.id as string) },
          { $set: updates },
          { returnDocument: "after", projection: { embedding: 0 } },
        );

      if (!result) {
        return res.status(404).json({ error: "Skill not found" });
      }

      logger.info(`Skill updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id ? result._id.toString() : "" });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /skills/:id
 * Delete a skill.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;

      const result = await db
        .collection<SkillDocument>(COLLECTION)
        .findOneAndDelete({ _id: new ObjectId(req.params.id as string) });

      if (!result) {
        return res.status(404).json({ error: "Skill not found" });
      }

      logger.info(`Skill deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
