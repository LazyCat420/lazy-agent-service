import { DEFAULT_TOPOLOGY, DEFAULT_THOUGHT_STRUCTURE } from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import {
  pendingApprovals,
  pendingQuestions,
  type PendingToolCallSummary,
  type QuestionDefinition,
  type QuestionAnswer,
} from "./ApprovalRegistry.ts";
import ConversationGenerationTracker from "./ConversationGenerationTracker.ts";
import ToolContext from "./ToolContext.ts";
import logger from "../utils/logger.ts";

import type { AgenticContext, ConversationMessage } from "./harnesses/types.ts";

/**
 * AgenticLoopService — public façade for agentic loop execution.
 *
 * Orchestrates:
 *   1. Tool resolution (AgenticToolResolver)
 *   2. State initialization (AgenticLoopState)
 *   3. Harness selection and instantiation (HarnessRegistry)
 *   4. Thought structure resolution (Chain of Thought / Tree of Thoughts / Graph of Thoughts)
 *   5. Cleanup (approvals, questions, session tracking)
 *
 * Also exposes approval/question resolution APIs used by AgentRoutes.
 */
export default class AgenticLoopService {
  /** Run an agentic loop using the specified (or default) harness. */
  static async runAgenticLoop(
    context: AgenticContext,
  ): Promise<{ messages: ConversationMessage[] }> {
    const {
      options,
      agent,
      project,
      username,
      modelDefinition,
      messages,
      agentConversationId,
      conversationId,
      parentAgentConversationId,
    } = context;

    const resolvedAgentConversationId = agentConversationId || "";
    const resolvedParentAgentConversationId = parentAgentConversationId || null;

    // Load any persisted tool state from MongoDB (e.g. after server restart or previous turn)
    await ToolContext.ensureLoaded(resolvedAgentConversationId);

    // 1. Resolve tools (passing agentConversationId so dynamicEnabledTools is merged)
    const resolvedTools = await AgenticToolResolver.resolve({
      options,
      agent: agent || undefined,
      project,
      username,
      modelDefinition: modelDefinition || undefined,
      agentConversationId: resolvedAgentConversationId,
      providerName: context.providerName,
      resolvedModel: context.resolvedModel,
    });

    // If dynamicEnabledTools is not in ToolContext, populate it with the resolved tools
    const toolContextStore = ToolContext.getStore(resolvedAgentConversationId);
    if (!toolContextStore.has("dynamicEnabledTools")) {
      const initialNames =
        resolvedTools.resolvedEnabledTools ||
        resolvedTools.finalTools.map((tool) => tool.name);
      ToolContext.set(resolvedAgentConversationId, "dynamicEnabledTools", initialNames);
    }

    // If this is a top-level agent request with an existing conversation,
    // all messages except the last one (the triggering input) are already
    // persisted in the database. For new conversations (e.g. Discord channel
    // history passed as ephemeral context), nothing has been persisted yet.
    if (!options.isSubAgent && !context.isNewConversation && messages.length > 0) {
      for (let i = 0; i < messages.length - 1; i++) {
        (messages[i] as any)._alreadyPersisted = true;
      }
    }

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
    });

    // When the client explicitly enumerated its enabledTools (e.g. HTML-Notes
    // enabling the mcp__lazy-tool-service__* widget tools), pre-load them so
    // they are sent to the provider natively from iteration 1 — the
    // describe_tools lazy-loading dance is for catalog browsing, not for
    // small explicit tool sets the client already committed to.
    if (Array.isArray(options.enabledTools) && options.enabledTools.length > 0) {
      const explicitlyEnabled = new Set(
        options.enabledTools.map((name: string) =>
          name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, ""),
        ),
      );
      for (const tool of resolvedTools.finalTools) {
        const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
        if (explicitlyEnabled.has(cleanName)) {
          state.loadedTools.add(cleanName);
        }
      }
    }

    // 3. Select harness, topology, and thought structure
    let harnessId = options.harness;
    let topologyId = options.topology;
    let thoughtStructure = options.thoughtStructure;
    if (!harnessId || !topologyId || !thoughtStructure || options.enableCriticGate === undefined) {
      try {
        const { default: SettingsService } =
          await import("./SettingsService.js");
        const agentSettings = await SettingsService.getSection("agents");
        if (!harnessId) harnessId = agentSettings?.harness || "standard";
        if (!topologyId)
          topologyId = agentSettings?.topology || DEFAULT_TOPOLOGY;
        if (!thoughtStructure)
          thoughtStructure = (agentSettings?.thoughtStructure as string) || DEFAULT_THOUGHT_STRUCTURE;

        // CriticGate: auto-enable from settings when a critic model is configured
        // and the request didn't explicitly set enableCriticGate.
        if (
          options.enableCriticGate === undefined &&
          agentSettings?.criticModel
        ) {
          options.enableCriticGate = true;
          options.criticModel =
            options.criticModel || agentSettings.criticModel;
        }

        // SystemReminderInjector: auto-populate from settings when a reminder model is configured
        if (agentSettings?.reminderModel) {
          options.reminderModel =
            (options.reminderModel as string) || agentSettings.reminderModel;
          options.reminderProvider =
            (options.reminderProvider as string) || agentSettings.reminderProvider;
        }
      } catch {
        if (!harnessId) harnessId = "standard";
        if (!topologyId) topologyId = DEFAULT_TOPOLOGY;
        if (!thoughtStructure) thoughtStructure = DEFAULT_THOUGHT_STRUCTURE;
      }
    }

    options.harness = harnessId;
    options.topology = topologyId;
    options.thoughtStructure = thoughtStructure;
    const HarnessClass = HarnessRegistry.get(harnessId)!;
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label}), thoughtStructure: "${thoughtStructure}"`,
    );

    // 4. Instantiate and run
    const harness = new HarnessClass(context, state, resolvedTools);
    try {
      return await harness.run();
    } finally {
      // Clean up in-memory cache keyed by agentConversationId (keeps MongoDB state for next turn)
      ToolContext.cleanupInMemory(resolvedAgentConversationId);

      // Clean up in-memory state keyed by conversationId (client-facing)
      pendingApprovals.delete(conversationId);
      pendingQuestions.delete(conversationId);

      // Always clean up per-session tracker entries to prevent memory leaks —
      // sub-agent sessions have their own agentConversationId that must be released.
      ConversationGenerationTracker.cleanup(resolvedAgentConversationId);

      // Only clean up orchestrator state for root sessions — sub-agents are
      // cleaned by the parent session's OrchestratorService.cleanupConversation().
      if (!resolvedParentAgentConversationId) {
        try {
          const { default: OrchestratorService } =
            await import("./OrchestratorService.js");
          OrchestratorService.cleanupConversation(resolvedAgentConversationId);
        } catch {
          /* OrchestratorService may not be used */
        }
      }
    }
  }

  // ── Approval Resolution API ─────────────────────────────
  // Keyed by conversationId — the client-facing conversation identifier.
  // Only one agentic run is active per conversation at a time, so there
  // is no collision risk.

  /** Resolve a pending approval for a conversation. */
  static resolveApproval(
    conversationId: string,
    isApproved: boolean,
    { shouldApproveAll = false }: { shouldApproveAll?: boolean } = {},
  ): boolean {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return false;

    if (entry.type === "plan") {
      entry.resolve(isApproved);
    } else {
      entry.resolve({
        isApproved,
        shouldApproveAll,
        reason: isApproved ? "user_approved" : "user_rejected",
      });
    }
    return true;
  }

  /** Check if a conversation has a pending approval. */
  static getPendingApproval(conversationId: string): {
    isPending: boolean;
    type?: string;
    tools?: string[];
    toolCalls?: PendingToolCallSummary[];
  } {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return { isPending: false };
    return {
      isPending: true,
      type: entry.type,
      tools: entry.tools,
      toolCalls: entry.toolCalls,
    };
  }

  // ── Ask User Question — Resolution API ─────────────────

  /** Store a pending question resolver (called by ToolOrchestratorService). */
  static _setPendingQuestion(
    conversationId: string,
    entry: {
      resolve: (value: {
        answers: QuestionAnswer[] | null;
        isTimedOut?: boolean;
      }) => void;
      question?: string;
      questions?: QuestionDefinition[];
      choices?: string[];
    },
  ): void {
    pendingQuestions.set(conversationId, entry);
  }

  /** Resolve a pending question for a conversation. */
  static resolveUserQuestion(
    conversationId: string,
    answers: QuestionAnswer[],
  ): boolean {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return false;
    pendingQuestions.delete(conversationId);
    entry.resolve({ answers });
    return true;
  }

  /** Check if a conversation has a pending question. */
  static getPendingQuestion(conversationId: string): {
    isPending: boolean;
    question?: string;
    questions?: QuestionDefinition[];
    choices?: string[];
  } {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return { isPending: false };
    return {
      isPending: true,
      question: entry.question,
      questions: entry.questions,
      choices: entry.choices,
    };
  }

  // ── Harness Discovery API ──────────────────────────────

  /** List available harnesses for the settings UI. */
  static listHarnesses(): Array<{
    id: string;
    label: string;
    description: string;
  }> {
    return HarnessRegistry.list() as Array<{
      id: string;
      label: string;
      description: string;
    }>;
  }
}
