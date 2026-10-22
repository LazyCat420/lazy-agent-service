import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { handleAgent } from "./ChatRoutes.ts";
import { handleApprovalDecision } from "./ApprovalDecisionRoute.ts";
import { handleQuestionAnswer } from "./QuestionAnswerHandler.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";

const router = express.Router();

// POST /conversation/approve — see ApprovalDecisionRoute; /conversation/answer — see QuestionAnswerHandler.
router.post("/approve", handleApprovalDecision("[conversation/approve]"));
router.post("/answer", handleQuestionAnswer("conversation/answer"));

/**
 * POST /conversation
 * Triggers either an agentic multi-turn run or a direct model completion.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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
      } else {
        await handleJsonRequest(req, res, next, params, handleAgent);
      }
    } else {
      const params = {
        ...req.body,
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
      };

      if (req.query.stream !== "false") {
        await handleSseRequest(req, res, params);
      } else {
        await handleJsonRequest(req, res, next, params);
      }
    }
  }),
);

export default router;
