/**
 * AudioRoutes — audio transcription with conversation persistence.
 *
 * Providers, file storage, conversation writes and request logging are stubs;
 * assertions are on the HTTP response and the messages the route hands to
 * ConversationService.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import router from "../AudioRoutes.ts";

const stub = vi.hoisted(() => ({
  providers: {} as Record<string, Record<string, unknown>>,
  uploadThrows: false,
  appended: [] as Array<{ id: string; messages: unknown[]; meta: unknown }>,
  generating: [] as Array<{ id: string; value: boolean }>,
  requestLogs: [] as Array<Record<string, unknown>>,
  appendThrows: false,
}));

vi.mock("../../providers/index.ts", () => ({
  getProvider: (name: string) => stub.providers[name],
}));

vi.mock("../../services/ConversationService.ts", () => ({
  default: {
    async appendMessages(id: string, _project: string, _username: string, messages: unknown[], meta: unknown) {
      if (stub.appendThrows) throw new Error("append failed");
      stub.appended.push({ id, messages, meta });
    },
    async setGenerating(id: string, _project: string, _username: string, value: boolean) {
      stub.generating.push({ id, value });
    },
  },
}));

vi.mock("../../services/FileService.ts", () => ({
  default: {
    async uploadFile(dataUrl: string) {
      if (stub.uploadThrows) throw new Error("minio down");
      return { ref: `minio://files/${dataUrl.length}.bin`, size: dataUrl.length, contentType: "audio/mpeg" };
    },
  },
}));

vi.mock("../../services/RequestLogger.ts", () => ({
  default: {
    log: (entry: Record<string, unknown>) => stub.requestLogs.push(entry),
  },
}));

vi.mock("../../utils/logger.ts", () => ({
  default: {
    error: () => {},
    warn: () => {},
    info: () => {},
    success: () => {},
    request: () => {},
  },
}));

const handlerFor = (method: string, path: string, index = 0) => {
  const layers = (router as any).stack.filter(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  const layer = layers[index];
  if (!layer) throw new Error(`${method} ${path}#${index} is not registered`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: any) => Promise<unknown>;
};

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    headers: {} as Record<string, string>,
    chunks: [] as unknown[],
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    write(chunk: unknown) {
      res.chunks.push(chunk);
      res.headersSent = true;
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    params: {},
    body: {},
    query: {},
    headers: { host: "prism.local" },
    baseUrl: "/text-to-audio",
    project: "proj",
    username: "alice",
    clientIp: "10.0.0.9",
    ...over,
  };
}

const invoke = async (method: string, path: string, req: any, index = 0) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(method, path, index)(req, res, (error: unknown) => {
    if (error !== undefined) errors.push(error);
  });
  return { res, errors };
};

/** The audio-to-text handler is the sole POST "/" registration. */
const invokeTranscription = (req: any) => invoke("post", "/", req, 0);

const transcribeProvider = (result: Record<string, unknown>) => ({
  async transcribeAudio() {
    return result;
  },
});

beforeEach(() => {
  stub.providers = {};
  stub.uploadThrows = false;
  stub.appended = [];
  stub.generating = [];
  stub.requestLogs = [];
  stub.appendThrows = false;
});

