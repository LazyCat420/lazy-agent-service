/**
 * First-party chat UI for lazy-agent-service, served at /chat.
 *
 * State logic lives in @lazycat/agent-chat (reducer + turnTransport +
 * presentation). This file is only DOM wiring, the SSE fetch loop, and the
 * reconnect/reconcile client half (see reconcile.ts for the testable parts).
 */

import {
  ChatClientController,
  INITIAL_CHAT_STATE,
  THINKING_DOTS_CSS,
  buildTurnPayload,
  ingestStreamClosed,
  ingestTurnEvent,
  readSSE,
  renderActivityIndicator,
  type PresentationSnapshot,
  type TurnSettings,
  type WireTurnEvent,
} from "../../../packages/agent-chat/dist/index.js";
import {
  drainSendQueue,
  reconcileAfterStreamClose,
  type ConversationSnapshotDoc,
} from "./reconcile.js";

// ─── localStorage keys (raw keys replicated from prism-client constants.ts) ──
const LOCAL_STORAGE_KEY_WORKSPACE_ROOT = "prism:workspace";
const LOCAL_STORAGE_KEY_USERNAME = "prism:username";
const LOCAL_STORAGE_KEY_ACTIVE_PROFILE = "prism:profile";
const DEFAULT_PROFILE_ID = "default";
// First-party continuity keys.
const LOCAL_STORAGE_KEY_CONVERSATION = "lazychat:conversation";
const LOCAL_STORAGE_KEY_SETTINGS = "lazychat:settings";

/** x-project value; authMiddleware falls back to DEFAULT_PROJECT anyway. */
const PROJECT_NAME = "default";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const transcriptEl = $<HTMLElement>("transcript");
const activityEl = $<HTMLElement>("activity");
const bannerEl = $<HTMLElement>("status-banner");
const recoveryEl = $<HTMLElement>("recovery-banner");
const inputEl = $<HTMLTextAreaElement>("composer-input");
const sendBtn = $<HTMLButtonElement>("btn-send");
const stopBtn = $<HTMLButtonElement>("btn-stop");
const reconcileBtn = $<HTMLButtonElement>("reconcile-btn");
const agentToggle = $<HTMLInputElement>("toggle-agent");
const thinkingToggle = $<HTMLInputElement>("toggle-thinking");
const modelInput = $<HTMLInputElement>("input-model");
const convLabel = $<HTMLElement>("conversation-label");

const controller = new ChatClientController({ ...INITIAL_CHAT_STATE });

// ─── Identity headers (serviceHeaders.ts pattern) ─────────────────

function getBaseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-project": PROJECT_NAME,
  };
  const workspaceRoot = localStorage.getItem(LOCAL_STORAGE_KEY_WORKSPACE_ROOT);
  if (workspaceRoot) headers["x-workspace-root"] = workspaceRoot;
  const username = localStorage.getItem(LOCAL_STORAGE_KEY_USERNAME);
  if (username) headers["x-username"] = username;
  const profileId = localStorage.getItem(LOCAL_STORAGE_KEY_ACTIVE_PROFILE);
  if (profileId && profileId !== DEFAULT_PROFILE_ID) headers["x-profile-id"] = profileId;
  return headers;
}

// ─── Conversation continuity ──────────────────────────────────────

function resolveConversationId(): string {
  const fromUrl = new URLSearchParams(location.search).get("conversation");
  if (fromUrl) {
    localStorage.setItem(LOCAL_STORAGE_KEY_CONVERSATION, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(LOCAL_STORAGE_KEY_CONVERSATION);
  if (stored) return stored;
  const fresh = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(LOCAL_STORAGE_KEY_CONVERSATION, fresh);
  history.replaceState(null, "", `?conversation=${encodeURIComponent(fresh)}`);
  return fresh;
}

let conversationId = resolveConversationId();
convLabel.textContent = conversationId;

function persistConversationId(): void {
  localStorage.setItem(LOCAL_STORAGE_KEY_CONVERSATION, conversationId);
  const url = new URL(location.href);
  url.searchParams.set("conversation", conversationId);
  history.replaceState(null, "", url);
}

function loadSettings(): { model: string; thinking: boolean } {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY_SETTINGS);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore malformed */ }
  return { model: "", thinking: false };
}
const savedSettings = loadSettings();
modelInput.value = savedSettings.model ?? "";
thinkingToggle.checked = savedSettings.thinking ?? false;

