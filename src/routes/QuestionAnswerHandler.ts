import type { Request, Response } from "express";
import AgenticLoopService from "../services/AgenticLoopService.ts";
import logger from "../utils/logger.ts";

/**
 * POST /agent/answer and POST /conversation/answer — the user answers the
 * pending ask_user question of a turn.
 * ported from prism-service src/routes/QuestionAnswerHandler.ts
 *
 * Body:
 *   {
 *     conversationId: string,
 *     questionId?: string,   // from the `user_question` event — resolves exactly that card
 *     answer?: string,       // simple
 *     answers?: Array<{ answer: string|string[], annotations?: string }>,
 *   }
 *
 * 404 — no pending question, or an unknown questionId (the client then
 *       sends the answer as a normal message).
 * 409 — a second answer to a card already answered.
 */
export function handleQuestionAnswer(routeLabel: string) {
  return (request: Request, response: Response) => {
    const { conversationId, questionId, answer, answers } = request.body ?? {};

    if (typeof conversationId !== "string" || !conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }
    if (questionId !== undefined && typeof questionId !== "string") {
      return response.status(400).json({ error: "questionId must be a string" });
    }

    let normalizedAnswers: { answer: string | string[]; annotations?: string }[];
    if (Array.isArray(answers) && answers.length > 0) {
      normalizedAnswers = answers as { answer: string | string[]; annotations?: string }[];
    } else if (answer !== undefined && answer !== null) {
      normalizedAnswers = [{ answer: String(answer) }];
    } else {
      return response.status(400).json({ error: "Missing answer or answers" });
    }

    const outcome = AgenticLoopService.resolveUserQuestion(conversationId, normalizedAnswers, {
      questionId: questionId || undefined,
    });

    if (!outcome.resolved && outcome.reason === "already_answered") {
      return response.status(409).json({
        error: "This question was already answered",
        reason: outcome.reason,
        conversationId,
        questionId: outcome.questionId,
      });
    }
    if (!outcome.resolved) {
      return response.status(404).json({
        error:
          outcome.reason === "unknown_question"
            ? "No pending question with this questionId"
            : "No pending question for this conversation",
        reason: outcome.reason,
        conversationId,
        ...(outcome.questionId ? { questionId: outcome.questionId } : {}),
      });
    }

    logger.info(
      `[${routeLabel}] ${normalizedAnswers.length} answer(s) for conversation ${conversationId}`,
    );
    return response.json({ ok: true, questionId: outcome.questionId });
  };
}
