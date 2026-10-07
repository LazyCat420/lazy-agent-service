import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import AgenticLoopService from "../services/AgenticLoopService.js";
import { handleAgent } from "./ChatRoutes.js";
import logger from "../utils/logger.js";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.js";
const router = express.Router();
/**
 * POST /conversation/approve
 * Body: { conversationId, approved, approveAll }
 * Resolves pending plan/tool approvals for agent loops.
 */
router.post("/approve", asyncHandler(async (req, res) => {
    const { conversationId, approved, approveAll } = req.body;
    const isApproved = approved !== false;
    const shouldApproveAll = approveAll === true;
    if (!conversationId) {
        return res.status(400).json({ error: "Missing conversationId" });
    }
    const resolved = AgenticLoopService.resolveApproval(conversationId, isApproved, { shouldApproveAll });
    if (!resolved) {
        return res.status(404).json({
            error: "No pending approval for this conversation",
            conversationId,
        });
    }
    logger.info(`[conversation/approve] ${isApproved ? "Approved" : "Rejected"}${shouldApproveAll ? " (all future)" : ""} for conversation ${conversationId}`);
    res.json({ ok: true, approved: isApproved });
}));
/**
 * POST /conversation/answer
 * Body: { conversationId, answer, answers }
 * Resolves pending ask_user_question prompts for agent loops.
 */
router.post("/answer", asyncHandler(async (req, res) => {
    const { conversationId, answer, answers } = req.body;
    if (!conversationId) {
        return res.status(400).json({ error: "Missing conversationId" });
    }
    let normalizedAnswers;
    if (Array.isArray(answers) && answers.length > 0) {
        normalizedAnswers = answers;
    }
    else if (answer !== undefined && answer !== null) {
        normalizedAnswers = [{ answer: String(answer) }];
    }
    else {
        return res.status(400).json({ error: "Missing answer or answers" });
    }
    const resolved = AgenticLoopService.resolveUserQuestion(conversationId, normalizedAnswers);
    if (!resolved) {
        return res.status(404).json({
            error: "No pending question for this conversation",
            conversationId,
        });
    }
    logger.info(`[conversation/answer] ${normalizedAnswers.length} answer(s) for conversation ${conversationId}`);
    res.json({ ok: true });
}));
/**
 * POST /conversation
 * Triggers either an agentic multi-turn run or a direct model completion.
 */
router.post("/", asyncHandler(async (req, res, next) => {
    const isAgent = !!(req.body.agent || req.body.agenticLoopEnabled);
    if (isAgent) {
        const params = {
            ...req.body,
            functionCallingEnabled: true,
            agenticLoopEnabled: true,
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
            agent: req.body.agent || req.agent || null,
            workspaceRoot: req.workspaceRoot || req.body.workspaceRoot || null,
        };
        if (req.query.stream !== "false") {
            await handleSseRequest(req, res, params, handleAgent);
        }
        else {
            await handleJsonRequest(req, res, next, params, handleAgent);
        }
    }
    else {
        const params = {
            ...req.body,
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
        };
        if (req.query.stream !== "false") {
            await handleSseRequest(req, res, params);
        }
        else {
            await handleJsonRequest(req, res, next, params);
        }
    }
}));
export default router;
//# sourceMappingURL=ConversationExecutionRoute.js.map