function saveSettings(): void {
  localStorage.setItem(
    LOCAL_STORAGE_KEY_SETTINGS,
    JSON.stringify({ model: modelInput.value.trim(), thinking: thinkingToggle.checked }),
  );
}

// ─── Turn streaming ───────────────────────────────────────────────

const sendQueue: string[] = [];
let abortController: AbortController | null = null;

function currentSettings(): TurnSettings {
  const model = modelInput.value.trim();
  return {
    ...(model ? { model } : {}),
    thinkingEnabled: thinkingToggle.checked,
  };
}

function traceId(): string | null {
  const existing = sessionStorage.getItem("lazychat:traceId");
  if (existing) return existing;
  const fresh = `trace_${crypto.randomUUID()}`;
  sessionStorage.setItem("lazychat:traceId", fresh);
  return fresh;
}

function isTerminalWireEvent(event: WireTurnEvent): boolean {
  return event.type === "done" || event.type === "error";
}

/** POST the turn and ingest every wire event until the stream ends. */
async function runTurn(content: string): Promise<void> {
  const { path, payload } = buildTurnPayload({
    isNoAgent: !agentToggle.checked,
    settings: currentSettings(),
    messages: [{ role: "user", content }],
    disabledTools: [],
    conversationId,
    traceId: traceId(),
    agentId: "agentless",
    agentProject: PROJECT_NAME,
    activeRuleNames: [],
    permissionMode: "default",
    planFirst: false,
    maxIterations: 0,
    maxSubAgentIterations: 0,
    maxRecursionDepth: 0,
  });

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { ...getBaseHeaders(), Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: abortController?.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Turn request failed: HTTP ${response.status}`);
    }
    for await (const value of readSSE(response.body)) {
      // Turn SSE frames are wire events ({type, seq, ...}); the canonical
      // parseRunEvent envelope only applies to replay endpoints.
      controller.replaceState(ingestTurnEvent(controller.getState(), value as WireTurnEvent));
      if (isTerminalWireEvent(value as WireTurnEvent)) break;
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    controller.setConnectionStatus("error");
    await recoverFromStreamDrop(true);
    return;
  }

  // Stream ended. If the server never sent a terminal event, the connection
  // dropped mid-turn — reconcile from the persisted snapshot.
  const state = controller.getState();
  if (state.pendingRun) {
    controller.replaceState(ingestStreamClosed(state));
    await recoverFromStreamDrop(true);
  } else {
    controller.setConnectionStatus("idle");
  }
  drainQueue();
}

// ─── Recovery: refetch snapshot, reconcile, drain queue ───────────

async function fetchConversationSnapshot(): Promise<ConversationSnapshotDoc | null> {
  try {
    const response = await fetch(`/conversations/${encodeURIComponent(conversationId)}`, {
      headers: getBaseHeaders(),
    });
    if (!response.ok) return null;
    return (await response.json()) as ConversationSnapshotDoc;
  } catch {
    return null;
  }
}

async function recoverFromStreamDrop(showBanner: boolean): Promise<void> {
  if (showBanner) recoveryEl.hidden = false;
  // Give the server finalizer a moment (persistOnDisconnect) before refetching.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 1500);
  await promise;
  const doc = await fetchConversationSnapshot();
  if (doc) {
    controller.replaceState(reconcileAfterStreamClose(controller.getState(), doc));
  } else {
    controller.setConnectionStatus("disconnected");
  }
  recoveryEl.hidden = true;
  drainQueue();
}

function drainQueue(): void {
  const snapshot = controller.getSnapshot();
  const toSend = drainSendQueue(sendQueue, snapshot.canSend);
  if (toSend.length === 0) return;
  // Remove only the drained prefix; if a submit re-queues (canSend flipped
  // back to false mid-drain) the remaining items stay for the next attempt.
  sendQueue.splice(0, toSend.length);
  for (const content of toSend) submit(content);
}

// ─── Sending / stopping ───────────────────────────────────────────

function submit(content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const snapshot = controller.getSnapshot();
  if (!snapshot.canSend) {
    sendQueue.push(trimmed);
    inputEl.value = "";
    return;
  }
  abortController = new AbortController();
  controller.submitUserMessage(trimmed);
  void runTurn(trimmed);
}

async function stopTurn(): Promise<void> {
  controller.cancel();
  abortController?.abort();
  try {
    await fetch("/agent/stop", {
      method: "POST",
      headers: getBaseHeaders(),
      body: JSON.stringify({ conversationId }),
    });
  } catch { /* best-effort */ }
}

// ─── Rendering ────────────────────────────────────────────────────

const MESSAGE_SHOWN: Record<string, true> = {
  pending: true,
  streaming: true,
  completed: true,
  failed: true,
  cancelled: true,
  incomplete: true,
};

function render(snapshot: PresentationSnapshot): void {
  // Inject the package's indicator CSS once (thinking dots + activity rows).
  const doc = transcriptEl.ownerDocument!;
  if (!doc.getElementById("agent-chat-css")) {
    const style = doc.createElement("style");
    style.id = "agent-chat-css";
    style.textContent = THINKING_DOTS_CSS;
    doc.head.appendChild(style);
  }

  const nodes: Node[] = [];
  for (const message of snapshot.messages) {
    if (!MESSAGE_SHOWN[message.status]) continue;
    const div = doc.createElement("div");
    div.className = "message";
    div.dataset.role = message.role;
    div.dataset.status = message.status;
    div.textContent = message.content;
    const meta = doc.createElement("span");
    meta.className = "meta";
    meta.textContent = `${message.role} · ${message.status}`;
    div.appendChild(meta);
    nodes.push(div);
  }
  transcriptEl.replaceChildren(...nodes);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  renderActivityIndicator(activityEl, snapshot);

  const banner = snapshot.statusBanner;
  bannerEl.hidden = !banner;
  if (banner) {
    bannerEl.textContent = banner.text;
    bannerEl.dataset.type = banner.type;
  }

  // Send stays enabled: submit() queues while a turn is in flight and the
  // queue drains on turn completion / recovery.
  sendBtn.disabled = false;
  stopBtn.hidden = !snapshot.canCancel;
  if (snapshot.canSend && sendQueue.length > 0) drainQueue();
}

controller.subscribe(render);

// ─── Events ───────────────────────────────────────────────────────

sendBtn.addEventListener("click", () => {
  submit(inputEl.value);
  inputEl.value = "";
});
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit(inputEl.value);
    inputEl.value = "";
  }
});
inputEl.addEventListener("input", () => controller.setDraftInput(inputEl.value));
stopBtn.addEventListener("click", () => void stopTurn());
reconcileBtn.addEventListener("click", () => void recoverFromStreamDrop(true));
agentToggle.addEventListener("change", saveSettings);
thinkingToggle.addEventListener("change", saveSettings);
modelInput.addEventListener("change", saveSettings);

// Tab-switch / focus / reconnect recovery. Never run while a turn is
// actively streaming — the refetch would tear down live state.
function maybeRecoverOnFocus(): void {
  const status = controller.getState().connectionStatus;
  if (status === "streaming" || status === "connecting") return;
  void recoverFromStreamDrop(false);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") maybeRecoverOnFocus();
});
window.addEventListener("focus", maybeRecoverOnFocus);
window.addEventListener("online", maybeRecoverOnFocus);

render(controller.getSnapshot());
