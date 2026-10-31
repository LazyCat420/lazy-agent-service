import { DEFAULT_CONVERSATION_TITLE } from "@rodrigo-barraza/utilities-library/taxonomy";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";

import { COLLECTIONS } from "../../constants.ts";
import type { ChatMessage } from "../../types/admin.ts";
import { discoverDescendantConversationIds } from "../../utils/ConversationDiscovery.ts";
import type {
  ConversationMeta,
  ConversationSettings,
  MessagePayload,
  ConversationServiceInterface,
  TransformedConversation,
  TransformedConversationStats,
  ResumeMessage,
} from "./types.ts";
import { normalizeRoleAlternation } from "../RoleAlternation.ts";
import type { ConversationMessage } from "../harnesses/types.ts";
import {
  extractFiles,
  computeModalities,
  extractProviders,
  computeTotalCost,
} from "./utils.ts";

const DEFAULT_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;

/** $set fields for an append: only the metadata the caller actually supplied. */
function buildAppendSetFields(
  conversationMeta: ConversationMeta | null,
  traceId: string | null,
  now: string,
): Record<string, unknown> {
  const setFields: Record<string, unknown> = { updatedAt: now };
  if (traceId) setFields.traceId = traceId;
  if (!conversationMeta) return setFields;

  if (conversationMeta.title !== undefined) {
    setFields.title = conversationMeta.title;
  }
  if (conversationMeta.systemPrompt !== undefined) {
    setFields.systemPrompt = conversationMeta.systemPrompt;
  }
  if (conversationMeta.settings !== undefined) {
    setFields.settings = {
      ...conversationMeta.settings,
      systemPrompt: conversationMeta.systemPrompt || "",
    };
  }
  if (conversationMeta.parentAgentConversationId) {
    setFields.parentAgentConversationId = conversationMeta.parentAgentConversationId;
  }
  if (conversationMeta.parentConversationId) {
    setFields.parentConversationId = conversationMeta.parentConversationId;
  }
  if (conversationMeta.workspaceRoot) {
    setFields.workspaceRoot = conversationMeta.workspaceRoot;
  }
  return setFields;
}

/** Defaults a conversation is created with, resolved once from optional metadata. */
interface AppendMetaDefaults {
  title: string;
  systemPrompt: string;
  settings: ConversationSettings;
  parentAgentConversationId: string | null;
  parentConversationId: string | null;
  workspaceRoot: string | null;
  agent: string | null;
  synthetic: boolean;
}

function resolveAppendContentDefaults(
  conversationMeta: ConversationMeta | null,
): Pick<AppendMetaDefaults, "title" | "systemPrompt" | "settings" | "synthetic"> {
  const settings = conversationMeta?.settings || {};
  const systemPrompt = conversationMeta?.systemPrompt || "";
  return {
    title: conversationMeta?.title || DEFAULT_CONVERSATION_TITLE,
    systemPrompt,
    settings,
    synthetic: Boolean(conversationMeta?.synthetic),
  };
}

function resolveAppendLineage(
  conversationMeta: ConversationMeta | null,
): Pick<AppendMetaDefaults, "parentAgentConversationId" | "parentConversationId" | "workspaceRoot" | "agent"> {
  return {
    parentAgentConversationId: conversationMeta?.parentAgentConversationId || null,
    parentConversationId: conversationMeta?.parentConversationId || null,
    workspaceRoot: conversationMeta?.workspaceRoot || null,
    agent: conversationMeta?.agent || null,
  };
}

function resolveAppendMetaDefaults(
  conversationMeta: ConversationMeta | null,
): AppendMetaDefaults {
  return {
    ...resolveAppendContentDefaults(conversationMeta),
    ...resolveAppendLineage(conversationMeta),
  };
}

