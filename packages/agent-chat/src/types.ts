/**
 * Canonical types and state interfaces for @lazycat/agent-chat
 * Grounded in agent-runtime-contract-v1.md and run-contract-v1.json
 */

import type { RuntimeEvent } from './generated-contract.js';
export type { CanonicalEventType } from './generated-contract.js';
export type RunEvent<T = Record<string, any>> = Omit<RuntimeEvent<T>, 'type'> & {
  type: RuntimeEvent['type'] | (string & {});
  seq?: number;
};

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'incomplete';

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  category?: 'CLIENT' | 'RUNTIME' | 'PROVIDER' | 'TOOL' | 'POLICY' | 'RESOURCE';
  details?: Record<string, any>;
}

export interface RunReceipt {
  context_receipt?: Record<string, any>;
  evidence_records?: any[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    tool_calls_count?: number;
    retry_count?: number;
    duration_ms?: number;
  };
}

export interface ToolActivityState {
  toolId: string;
  toolName: string;
  args: Record<string, any>;
  status: 'invoked' | 'executing' | 'completed' | 'failed';
  output?: any;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export interface WorkerActivityState {
  workerId: string;
  stage: string;
  status: 'dispatched' | 'running' | 'completed' | 'failed';
  progress?: number;
  output?: any;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ChatMessage {
  id: string;
  runId?: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  status: MessageStatus;
  toolCallIds?: string[];
  workerIds?: string[];
  error?: StructuredError;
  receipt?: RunReceipt;
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface ChatState {
  eventCursors: Record<string, string>;
  seenEventIds: Record<string, string[]>;
  runSequences: Record<string, number>;
  sealedRuns: Record<string, boolean>;
  unknownEvents: RunEvent[];
  approvals: Record<string, Record<string, any>>;
  cancellationRequested: boolean;
  steering: { accepted: boolean; delivery?: string } | null;
  draftInput: string;
  transcript: ChatMessage[];
  pendingRun: {
    runId: string;
    profileId?: string;
    status: string;
    startedAt: string;
  } | null;
  eventSequenceCursor: number;
  toolActivities: Record<string, ToolActivityState>;
  workerActivities: Record<string, WorkerActivityState>;
  terminalReceipt: RunReceipt | null;
  error: StructuredError | null;
  connectionStatus: ConnectionStatus;
}

export const INITIAL_CHAT_STATE: ChatState = {
  eventCursors: {}, seenEventIds: {}, runSequences: {}, sealedRuns: {},
  unknownEvents: [], approvals: {}, cancellationRequested: false, steering: null,
  draftInput: '',
  transcript: [],
  pendingRun: null,
  eventSequenceCursor: 0,
  toolActivities: {},
  workerActivities: {},
  terminalReceipt: null,
  error: null,
  connectionStatus: 'idle',
};
