import type { ChatMessage } from "../../types/admin.ts";

export interface ConversationMeta {
  title?: string;
  systemPrompt?: string;
  settings?: ConversationSettings;
  traceId?: string | null;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
  workspaceRoot?: string | null;
  synthetic?: boolean;
  agent?: string | null;
}

export interface ConversationSettings {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  [key: string]: unknown;
}

export interface ConversationPatchInput {
  title?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ConversationPatchFields {
  updatedAt: string;
  title?: string;
  messages?: ChatMessage[];
  modalities?: Record<string, boolean>;
  providers?: string[];
  totalCost?: number;
  modelNames?: string[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ToolCallPayload {
  name: string;
  id?: string | null;
  args?: Record<string, unknown> | string;
  thoughtSignature?: string;
  durationMs?: number;
}

export interface MessagePayload {
  role: string;
  content?: string | unknown[] | null;
  rawContent?: string;
  images?: string[] | unknown[];
  audio?: string | unknown[];
  video?: string | unknown[];
  pdf?: string | unknown[];
  toolCalls?: ToolCallPayload[];
  thinking?: string;
  isCompactSummary?: boolean;
  _isInjectedContext?: boolean;
  _isPlanningInjection?: boolean;
  _alreadyPersisted?: boolean;
  [key: string]: unknown;
}

export interface TransformedConversation {
  id: string;
  project: string;
  username: string;
  title: string;
  messages: ChatMessage[];
  systemPrompt: string;
  settings: ConversationSettings;
  modalities: Record<string, boolean>;
  providers: string[];
  totalCost: number;
  modelNames: string[];
  isGenerating: boolean;
  synthetic?: boolean;
  traceId?: string | null;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
  workspaceRoot?: string | null;
  agent?: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown; // Allow extra MongoDB properties dynamically
}

export interface TransformedConversationStats {
  agentConversationId: string;
  requestCount: number;
  subAgentRequestCount: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningOutputTokens: number;
  providers: string[];
  models: string[];
  operations: string[];
  modalities: Record<string, boolean>;
  toolCounts: Record<string, number>;
  requestErrorCount: number;
  totalElapsedTime: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationServiceInterface {
  appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: Array<ChatMessage | MessagePayload>,
    conversationMeta?: ConversationMeta | null,
    options?: { collection?: string },
  ): Promise<TransformedConversation>;
  setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    options?: { collection?: string; agent?: string; title?: string; agentConversationId?: string },
  ): Promise<void>;
  getConversationStats(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<TransformedConversationStats | null>;
  getMessages(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<{ role: "system" | "user" | "assistant" | "tool"; content: string }[]>;
}
