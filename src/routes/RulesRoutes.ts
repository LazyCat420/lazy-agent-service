import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { PostRuleSchema, PutRuleSchema } from "../types/index.ts";
import { createDeleteByIdHandler } from "./utils/deleteByIdRoute.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.AGENT_RULES;

interface RuleDocument {
  _id?: ObjectId;
  project: string;
  username: string;
  agent: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * GET /rules
 * List all rules for the given project + username + agent.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const agent = (req.query.agent as string) || null;
      const { db } = req;

      const query: Record<string, unknown> = { project, username };
      if (agent) query.agent = agent;

      const rules = await db
        .collection<RuleDocument>(COLLECTION)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(
        rules.map((rule) => ({
          ...rule,
          id: rule._id ? rule._id.toString() : "",
        })),
      );
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /rules
 * Create a new rule scoped to a specific agent.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const validated = PostRuleSchema.parse(req.body);

      const document: RuleDocument = {
        project,
        username,
        agent: validated.agent,
        name: validated.name,
        description: validated.description,
        content: validated.content,
        enabled: validated.enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db
        .collection<RuleDocument>(COLLECTION)
        .insertOne(document);

      logger.info(
        `Rule created: ${document.name} for agent ${document.agent} (${result.insertedId})`,
      );
      res.status(201).json({ ...document, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /rules/:id
 * Update an existing rule.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const validated = PutRuleSchema.parse(req.body);

      const updates: Partial<RuleDocument> = {
        ...(validated.name !== undefined && { name: validated.name }),
        ...(validated.description !== undefined && {
          description: validated.description,
        }),
        ...(validated.content !== undefined && { content: validated.content }),
        ...(validated.enabled !== undefined && { enabled: validated.enabled }),
        updatedAt: new Date(),
      };

      const result = await db
        .collection<RuleDocument>(COLLECTION)
        .findOneAndUpdate(
          { _id: new ObjectId(req.params.id as string) },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json({ error: "Rule not found" });
      }

      logger.info(`Rule updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id ? result._id.toString() : "" });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /rules/:id
 * Delete a rule.
 */
router.delete(
  "/:id",
  createDeleteByIdHandler({
    collection: COLLECTION,
    notFoundError: "Rule not found",
    logLabel: "Rule",
  }),
);

export default router;
