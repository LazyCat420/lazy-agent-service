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
  /** LF-06: "synthetic" = loop-built digest, "partial" = cut-off/incomplete model text. */
  answerSource?: "model" | "synthetic" | "partial";
  /** LF-06: why the agent loop finalized; "COMPLETED" on a clean finish. */
  finalizeReason?: string;
  /** LF-07: total provider calls for the run, retries included (>= 1). */
  providerAttempts?: number;
  /** LF-07: provider calls that were retries (>= 0). */
  providerRetries?: number;
}
