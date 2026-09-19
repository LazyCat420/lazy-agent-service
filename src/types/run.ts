export interface RunBudget {
  maxTokens?: number;
  maxToolCalls?: number;
  maxRetries?: number;
  maxDurationMs?: number;
}

export interface CreateRunRequest {
  profileId: string;
  input: string | any[];
  model?: string;
  budget?: RunBudget;
  tools?: any[];
  stream?: boolean;
}

export type RunEventType =
  | 'run.created'
  | 'run.started'
  | 'message.delta'
  | 'message.completed'
  | 'tool.called'
  | 'tool.result'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface RunEvent {
  id: string;
  runId: string;
  type: RunEventType;
  data: any;
  timestamp: string;
}

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details?: any;
}

export interface RunResult {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  messages: any[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    toolCalls: number;
  };
  error?: StructuredError;
}