describe("POST /audio-to-text", () => {
  it("rejects missing provider and missing audio", async () => {
    const noProvider = await invokeTranscription(fakeReq({ baseUrl: "/audio-to-text", body: { audio: "AAAA" } }));
    expect(noProvider.errors[0]).toMatchObject({ statusCode: 400, message: "Missing required field: provider" });

    const noAudio = await invokeTranscription(fakeReq({ baseUrl: "/audio-to-text", body: { provider: "openai" } }));
    expect(noAudio.errors[0]).toMatchObject({ statusCode: 400, message: "Missing required field: audio" });
  });

  it("rejects a provider without transcription support", async () => {
    stub.providers.openai = {};
    const { errors } = await invokeTranscription(fakeReq({ baseUrl: "/audio-to-text", body: { provider: "openai", audio: "AAAA" } }));
    expect(errors[0]).toMatchObject({ statusCode: 400, message: 'Provider "openai" does not support audio transcription' });
  });

  it("transcribes a data URL and persists the conversation turn", async () => {
    stub.providers.openai = transcribeProvider({ text: "hello world", usage: { inputTokens: 10, outputTokens: 4, durationSeconds: 12 } });
    const audio = "data:audio/wav;base64,QUJD";
    const { res, errors } = await invokeTranscription(fakeReq({
      baseUrl: "/audio-to-text",
      body: { provider: "openai", audio, model: "gpt-4o-transcribe", language: "en", prompt: "Names: Alice", conversationId: "c1", conversationMeta: { title: "Call" }, traceId: "t1" },
    }));

    expect(errors).toEqual([]);
    expect(res.body.text).toBe("hello world");
    expect(res.body.traceId).toBe("t1");
    expect(res.body.usage).toEqual({ inputTokens: 10, outputTokens: 4, durationSeconds: 12 });
    expect(typeof res.body.estimatedCost).toBe("number");
    expect(typeof res.body.totalTime).toBe("number");

    expect(stub.requestLogs.at(-1)).toMatchObject({ success: true, endpoint: "audio-to-text", conversationId: "c1", traceId: "t1" });
    expect(stub.appended).toHaveLength(1);
    const [appended] = stub.appended;
    expect(appended.id).toBe("c1");
    expect(appended.messages[0]).toMatchObject({ role: "user", content: "Names: Alice" });
    expect((appended.messages[0] as Record<string, unknown>).images).toHaveLength(1);
    expect(appended.messages[1]).toMatchObject({ role: "assistant", content: "hello world", provider: "openai", model: "gpt-4o-transcribe" });
    expect(appended.meta).toMatchObject({ title: "Call", traceId: "t1", settings: { provider: "openai", model: "gpt-4o-transcribe" } });
    expect(stub.generating).toContainEqual({ id: "c1", value: true });
    expect(stub.generating).toContainEqual({ id: "c1", value: false });
  });

  it("accepts raw base64 and skips persistence when asked", async () => {
    stub.providers.openai = transcribeProvider({ text: "raw", usage: null });
    const { res } = await invokeTranscription(fakeReq({
      baseUrl: "/audio-to-text",
      body: { provider: "openai", audio: "QUJD", skipConversation: true, traceId: "t9" },
    }));

    expect(res.body.text).toBe("raw");
    expect(res.body.usage).toEqual({});
    expect(res.body.estimatedCost).toBeNull();
    expect(res.body.traceId).toBe("t9");
    expect(stub.appended).toHaveLength(0);
    expect(stub.generating).toHaveLength(0);
  });

  it("generates a conversation id and default title when none is supplied", async () => {
    stub.providers.openai = transcribeProvider({ text: "auto" });
    const { res } = await invokeTranscription(fakeReq({ baseUrl: "/audio-to-text", body: { provider: "openai", audio: "QUJD" } }));

    expect(res.body.traceId).toBeUndefined();
    expect(stub.appended).toHaveLength(1);
    expect(stub.appended[0].meta).toMatchObject({ title: "Audio Transcription" });
    expect(stub.appended[0].messages[0]).toMatchObject({ content: "Transcribe this audio" });
  });

  it("keeps the raw audio reference when the upload fails", async () => {
    stub.uploadThrows = true;
    stub.providers.openai = transcribeProvider({ text: "kept" });
    await invokeTranscription(fakeReq({ baseUrl: "/audio-to-text", body: { provider: "openai", audio: "data:audio/wav;base64,QUJD", conversationId: "c1" } }));

    const userMessage = stub.appended[0].messages[0] as Record<string, unknown>;
    expect(userMessage.images).toEqual(["data:audio/wav;base64,QUJD"]);
  });

  it("clears isGenerating and forwards upstream failures", async () => {
    stub.providers.openai = {
      async transcribeAudio() {
        throw new Error("stt exploded");
      },
    };
    const { errors } = await invokeTranscription(fakeReq({ baseUrl: "/audio-to-text", body: { provider: "openai", audio: "QUJD", conversationId: "c1" } }));

    expect(errors[0]).toMatchObject({ message: "stt exploded" });
    expect(stub.generating).toContainEqual({ id: "c1", value: false });
    expect(stub.requestLogs.at(-1)).toMatchObject({ success: false, errorMessage: "stt exploded" });
  });
});
