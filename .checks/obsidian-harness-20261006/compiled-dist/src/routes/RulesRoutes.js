import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
import { PostRuleSchema, PutRuleSchema } from "../types/index.js";
const router = express.Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.AGENT_RULES;
/**
 * GET /rules
 * List all rules for the given project + username + agent.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project || "any";
        const username = req.username || "any";
        const agent = req.query.agent || null;
        const { db } = req;
        const query = { project, username };
        if (agent)
            query.agent = agent;
        const rules = await db
            .collection(COLLECTION)
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();
        res.json(rules.map((rule) => ({
            ...rule,
            id: rule._id ? rule._id.toString() : "",
        })));
    }
    catch (error) {
        next(error);
    }
}));
/**
 * POST /rules
 * Create a new rule scoped to a specific agent.
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const validated = PostRuleSchema.parse(req.body);
        const document = {
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
            .collection(COLLECTION)
            .insertOne(document);
        logger.info(`Rule created: ${document.name} for agent ${document.agent} (${result.insertedId})`);
        res.status(201).json({ ...document, id: result.insertedId.toString() });
    }
    catch (error) {
        next(error);
    }
}));
/**
 * PUT /rules/:id
 * Update an existing rule.
 */
router.put("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const validated = PutRuleSchema.parse(req.body);
        const updates = {
            ...(validated.name !== undefined && { name: validated.name }),
            ...(validated.description !== undefined && {
                description: validated.description,
            }),
            ...(validated.content !== undefined && { content: validated.content }),
            ...(validated.enabled !== undefined && { enabled: validated.enabled }),
            updatedAt: new Date(),
        };
        const result = await db
            .collection(COLLECTION)
            .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: updates }, { returnDocument: "after" });
        if (!result) {
            return res.status(404).json({ error: "Rule not found" });
        }
        logger.info(`Rule updated: ${result.name} (${req.params.id})`);
        res.json({ ...result, id: result._id ? result._id.toString() : "" });
    }
    catch (error) {
        next(error);
    }
}));
/**
 * DELETE /rules/:id
 * Delete a rule.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const result = await db
            .collection(COLLECTION)
            .findOneAndDelete({ _id: new ObjectId(req.params.id) });
        if (!result) {
            return res.status(404).json({ error: "Rule not found" });
        }
        logger.info(`Rule deleted: ${result.name} (${req.params.id})`);
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
}));
export default router;
//# sourceMappingURL=RulesRoutes.js.map