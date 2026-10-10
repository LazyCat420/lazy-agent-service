---
part: Features
status: verified
updated: 2026-10-10
---

# First-Party Chat UI + Disconnect-Safe Persistence (2026-10-10)

Mode: Implement. Repo: `lazy-agent-service`. prism-client untouched.

## Problem

When a user left the chat tab and returned, messages failed to send. Root causes (all
evidence-backed, see diagnosis transcript `history://GLM-ChatTabResumeDiag`):

1. Client: `pendingRun` cleared only on terminal events — a dropped connection set
   `canSend=false` forever; sends silently returned `''`.
2. Server: `POST /chat` SSE aborted generation on client disconnect
   (`persistOnDisconnect=false`), unlike `/agent`.
3. No replay for chat; user+assistant messages persisted only at finalize, and the
   abort-throw path persisted nothing.

## Changes

### Server — `src/routes/ChatRoutes.ts`
- `/chat` SSE passes `persistOnDisconnect: true` (mirrors `AgentRoutes.ts`), so a
  dropped connection no longer truncates generation.
- `handleStreamingText` records `partialAssistantText` before rethrowing; the
  `handleConversation` catch path persists user + partial assistant message via
  `appendAndFinalize` — never skipped on `signal.aborted`.
- Test: `src/routes/__tests__/ChatSsePersistOnDisconnect.test.ts` (red→green; 203
  touched-area tests pass).

### Package — `packages/agent-chat@0.3.0`
- `src/turnTransport.ts`: `buildTurnPayload`, `ingestTurnEvent`, `ingestStreamClosed` —
  maps the prism turn-stream wire taxonomy onto the reducer; unknown events counted in
  `state.unrecognizedEvents`. Fixtures in `test/fixtures/turn-events/`.
- `src/presentation.ts`: `activityFeed` (chronological thinking/tool/worker/status rows
  with durations), `THINKING_DOTS_CSS`/`THINKING_DOTS_CLASS`, `renderActivityIndicator`.
- Tests: 34/34 package-wide.

### UI — served at `GET /chat` (`public/chat/`, esbuild bundle)
- Transcript, composer, send/stop, agent/model/thinking toggles, conversation continuity
  (`?conversation=` + `lazychat:conversation` localStorage), identity headers
  (`x-project`, `x-workspace-root`, `x-username`, `x-profile-id`).
- Animated `. .. ...` thinking indicator + live activity feed rows ("Running tool: X",
  "Tool X done (1.2s)", worker stages) under the streaming message.
- Tab-switch recovery: SSE drop → `ingestStreamClosed` → retry banner → refetch
  `GET /conversations/:id` → `mergeConversationSnapshot` reconcile → queued sends drained.
- Tests: `test/chat-ui/reconcile.test.ts` (11). Full suite: 1336 tests green.

## Verification
- Smoke (mock SSE server `scripts/chat-ui-smoke-server.mjs`): happy path shows dots +
  activity rows + stop button; drop path reconciles after refetch; queue drains. 18
  browser tabs closed after.
- Deploy fixed: `esbuild` was missing from devDependencies (container `pnpm run build`
  exit 127) — added in commit 5609fea.

## Non-goals
prism-client changes, WS `/ws/chat` live-view, runs-API Last-Event-ID replay for chat.
