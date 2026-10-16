import { pendingQuestions, type QuestionAnswer, type QuestionDefinition } from "../../ApprovalRegistry.ts";
import logger from "../../../utils/logger.ts";
import type { AgenticContext } from "../types.ts";

/**
 * ask_user — the model asks the user one or more questions mid-turn and the
 * turn parks until POST /agent/answer (or /conversation/answer) answers the
 * card. Ported from prism-service services/tool-definitions/AskUserQuestionTool.ts
 * (blocking path only: no durable PendingDecisionStore, no non-blocking cards).
 * The wait ends with the turn's abort signal.
 */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const HEADER_MAX = 16;

export const ASK_USER_TOOL_SCHEMA = {
  name: "ask_user",
  description:
    "Ask the user one or more questions and wait for their responses before continuing. " +
    "Use this when you need clarification, a decision between options, or explicit " +
    "confirmation before proceeding with a potentially impactful action. " +
    "The agent loop pauses until the user responds. " +
    "You can batch up to 4 related questions in a single call.",
  parameters: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description: "Optional: additional context shown below the questions.",
      },
      questions: {
        type: "array",
        maxItems: MAX_QUESTIONS,
        description: "Batch of questions to ask the user (up to 4).",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question text." },
            header: {
              type: "string",
              maxLength: HEADER_MAX,
              description: "Optional: short label chip (max 16 chars).",
            },
            options: {
              type: "array",
              maxItems: MAX_OPTIONS,
              description: "Optional: predefined choices (up to 6).",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The choice label." },
                  preview: { type: "string", description: "Optional preview content." },
                },
                required: ["label"],
              },
            },
            multiSelect: {
              type: "boolean",
              description: "Optional: allow selecting several options.",
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
} as const;

interface QuestionInput {
  question?: unknown;
  header?: unknown;
  options?: Array<{ label?: unknown; preview?: unknown }>;
  multiSelect?: unknown;
}

let questionCounter = 0;

/** Execute the ask_user internal tool; resolves when the user answers. */
export async function executeAskUser(
  args: Record<string, unknown>,
  context: Pick<AgenticContext, "conversationId" | "emit" | "signal">,
): Promise<Record<string, unknown>> {
  const questions = Array.isArray(args.questions) ? (args.questions as QuestionInput[]) : [];
  if (questions.length === 0) {
    return { error: "The 'questions' array is required and must not be empty" };
  }
  if (questions.length > MAX_QUESTIONS) {
    return { error: `Maximum ${MAX_QUESTIONS} questions per call` };
  }
  const seen = new Set<string>();
  const normalized: QuestionDefinition[] = [];
  for (const input of questions) {
    if (typeof input.question !== "string" || !input.question) {
      return { error: "Each question in the 'questions' array must have a non-empty 'question' string" };
    }
    if (seen.has(input.question)) {
      return { error: `Duplicate question text: "${input.question.slice(0, 80)}"` };
    }
    seen.add(input.question);
    const labels = new Set<string>();
    const options = (input.options ?? []).slice(0, MAX_OPTIONS).map((option) => {
      const label = String(option.label ?? "");
      if (labels.has(label)) {
        throw new Error(`Duplicate option label "${label}" in question "${input.question}"`);
      }
      labels.add(label);
      return { label, preview: typeof option.preview === "string" ? option.preview : null };
    });
    normalized.push({
      question: input.question,
      header: typeof input.header === "string" ? input.header.slice(0, HEADER_MAX) || null : null,
      options,
      multiSelect: input.multiSelect === true,
    });
  }

  const { conversationId, emit, signal } = context;
  if (!conversationId) {
    return { error: "No conversation — ask_user requires an active conversation" };
  }

  const questionId = `q-${Date.now().toString(36)}-${(questionCounter++).toString(36)}`;
  let settle!: (answers: QuestionAnswer[] | null) => void;
  const answered = new Promise<QuestionAnswer[] | null>((resolve) => {
    settle = resolve;
  });
  pendingQuestions.set(conversationId, {
    questionId,
    questions: normalized,
    question: normalized[0].question,
    resolve: (value) => settle(value.answers),
  });
  const withdraw = () => {
    if (pendingQuestions.get(conversationId)?.questionId === questionId) {
      pendingQuestions.delete(conversationId);
    }
    settle(null);
  };
  emit({
    type: "user_question",
    questions: normalized,
    context: typeof args.context === "string" ? args.context : null,
    questionId,
    blocking: true,
  });
  signal?.addEventListener("abort", withdraw, { once: true });
  if (signal?.aborted) withdraw();

  let answers: QuestionAnswer[] | null;
  try {
    answers = await answered;
  } finally {
    signal?.removeEventListener("abort", withdraw);
  }
  if (!answers) {
    logger.info(`[AskUser] ${questionId} withdrawn — its turn was stopped`);
    return { questionId, answers: null, isCancelled: true };
  }
  return { questionId, questions: normalized.map((entry) => entry.question), answers };
}