/** $setOnInsert defaults for an auto-created conversation, minus every key already in $set. */
function buildAppendSetOnInsert(
  defaults: AppendMetaDefaults,
  traceId: string | null,
  now: string,
  setFields: Record<string, unknown>,
): Record<string, unknown> {
  const { title, systemPrompt, settings, parentAgentConversationId, parentConversationId } = defaults;

  const setOnInsert: Record<string, unknown> = {
    title,
    systemPrompt,
    settings: {
      ...settings,
      systemPrompt,
    },
    modalities: computeModalities([]),
    providers: extractProviders([], settings),
    totalCost: 0,
    isGenerating: true,
    ...(defaults.synthetic && { synthetic: true }),
    ...(traceId && { traceId }),
    ...(parentAgentConversationId && { parentAgentConversationId }),
    ...(parentConversationId && { parentConversationId }),
    ...(defaults.workspaceRoot && { workspaceRoot: defaults.workspaceRoot }),
    ...(defaults.agent && { agent: defaults.agent }),
    createdAt: now,
  };

  // MongoDB forbids the same field path in both $set and $setOnInsert.
  for (const key of Object.keys(setFields)) {
    delete setOnInsert[key];
  }
  return setOnInsert;
}

/** Assistant model names across live messages, falling back to the configured model. */
function collectModelNames(
  messages: unknown,
  settings: ConversationSettings | undefined,
): string[] {
  const modelNames = new Set<string>();
  for (const message of (messages as ChatMessage[]) || []) {
    if (message.deleted) continue;
    if (message.role === "assistant" && message.model) {
      modelNames.add(message.model as string);
    }
  }
  if (modelNames.size === 0 && settings?.model) {
    modelNames.add(settings.model as string);
  }
  return Array.from(modelNames);
}

/** Title to adopt from the first user message, or null when the title is already meaningful. */
function deriveTitleFromMessages(
  messages: unknown,
  currentTitle: unknown,
): string | null {
  if (currentTitle && currentTitle !== DEFAULT_CONVERSATION_TITLE) return null;
  const firstUserMessage = (messages as ChatMessage[] | undefined)?.find(
    (message) => message.role === "user",
  );
  if (!firstUserMessage?.content) return null;
  return firstUserMessage.content.slice(0, 100).trim() || null;
}

