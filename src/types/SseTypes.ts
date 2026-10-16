export interface SseEvent {
  type: string;
  content?: string;
  message?: string;
  /** HTTP status for `error` events; non-streaming callers answer with it. */
  statusCode?: number;
  data?: string;
  mimeType?: string;
  minioRef?: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  };
  status?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
  estimatedCost?: number;
  audioRef?: string;
  traceId?: string;
  conversationId?: string;
}
