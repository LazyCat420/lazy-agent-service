import {
  ChatState,
  RunEvent,
  INITIAL_CHAT_STATE,
  ChatMessage,
} from './types.js';
import { reduceChatEvent } from './reducer.js';
import {
  PresentationSnapshot,
  toPresentationSnapshot,
} from './presentation.js';

export type ChatStateSubscriber = (
  snapshot: PresentationSnapshot,
  rawState: ChatState
) => void;

/**
 * Framework-neutral chat controller for orchestrating chat sessions,
 * optimistic input handling, event ingestion, cancellation, and subscriber notifications.
 */
export class ChatClientController {
  private state: ChatState;
  private subscribers: Set<ChatStateSubscriber> = new Set();
  private abortController: AbortController | null = null;

  constructor(initialState: ChatState = INITIAL_CHAT_STATE) {
    this.state = { ...initialState };
  }

  public getState(): ChatState {
    return this.state;
  }

  public getSnapshot(): PresentationSnapshot {
    return toPresentationSnapshot(this.state);
  }

  public subscribe(subscriber: ChatStateSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getSnapshot(), this.state);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(snapshot, this.state);
      } catch (err) {
        console.error('Error in ChatClientController subscriber:', err);
      }
    }
  }

  /**
   * Optimistically appends a user message and marks the session as connecting.
   */
  public submitUserMessage(content: string, options: { runId?: string } = {}): string {
    const trimmed = content.trim();
    if (!trimmed || !this.getSnapshot().canSend) return '';

    const messageId = `msg_user_${Date.now()}`;
    const userMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
      status: 'completed',
    };

    this.abortController = new AbortController();

    this.state = {
      ...this.state,
      draftInput: '',
      connectionStatus: 'connecting',
      error: null,
      terminalReceipt: null, cancellationRequested: false, steering: null,
      transcript: [...this.state.transcript, userMessage],
      pendingRun: options.runId
        ? {
            runId: options.runId,
            status: 'initiating',
            startedAt: new Date().toISOString(),
          }
        : null,
    };

    this.notify();
    return messageId;
  }

  /**
   * Ingests a canonical RunEvent from SSE or WebSocket stream and updates state.
   */
  public ingestEvent(event: RunEvent): void {
    this.state = reduceChatEvent(this.state, event);
    this.notify();
  }

  /**
   * Cancels in-flight run and updates local state.
   */
  public cancel(): void {
    // A local request is not evidence that execution stopped. Keep receiving
    // events until the authoritative terminal event, including completion races.
    this.state = { ...this.state, cancellationRequested: !!this.state.pendingRun };
    this.notify();
  }

  public acknowledgeSteering(accepted: boolean, delivery?: string): void {
    this.state = { ...this.state, steering: { accepted, delivery } };
    this.notify();
  }

  public setConnectionStatus(connectionStatus: ChatState['connectionStatus']): void {
    this.state = { ...this.state, connectionStatus };
    this.notify();
  }

  public replayCursor(runId: string): string | undefined {
    return this.state.eventCursors[runId];
  }

  public getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  public setDraftInput(text: string): void {
    this.state = {
      ...this.state,
      draftInput: text,
    };
    this.notify();
  }
}