/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
const ConversationService: ConversationServiceInterface = {
  /**
   * Append messages to a conversation, auto-creating it if it doesn't exist.
   * Handles file extraction (MinIO upload) and recomputes derived fields.
   * Optionally applies conversation metadata (title, systemPrompt, settings).
   */
  async appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: Array<ChatMessage | MessagePayload>,
    conversationMeta: ConversationMeta | null = null,
    { collection = DEFAULT_COLLECTION }: { collection?: string } = {},
  ): Promise<TransformedConversation> {
    const traceId = conversationMeta?.traceId || null;
    const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, collection);

    // Extract files (upload base64 data to MinIO)
    const processedMessages = await extractFiles(
      newMessages,
      project,
      username,
    );

    const now = new Date().toISOString();

    // Build $set fields for metadata, then $setOnInsert for auto-creation
    // (stripped of any key already in $set — MongoDB forbids the same path in both).
    const setFields = buildAppendSetFields(conversationMeta, traceId, now);
    const setOnInsert = buildAppendSetOnInsert(
      resolveAppendMetaDefaults(conversationMeta),
      traceId,
      now,
      setFields,
    );

    // 1. Atomic upsert: push messages + set metadata in a single operation
    await dbCollection.updateOne(
      { id: conversationId, project, username },
      {
        $push: { messages: { $each: processedMessages } },
        $set: setFields,
        $setOnInsert: setOnInsert,
      } as import("mongodb").Document,
      { upsert: true },
    );

    // 2. Single re-read to compute derived fields
    const conversation = await dbCollection.findOne({
      id: conversationId,
      project,
      username,
    });

    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // 3. Recompute derived fields and persist
    const derived: Record<string, unknown> = {
      modalities: computeModalities(conversation.messages as ChatMessage[]),
      providers: extractProviders(
        conversation.messages as ChatMessage[],
        conversation.settings as ConversationSettings,
      ),
      totalCost: computeTotalCost(conversation.messages as ChatMessage[]),
      modelNames: collectModelNames(
        conversation.messages,
        conversation.settings as ConversationSettings | undefined,
      ),
    };

    // Auto-derive a descriptive title from the first user message
    const derivedTitle = deriveTitleFromMessages(
      conversation.messages,
      conversation.title,
    );
    if (derivedTitle) {
      derived.title = derivedTitle;
      conversation.title = derivedTitle; // Update local memory representation
    }

    await dbCollection.updateOne(
      { id: conversationId, project, username },
      { $set: derived },
    );

    // Return the doc with derived fields merged (avoids a third read)
    return { ...conversation, ...derived } as unknown as TransformedConversation;
  },

  /**
   * Set or clear the isGenerating flag on a conversation.
   * Lightweight update — only touches isGenerating + updatedAt.
   */
  async setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    {
      collection = DEFAULT_COLLECTION,
      agent,
      title,
      agentConversationId,
    }: { collection?: string; agent?: string; title?: string; agentConversationId?: string } = {},
  ): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const now = new Date().toISOString();

    if (generating) {
      // Upsert — create a stub if it doesn't exist yet
      await db.collection(collection).updateOne(
        { id: conversationId, project, username },
        {
          $set: {
            isGenerating: true,
            updatedAt: now,
            ...(agentConversationId && { agentConversationId }),
          },
          $setOnInsert: {
            title: title || DEFAULT_CONVERSATION_TITLE,
            messages: [],
            systemPrompt: "",
            settings: {},
            modalities: computeModalities([]),
            providers: [],
            totalCost: 0,
            ...(agent && { agent }),
            createdAt: now,
          },
        },
        { upsert: true },
      );
    } else {
      await db
        .collection(collection)
        .updateOne(
          { id: conversationId, project, username },
          { $set: { isGenerating: false, updatedAt: now } },
        );
    }
  },

  async getConversationStats(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<TransformedConversationStats | null> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return null;

    // Recursively discover all descendant conversation IDs (multi-level sub-agents)
    const allConversationIds = await discoverDescendantConversationIds(db, conversationId, {
      project,
      username,
    });

    const requests = await db
      .collection(COLLECTIONS.REQUESTS)
      .find({
        agentConversationId: { $in: [...allConversationIds] },
        project,
        username,
      })
      .project({
        estimatedCost: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 1,
        provider: 1,
        model: 1,
        operation: 1,
        timestamp: 1,
        modalities: 1,
        toolApiNames: 1,
        success: 1,
        agentConversationId: 1,
        parentAgentConversationId: 1,
      })
      .toArray();

    if (requests.length === 0) {
      return null;
    }

    // Aggregate
    const providers = new Set<string>();
    const models = new Set<string>();
    const operations = new Set<string>();
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let totalCacheCreationInputTokens = 0;
    let totalReasoningOutputTokens = 0;
    const mergedModalities: Record<string, boolean> = {};
    const toolCounts: Record<string, number> = {};
    let requestErrorCount = 0;

    for (const request of requests) {
      totalCost += request.estimatedCost || 0;
      totalInputTokens += request.inputTokens || 0;
      totalOutputTokens += request.outputTokens || 0;
      totalCacheReadInputTokens += request.cacheReadInputTokens || 0;
      totalCacheCreationInputTokens += request.cacheCreationInputTokens || 0;
      totalReasoningOutputTokens += request.reasoningOutputTokens || 0;
      if (request.provider) providers.add(request.provider);
      if (request.model) models.add(request.model);
      if (request.operation) operations.add(request.operation);
      // Merge modalities
      mergeRequestModalities(request.modalities, mergedModalities);
      // Count tool usage
      countRequestToolUsage(request.toolApiNames, toolCounts);
      if (request.success === false) {
        requestErrorCount++;
      }
    }

    const subAgentRequestCount = requests.filter(
      (reservation) => 
        reservation.agentConversationId !== conversationId,
    ).length;

    const createdAt = (requests as Record<string, unknown>[]).reduce(
      (min: string | null, r) =>
        !min || (r.timestamp as string) < min ? (r.timestamp as string) : min,
      null as string | null,
    );
    const updatedAt = (requests as Record<string, unknown>[]).reduce(
      (max: string | null, r) =>
        !max || (r.timestamp as string) > max ? (r.timestamp as string) : max,
      null as string | null,
    );

    // Wall-clock elapsed time: from first request to last request (includes sub-agents)
    const totalElapsedTime =
      createdAt && updatedAt
        ? Math.max(
            0,
            (new Date(updatedAt as string).getTime() -
              new Date(createdAt as string).getTime()) /
              1000,
          )
        : 0;

    return {
      agentConversationId: conversationId,
      requestCount: requests.length,
      subAgentRequestCount,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCacheReadInputTokens,
      totalCacheCreationInputTokens,
      totalReasoningOutputTokens,
      providers: [...providers],
      models: [...models],
      operations: [...operations],
      modalities: mergedModalities,
      toolCounts,
      requestErrorCount,
      totalElapsedTime,
      createdAt,
      updatedAt,
    };
  },

  /**
   * Prior conversation history — the seed for run resumes
   * (RunRequestSchema.resume_conversation_id). Assistant tool turns keep
   * their toolCalls, and each call is followed by its result: the stored
   * tool message when there is one, else the result embedded in the call
   * (how the harnesses persist it). Malformed entries are skipped, never
   * thrown; the result is role-alternation normalized.
   */
  async getMessages(conversationId, project, username) {
    const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, DEFAULT_COLLECTION);
    const doc = await dbCollection.findOne(
      { id: conversationId, project, username },
      { projection: { messages: 1 } },
    );
    return buildResumeMessages(((doc?.messages as ChatMessage[]) || []));
  },
};

