/**
 * ApprovalRegistry — shared mutable state for pending tool/plan approvals
 * and user-question prompts during agentic loop execution.
 *
 * Lives in its own module to avoid circular imports between
 * AgenticLoopService (the public façade) and harness implementations.
 */

// ── Approval Entry Types ───────────────────────────────────

export interface ApprovalResolution {
  isApproved: boolean;
  shouldApproveAll?: boolean;
  reason?: string;
  /** The user's own words for a denial — relayed to the model. */
  denialReason?: string;
  /** Edited arguments by tool call id (allow only; already schema-validated). */
  editedArgs?: Record<string, Record<string, unknown>>;
}

export interface PendingToolCallSummary {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  _approval?: { tier: string; tierLabel: string };
}

export interface PendingToolApprovalEntry {
  resolve: (value: ApprovalResolution) => void;
  type: "tool";
  /** Durable record id of each call, by position (PendingApprovalStore itemId). */
  itemIds?: string[];
  tools: string[];
  toolCalls: PendingToolCallSummary[];
}

export interface PendingPlanApprovalEntry {
  resolve: (isApproved: boolean) => void;
  type: "plan";
  tools?: string[];
  toolCalls?: PendingToolCallSummary[];
}

export type PendingApprovalEntry =
  | PendingToolApprovalEntry
  | PendingPlanApprovalEntry;

// ── Question Entry Types ───────────────────────────────────

export interface QuestionAnswer {
  answer: string | string[];
  annotations?: string;
}

export interface QuestionResolution {
  answers: QuestionAnswer[] | null;
  isTimedOut?: boolean;
}

export interface QuestionDefinition {
  question: string;
  [key: string]: unknown;
}

export interface PendingQuestionEntry {
  /** Id shown on the `user_question` card; an answer may name it. */
  questionId?: string;
  resolve: (value: QuestionResolution) => void;
  question?: string;
  questions?: QuestionDefinition[];
  choices?: string[];
}

// ── Approval Resolver Registry ─────────────────────────────
// Stores pending approval objects keyed by conversationId.
// The HTTP endpoint resolves these when the client sends approval.
export const pendingApprovals = new Map<string, PendingApprovalEntry>();

// ── Question Resolver Registry ─────────────────────────────
// Stores pending question objects keyed by conversationId.
// The HTTP endpoint resolves these when the user answers an ask_user_question.
export const pendingQuestions = new Map<string, PendingQuestionEntry>();
