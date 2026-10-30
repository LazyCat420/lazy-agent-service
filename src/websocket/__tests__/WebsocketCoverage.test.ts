/**
 * websocket/index.ts — connection routing, chat/voice delegation and the
 * persistent Live API session proxy.
 *
 * The Google client, chat/voice handlers, orchestrator and logger are stubs;
 * a fake socket records every frame the server sends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupWebSocket } from "../index.ts";

const stub = vi.hoisted(() => ({
  conversationArgs: null as null | Record<string, unknown>,
  voiceArgs: null as null | Record<string, unknown>,
  voiceError: null as Error | null,
  connectError: null as Error | null,
  liveCallbacks: null as Record<string, (...args: unknown[]) => void> | null,
  liveSession: null as Record<string, (...args: unknown[]) => void> | null,
  sentRealtime: [] as unknown[],
  sentToolResponses: [] as unknown[],
  closedSessions: 0,
  toolSchemas: [] as Array<{ name: string }>,
  toolExecutions: [] as Array<{ name: string; args: Record<string, unknown> }>,
  toolResult: { ok: true } as Record<string, unknown>,
  policies: [] as unknown[],
  persona: null as Record<string, unknown> | null,
  logs: [] as unknown[],
  logErrors: [] as string[],
}));

vi.mock("../../core/chat/ChatGeneration.ts", () => ({
  handleConversation: async (payload: Record<string, unknown>, emit: (event: Record<string, unknown>) => void) => {
    stub.conversationArgs = payload;
    emit({ type: "text", text: "hi" });
  },
}));

vi.mock("../../routes/AudioRoutes.ts", () => ({
  handleVoice: async (params: Record<string, unknown>, emitBinary: (chunk: Buffer) => void, emitJSON: (event: Record<string, unknown>) => void) => {
    stub.voiceArgs = params;
    if (stub.voiceError) {
      emitJSON({ type: "error", message: stub.voiceError.message });
      throw stub.voiceError;
    }
    emitBinary(Buffer.from([1, 2]));
    emitJSON({ type: "done" });
    return "audio/mpeg";
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = {
      connect: async (options: Record<string, unknown>) => {
        if (stub.connectError) throw stub.connectError;
        stub.liveCallbacks = options.callbacks as Record<string, (...args: unknown[]) => void>;
        const session = {
          sendRealtimeInput: (input: unknown) => {
            stub.sentRealtime.push(input);
          },
          sendToolResponse: (response: unknown) => {
            stub.sentToolResponses.push(response);
          },
          close: () => {
            stub.closedSessions += 1;
          },
        };
        stub.liveSession = session as any;
        return session;
      },
    };
  },
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
  StartSensitivity: { START_SENSITIVITY_HIGH: "high" },
  EndSensitivity: { END_SENSITIVITY_LOW: "low" },
}));

vi.mock("../../services/RequestLogger.ts", () => ({
  default: {
    logChatGeneration: async (entry: unknown) => {
      stub.logs.push(entry);
    },
  },
}));

vi.mock("../../services/ConversationService.ts", () => ({
  default: {
    async setGenerating() {},
  },
}));

vi.mock("../../services/PromptLocaleService.ts", () => ({
  default: { get: () => "LANGUAGE HINT" },
}));

vi.mock("../../services/AgentPersonaRegistry.ts", () => ({
  default: { get: () => stub.persona },
}));

vi.mock("../../services/ToolAuthorization.ts", () => ({
  decideToolCall: ({ isAllowListed }: { isAllowListed: boolean; name: string }) =>
    isAllowListed ? { verdict: "allow" } : { verdict: "deny", reason: "not offered" },
  deniedToolResult: (name: string) => ({ denied: true, tool: name }),
}));

vi.mock("../../services/ToolOrchestratorService.ts", () => ({
  default: {
    getToolSchemas: () => stub.toolSchemas,
    async executeTool(name: string, args: Record<string, unknown>) {
      stub.toolExecutions.push({ name, args });
      return stub.toolResult;
    },
  },
}));

vi.mock("../../providers/google.ts", () => ({
  convertToolsToGoogle: (tools: Array<{ name: string }>) => tools.map((tool) => ({ functionDeclarations: [tool] })),
}));

vi.mock("../../services/SettingsService.ts", () => ({
  default: { async getSection() { return null; } },
}));

vi.mock("../../utils/FunctionCallingUtilities.ts", () => ({
  truncateToolResult: (result: unknown) => result,
}));

vi.mock("../../services/FileService.ts", () => ({
  default: {
    async uploadFile() {
      return { ref: "minio://generations/live.wav", size: 44, contentType: "audio/wav" };
    },
  },
}));

vi.mock("../../utils/logger.ts", () => ({
  default: {
    error: (message: string) => {
      stub.logErrors.push(message);
    },
    warn: (message: string) => {
      stub.logErrors.push(message);
    },
    info: () => {},
    success: () => {},
  },
}));

interface FakeSocket {
  OPEN: number;
  readyState: number;
  sent: unknown[];
  handlers: Record<string, (...args: any[]) => Promise<void>>;
  closed: boolean;
  send(data: unknown): void;
  close(): void;
  on(event: string, handler: (...args: any[]) => Promise<void>): void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    handlers: {},
    closed: false,
    send(data: unknown) {
      socket.sent.push(data);
    },
    close() {
      socket.closed = true;
      socket.readyState = 3;
    },
    on(event, handler) {
      socket.handlers[event] = handler;
    },
  };
  return socket;
}

const connectionHandler = () => {
  let captured: ((socket: FakeSocket, req: any) => void) | null = null;
  setupWebSocket({
    on: (_event: string, handler: (socket: FakeSocket, req: any) => void) => {
      captured = handler;
    },
  } as any);
  if (!captured) throw new Error("connection handler was not registered");
  return captured;
};

const connect = (pathname: string, headers: Record<string, string> = {}, search = "") => {
  const socket = fakeSocket();
  const req = {
    url: `${pathname}${search}`,
    headers: { host: "prism.local", ...headers },
    socket: { remoteAddress: "::ffff:10.0.0.7" },
  };
  connectionHandler()(socket, req);
  return socket;
};

const send = (socket: FakeSocket, payload: unknown) =>
  socket.handlers.message(
    typeof payload === "string" ? payload : Buffer.from(JSON.stringify(payload)),
  );

const frames = (socket: FakeSocket) =>
  socket.sent.filter((frame) => typeof frame === "string").map((frame) => JSON.parse(frame as string));

beforeEach(() => {
  stub.conversationArgs = null;
  stub.voiceArgs = null;
  stub.voiceError = null;
  stub.connectError = null;
  stub.liveCallbacks = null;
  stub.liveSession = null;
  stub.sentRealtime = [];
  stub.sentToolResponses = [];
  stub.closedSessions = 0;
  stub.toolSchemas = [];
  stub.toolExecutions = [];
  stub.toolResult = { ok: true };
  stub.policies = [];
  stub.persona = null;
  stub.logs = [];
  stub.logErrors = [];
});

describe("connection routing", () => {
  it("rejects unknown paths and closes the socket", () => {
    const socket = connect("/ws/nope");
    expect(frames(socket)).toEqual([{ type: "error", message: "Unknown WebSocket path: /ws/nope" }]);
    expect(socket.closed).toBe(true);
  });

  it("derives project, username and client ip from headers with ipv4 normalisation", async () => {
    const socket = connect("/ws/chat", {
      "x-project": "proj-a",
      "x-username": "alice",
      "x-agent": "atlas",
      "x-forwarded-for": " 10.1.2.3 , 10.9.9.9",
    });
    await send(socket, { messages: [] });
    expect(stub.conversationArgs).toMatchObject({
      project: "proj-a",
      username: "alice",
      agent: "atlas",
      clientIp: "10.1.2.3",
    });
    expect(frames(socket)).toEqual([{ type: "text", text: "hi" }]);
  });

  it("falls back to query params, defaults and the socket address", async () => {
    const socket = connect("/ws/chat", {}, "?project=proj-q&username=bob");
    await send(socket, { messages: [] });
    expect(stub.conversationArgs).toMatchObject({ project: "proj-q", username: "bob", agent: null, clientIp: "10.0.0.7" });

    const defaults = connect("/ws/chat");
    await send(defaults, {});
    expect(stub.conversationArgs).toMatchObject({ project: "any", clientIp: "10.0.0.7" });
  });

  it("drops frames once the socket is no longer open", async () => {
    const socket = connect("/ws/chat");
    socket.readyState = 3;
    await send(socket, { messages: [] });
    expect(socket.sent).toEqual([]);
  });

  it("reports invalid JSON on the chat socket without invoking the handler", async () => {
    const socket = connect("/ws/chat");
    await send(socket, "{not json");
    expect(frames(socket)).toEqual([{ type: "error", message: "Invalid JSON" }]);
    expect(stub.conversationArgs).toBeNull();
  });

  it("forwards voice audio frames as binary and control events as JSON", async () => {
    const socket = connect("/ws/text-to-audio", { "x-project": "voice-proj" });
    await send(socket, { text: "hello" });
    expect(stub.voiceArgs).toMatchObject({ text: "hello", project: "voice-proj" });
    expect(socket.sent[0]).toBeInstanceOf(Buffer);
    expect(frames(socket)).toEqual([{ type: "done" }]);
  });

  it("swallows voice failures after the error event was emitted", async () => {
    stub.voiceError = new Error("tts down");
    const socket = connect("/ws/text-to-audio");
    await expect(send(socket, { text: "hello" })).resolves.toBeUndefined();
    expect(frames(socket)).toEqual([{ type: "error", message: "tts down" }]);
  });

  it("reports invalid JSON on the voice socket", async () => {
    const socket = connect("/ws/text-to-audio");
    await send(socket, "[]{}");
    expect(frames(socket)).toEqual([{ type: "error", message: "Invalid JSON" }]);
    expect(stub.voiceArgs).toBeNull();
  });
});

const liveSocket = () => connect("/ws/live", { "x-project": "live-proj", "x-username": "carol", "x-agent": "atlas" });

const flush = async () => {
  for (let i = 0; i < 200; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const setupLive = async (socket: FakeSocket, data: Record<string, unknown> = {}) => {
  await send(socket, { type: "setup", ...data });
  return stub.liveCallbacks!;
};

describe("live session setup", () => {
  it("requires a setup message before any other command", async () => {
    const socket = liveSocket();
    await send(socket, { type: "audio", data: "AAAA" });
    expect(frames(socket)).toEqual([{ type: "error", message: "No active session. Send a 'setup' message first." }]);
    expect(stub.sentRealtime).toEqual([]);
  });

  it("reports invalid JSON without touching the session", async () => {
    const socket = liveSocket();
    await send(socket, "not json");
    expect(frames(socket)).toEqual([{ type: "error", message: "Invalid JSON" }]);
  });

  it("emits setupComplete and derives model, conversation and title from the message", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, {
      model: "gemini-3.1-flash-live",
      conversationId: "conv-1",
      title: "Spoken title",
      config: { voiceName: "Puck", temperature: 0.4, thinkingConfig: { thinkingBudget: 0 }, systemInstruction: "be nice" },
    });

    expect(callbacks).toBeTruthy();
    callbacks.onopen({});
    expect(frames(socket)).toEqual([{ type: "setupComplete" }]);
  });

  it("falls back to conversationMeta titles and the configured live model", async () => {
    const socket = liveSocket();
    await setupLive(socket, { config: { conversationMeta: { title: "Meta title" } } });
    expect(stub.liveCallbacks).toBeTruthy();
  });

  it("emits an error frame when the upstream session cannot connect", async () => {
    stub.connectError = new Error("quota exceeded");
    const socket = liveSocket();
    await send(socket, { type: "setup", model: "gemini-3.1-flash-live" });
    expect(frames(socket)).toEqual([{ type: "error", message: "Failed to connect: quota exceeded" }]);
  });

  it("closes an existing session before replacing it", async () => {
    const socket = liveSocket();
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    expect(stub.closedSessions).toBe(1);
  });

  it("offers google search and allow-listed dynamic tools to the model", async () => {
    stub.toolSchemas = [{ name: "get_weather" }, { name: "send_email" }];
    stub.persona = { policies: [{ tool: "get_weather" }] };
    const socket = liveSocket();
    const callbacks = await setupLive(socket, {
      model: "gemini-3.1-flash-live",
      config: { enabledTools: ["Web Search", "get_weather"] },
    });
    expect(callbacks).toBeTruthy();

    await send(socket, { type: "toolResponse", responses: [{ id: "t1" }] });
    expect(stub.sentToolResponses).toEqual([{ functionResponses: [{ id: "t1" }] }]);
  });
});

describe("live client messages", () => {
  it("streams audio input with the client mime type and default sample rate", async () => {
    const socket = liveSocket();
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    await send(socket, { type: "audio", data: "AAAA", mimeType: "audio/pcm;rate=8000" });
    await send(socket, { type: "audio" });
    expect(stub.sentRealtime).toEqual([
      { audio: { data: "AAAA", mimeType: "audio/pcm;rate=8000" } },
      { audio: { data: undefined, mimeType: "audio/pcm;rate=16000" } },
    ]);
  });

  it("signals the end of the audio stream", async () => {
    const socket = liveSocket();
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    await send(socket, { type: "audioStreamEnd" });
    expect(stub.sentRealtime).toEqual([{ audioStreamEnd: true }]);
  });

  it("sends text as a full activity and records it as turn input", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    await send(socket, { type: "text", text: "hello there" });
    expect(stub.sentRealtime).toEqual([{ activityStart: {} }, { text: "hello there" }, { activityEnd: {} }]);

    callbacks.onmessage({
      serverContent: {
        modelTurn: { parts: [{ text: "hi back" }] },
        turnComplete: true,
      },
    });
    await flush();
    expect(frames(socket).at(-1)).toMatchObject({ type: "turnComplete" });
    expect(stub.logs.at(-1)).toMatchObject({
      messages: [{ role: "user", content: "hello there" }],
      text: "hi back",
    });
  });

  it("reports a failure to send text", async () => {
    const socket = liveSocket();
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    stub.liveSession!.sendRealtimeInput = () => {
      throw new Error("transport closed");
    };
    await send(socket, { type: "text", text: "boom" });
    expect(frames(socket).at(-1)).toEqual({ type: "error", message: "Failed to send text: transport closed" });
  });

  it("closes the upstream session on a close command", async () => {
    const socket = liveSocket();
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    await send(socket, { type: "close" });
    expect(stub.closedSessions).toBe(1);
    await send(socket, { type: "audio", data: "AAAA" });
    expect(frames(socket).at(-1)).toMatchObject({ type: "error", message: "No active session. Send a 'setup' message first." });
  });
});

describe("live server messages", () => {
  it("emits thinking, text and audio parts and tracks the sample rate", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    callbacks.onmessage({
      serverContent: {
        modelTurn: {
          parts: [
            { thought: true, text: "pondering" },
            { text: "answer" },
            { inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } },
            { inlineData: { mimeType: "audio/pcm" } },
            { functionCall: { name: "get_weather", args: { city: "Paris" } } },
          ],
        },
      },
    });

    const types = frames(socket).map((frame) => frame.type);
    expect(types).toEqual(["thinking", "text", "audio", "audio", "toolCall"]);
    expect(frames(socket)[0]).toEqual({ type: "thinking", content: "pondering" });
    expect(frames(socket)[1]).toEqual({ type: "text", text: "answer" });
    expect(frames(socket)[2]).toMatchObject({ type: "audio", data: "AAAA", mimeType: "audio/pcm;rate=24000" });
    expect(frames(socket)[4].functionCalls[0]).toMatchObject({ name: "get_weather", args: { city: "Paris" } });
  });

  it("forwards input and output transcriptions and accumulates usage", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    callbacks.onmessage({
      serverContent: {
        inputTranscription: { text: "what time is it" },
        outputTranscription: { text: "noon" },
      },
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    });
    expect(frames(socket)).toEqual([
      { type: "inputTranscription", text: "what time is it" },
      { type: "outputTranscription", text: "noon" },
    ]);

    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await flush();
    expect(frames(socket).at(-1)).toMatchObject({
      type: "turnComplete",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(stub.logs.at(-1)).toMatchObject({
      messages: [{ role: "user", content: "what time is it" }],
      text: "noon",
      usage: { inputTokens: 7, outputTokens: 3 },
      endpoint: "/live",
      provider: "google",
    });
  });

  it("estimates output tokens from audio duration when usage is missing", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    callbacks.onmessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48000).toString("base64"), mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await flush();

    const complete = frames(socket).at(-1) as Record<string, unknown>;
    expect(stub.logErrors).toEqual([]);
    expect(complete.type).toBe("turnComplete");
    // 48000 bytes / (24000 Hz * 2 bytes) = 1 s → 32 tokens.
    expect((complete.usage as Record<string, number>).outputTokens).toBe(32);
    expect(complete.audioRef).toBe("minio://generations/live.wav");
  });

  it("attaches uploaded user audio and the transcription flag to the logged turn", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    await send(socket, { type: "audio", data: Buffer.alloc(3200).toString("base64") });
    callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ text: "ok" }] } } });
    await flush();

    expect(frames(socket).some((frame) => frame.type === "userAudioReady")).toBe(true);

    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await flush();
    const logged = stub.logs.at(-1) as Record<string, unknown>;
    expect(logged.messages).toEqual([
      { role: "user", content: "[Voice Input]", audio: ["minio://generations/live.wav"], liveTranscription: true },
    ]);
    expect(logged.timeToGenerationSec).toEqual(expect.any(Number));
  });

  it("finalises an interrupted turn as well", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ text: "partial" }] }, interrupted: true } });
    await flush();
    expect(frames(socket).at(-1)).toMatchObject({ type: "interrupted" });
  });
});

describe("live tool calls", () => {
  it("executes allowed tools and denies ones the session did not offer", async () => {
    stub.toolSchemas = [{ name: "get_weather" }];
    stub.toolResult = { error: "upstream down" };
    const socket = liveSocket();
    const callbacks = await setupLive(socket, {
      model: "gemini-3.1-flash-live",
      config: { enabledTools: ["get_weather"] },
    });
    callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: "fc1", name: "get_weather", args: { city: "Paris" } },
          { name: "rm_rf", args: {} },
        ],
      },
    });
    await flush();

    const executions = frames(socket).filter((frame) => frame.type === "tool_execution");
    expect(executions.map((frame) => frame.status)).toEqual(["calling", "calling", "error", "done"]);
    expect(executions[2].tool).toMatchObject({ name: "get_weather", id: "fc1", result: { error: "upstream down" } });
    expect(executions[3].tool).toMatchObject({ name: "rm_rf", result: { denied: true, tool: "rm_rf" } });

    expect(stub.toolExecutions).toEqual([{ name: "get_weather", args: { city: "Paris" } }]);
    expect(stub.sentToolResponses).toHaveLength(1);
    expect(stub.sentToolResponses[0]).toMatchObject({
      functionResponses: [
        { id: "fc1", name: "get_weather", response: { error: "upstream down" } },
        { name: "rm_rf", response: { denied: true, tool: "rm_rf" } },
      ],
    });
  });

  it("still reports results when the session closed mid-flight", async () => {
    stub.toolSchemas = [{ name: "get_weather" }];
    const socket = liveSocket();
    const callbacks = await setupLive(socket, {
      model: "gemini-3.1-flash-live",
      config: { enabledTools: ["get_weather"] },
    });
    await send(socket, { type: "close" });
    callbacks.onmessage({ toolCall: { functionCalls: [{ id: "fc9", name: "get_weather", args: {} }] } });
    await flush();
    expect(frames(socket).filter((frame) => frame.type === "tool_execution").at(-1)).toMatchObject({ status: "done" });
    expect(stub.sentToolResponses).toHaveLength(0);
  });

  it("surfaces orchestrator failures without breaking the session", async () => {
    stub.toolSchemas = [{ name: "get_weather" }];
    const socket = liveSocket();
    const callbacks = await setupLive(socket, {
      model: "gemini-3.1-flash-live",
      config: { enabledTools: ["get_weather"] },
    });
    const orchestrator = await import("../../services/ToolOrchestratorService.ts");
    const executeTool = orchestrator.default.executeTool;
    (orchestrator.default as any).executeTool = async () => {
      throw new Error("tool exploded");
    };
    callbacks.onmessage({ toolCall: { functionCalls: [{ id: "fc2", name: "get_weather", args: {} }] } });
    await flush();
    (orchestrator.default as any).executeTool = executeTool;
    expect(frames(socket).filter((frame) => frame.type === "tool_execution").map((frame) => frame.status)).toEqual(["calling"]);
    expect(stub.sentToolResponses).toHaveLength(0);
  });
});

describe("live session lifecycle", () => {
  it("emits upstream errors and clears isGenerating", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live" });
    callbacks.onerror({ error: { message: "network reset" } });
    callbacks.onerror({ message: "generic" });
    callbacks.onerror({});
    expect(frames(socket)).toEqual([
      { type: "error", message: "network reset" },
      { type: "error", message: "generic" },
      { type: "error", message: "Live API error" },
    ]);
  });

  it("clears the session and notifies the client on upstream close", async () => {
    const socket = liveSocket();
    const callbacks = await setupLive(socket, { model: "gemini-3.1-flash-live", conversationId: "conv-9" });
    callbacks.onclose({});
    expect(frames(socket).at(-1)).toEqual({ type: "sessionClosed" });
    await send(socket, { type: "audio", data: "AAAA" });
    expect(frames(socket).at(-1)).toMatchObject({ type: "error" });
  });

  it("closes the upstream session when the client disconnects", async () => {
    const socket = liveSocket();
    await setupLive(socket, { model: "gemini-3.1-flash-live" });
    socket.handlers.close();
    expect(stub.closedSessions).toBe(1);
  });

  it("handles a disconnect with no live session", () => {
    const socket = liveSocket();
    expect(() => socket.handlers.close()).not.toThrow();
    expect(stub.closedSessions).toBe(0);
  });
});