export default ConversationService;

const stringify = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/** Merge one request's modality flags into the conversation-wide map. */
function mergeRequestModalities(
  modalities: Record<string, unknown> | null | undefined,
  mergedModalities: Record<string, boolean>,
): void {
  if (modalities) {
    for (const [k, value] of Object.entries(modalities)) {
      if (value) mergedModalities[k] = true;
    }
  }
}

/** Count one request's tool invocations into the conversation-wide tally. */
function countRequestToolUsage(
  toolApiNames: string[] | null | undefined,
  toolCounts: Record<string, number>,
): void {
  if (toolApiNames && toolApiNames.length > 0) {
    for (const name of toolApiNames) {
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
  }
}

interface ResumeToolCallPair {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Valid assistant tool calls as resume pairs; the fallback id keeps `outLength` stable. */
function buildResumeToolCallPairs(
  calls: Array<Record<string, unknown>>,
  outLength: number,
): ResumeToolCallPair[] {
  return calls
    .filter((call) => typeof call?.name === "string")
    .map((call, index) => ({
      id: typeof call.id === "string" && call.id ? call.id : `resume_${outLength}_${index}`,
      name: call.name as string,
      args: (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>,
      result: call.result,
    }));
}

/** Emit one tool message per call, reusing the stored result when there is one. */
function pushResumeToolResults(
  out: ResumeMessage[],
  pairs: ResumeToolCallPair[],
  storedToolResults: Map<string, string>,
): void {
  for (const pair of pairs) {
    const stored = storedToolResults.get(pair.id);
    out.push({
      role: "tool",
      tool_call_id: pair.id,
      content: stored ?? (pair.result === undefined || pair.result === null ? "[result not recorded]" : stringify(pair.result)),
    });
  }
}

/** Stored messages → resume messages with intact call/result pairs (exported for tests). */
export function buildResumeMessages(stored: ChatMessage[]): ResumeMessage[] {
  const out: ResumeMessage[] = [];
  const storedToolResults = new Map<string, string>();
  for (const m of stored) {
    const record = m as unknown as Record<string, unknown>;
    if (m?.role === "tool" && typeof record.tool_call_id === "string") {
      storedToolResults.set(record.tool_call_id, stringify(m.content));
    }
  }
  for (const m of stored) {
    const record = m as unknown as Record<string, unknown>;
    const role = m?.role;
    const content = typeof m?.content === "string" ? m.content : "";
    if (role === "tool") continue; // re-emitted right after its call below
    const calls = Array.isArray(record.toolCalls) ? (record.toolCalls as Array<Record<string, unknown>>) : [];
    if (role === "assistant" && calls.length > 0) {
      const pairs = buildResumeToolCallPairs(calls, out.length);
      if (pairs.length === 0) {
        if (content) out.push({ role, content });
        continue;
      }
      out.push({ role, content, toolCalls: pairs.map(({ id, name, args }) => ({ id, name, args })) });
      pushResumeToolResults(out, pairs, storedToolResults);
      continue;
    }
    if ((role === "system" || role === "user" || role === "assistant") && content) out.push({ role, content });
  }
  return normalizeRoleAlternation(out as unknown as ConversationMessage[]).messages as unknown as ResumeMessage[];
}
