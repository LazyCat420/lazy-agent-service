/**
 * AudioRoutes — text-to-audio streaming (binary and dataUrl), the shared
 * handleVoice core, and audio transcription with conversation persistence.
 *
 * Providers, file storage, conversation writes and request logging are stubs;
 * assertions are on the HTTP response, the emitted events and the messages the
 * route hands to ConversationService.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import router, { handleVoice } from "../AudioRoutes.ts";

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

/** Two POST "/" routes exist (text-to-audio and audio-to-text); `index` picks one. */
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

/** The audio-to-text handler is the second POST "/" registration. */
const invokeTranscription = (req: any) => invoke("post", "/", req, 1);

const webStream = (chunks: Uint8Array[]) => ({
  getReader() {
    let index = 0;
    return {
      async read() {
        if (index >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[index++] };
      },
    };
  },
});

const nodeStream = (chunks: Buffer[]) => Readable.from(chunks);

const speechProvider = (stream: unknown, contentType = "audio/mpeg") => ({
  async generateSpeech() {
    return { stream, contentType };
  },
});

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

describe("handleVoice — validation", () => {
  const events: Array<Record<string, unknown>> = [];
  const collect = (event: Record<string, unknown>) => events.push(event);

  beforeEach(() => {
    events.length = 0;
  });

  it("rejects a missing provider with a 400 ProviderError", async () => {
    await expect(
      handleVoice({ provider: "", text: "hello" }, () => {}, collect),
    ).rejects.toMatchObject({ statusCode: 400, message: "Missing required field: provider" });
    expect(events.at(-1)).toEqual({ type: "error", message: "Missing required field: provider" });
  });

  it("rejects a missing text", async () => {
    await expect(
      handleVoice({ provider: "openai", text: "" }, () => {}, collect),
    ).rejects.toMatchObject({ statusCode: 400, message: "Missing required field: text" });
  });

  it("rejects a provider without text-to-speech support", async () => {
    stub.providers.openai = {};
    await expect(
      handleVoice({ provider: "openai", text: "hello" }, () => {}, collect),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Provider "openai" does not support text-to-speech' });
  });

  it("rejects a provider whose speech call throws and clears isGenerating", async () => {
    stub.providers.openai = {
      async generateSpeech() {
        throw new Error("upstream 500");
      },
    };
    await expect(
      handleVoice({ provider: "openai", text: "hello", conversationId: "c1" }, () => {}, collect),
    ).rejects.toThrow("upstream 500");

    expect(stub.requestLogs.at(-1)).toMatchObject({ success: false, errorMessage: "upstream 500", provider: "openai" });
    expect(stub.generating).toContainEqual({ id: "c1", value: false });
    expect(events.at(-1)).toEqual({ type: "error", message: "upstream 500" });
  });
});

describe("handleVoice — streaming and persistence", () => {
  it("streams a web ReadableStream and persists the audio turn", async () => {
    stub.providers.openai = speechProvider(webStream([new Uint8Array([1, 2]), new Uint8Array([3])]), "audio/ogg");
    const binary: Buffer[] = [];
    const events: Array<Record<string, unknown>> = [];

    const contentType = await handleVoice(
      { provider: "openai", text: "say hi", voice: "alloy", model: "gpt-4o-mini-tts", conversationId: "c1", conversationMeta: { title: "Greeting" }, traceId: "t1" },
      (chunk) => binary.push(Buffer.from(chunk)),
      (event) => events.push(event),
    );

    expect(contentType).toBe("audio/ogg");
    expect(Buffer.concat(binary)).toEqual(Buffer.from([1, 2, 3]));
    expect(events).toEqual([{ type: "done" }]);
    expect(stub.requestLogs.at(-1)).toMatchObject({ success: true, endpoint: "text-to-audio", conversationId: "c1", traceId: "t1" });

    expect(stub.appended).toHaveLength(1);
    const [appended] = stub.appended;
    expect(appended.id).toBe("c1");
    expect(appended.messages[0]).toMatchObject({ role: "user", content: "say hi" });
    expect(appended.messages[1]).toMatchObject({ role: "assistant", provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy" });
    expect((appended.messages[1] as Record<string, unknown>).audio).toMatch(/^minio:\/\/files\//);
    expect(appended.meta).toMatchObject({ title: "Greeting", traceId: "t1", settings: { provider: "openai", model: "gpt-4o-mini-tts" } });
    expect(stub.generating).toContainEqual({ id: "c1", value: true });
  });

  it("streams a Node readable without buffering when the conversation is skipped", async () => {
    stub.providers.openai = speechProvider(nodeStream([Buffer.from([4]), Buffer.from([5])]));
    const binary: Buffer[] = [];
    const events: Array<Record<string, unknown>> = [];

    await handleVoice(
      { provider: "openai", text: "skip me", skipConversation: true, traceId: "t2" },
      (chunk) => binary.push(Buffer.from(chunk)),
      (event) => events.push(event),
    );

    expect(binary).toEqual([Buffer.from([4]), Buffer.from([5])]);
    expect(stub.appended).toHaveLength(0);
    expect(stub.generating).toHaveLength(0);
    expect(stub.requestLogs.at(-1)).toMatchObject({ conversationId: null, traceId: "t2" });
  });

  it("derives the conversation title from the text, falling back to a default", async () => {
    stub.providers.openai = speechProvider(webStream([new Uint8Array([1])]));
    await handleVoice({ provider: "openai", text: "   " }, () => {}, () => {});
    expect(stub.appended.at(-1)!.meta).toMatchObject({ title: "TTS Request" });

    stub.appended = [];
    await handleVoice({ provider: "openai", text: "hello there" }, () => {}, () => {});
    expect(stub.appended.at(-1)!.meta).toMatchObject({ title: "hello there" });
  });

  it("keeps the turn when the audio upload fails", async () => {
    stub.uploadThrows = true;
    stub.providers.openai = speechProvider(webStream([new Uint8Array([1])]));
    await handleVoice({ provider: "openai", text: "hi", conversationId: "c1" }, () => {}, () => {});

    const assistant = stub.appended[0].messages[1] as Record<string, unknown>;
    expect(assistant.audio).toBeUndefined();
    expect(assistant.provider).toBe("openai");
  });

  it("throws when the provider returns no stream", async () => {
    stub.providers.openai = speechProvider(null);
    await expect(
      handleVoice({ provider: "openai", text: "hi", skipConversation: true }, () => {}, () => {}),
    ).rejects.toThrow("Speech generation returned no stream");
    expect(stub.requestLogs.at(-1)).toMatchObject({ success: false });
  });

  it("logs a failed append without failing the stream", async () => {
    stub.appendThrows = true;
    stub.providers.openai = speechProvider(webStream([new Uint8Array([1])]));
    const contentType = await handleVoice({ provider: "openai", text: "hi", conversationId: "c1" }, () => {}, () => {});
    expect(contentType).toBe("audio/mpeg");
    expect(stub.appended).toHaveLength(0);
  });
});

describe("POST /text-to-audio", () => {
  it("returns a data URL when format=dataUrl", async () => {
    stub.providers.openai = speechProvider(webStream([new Uint8Array([1, 2])]), "audio/mpeg");
    const { res, errors } = await invoke("post", "/", fakeReq({ body: { provider: "openai", text: "hi", skipConversation: true }, query: { format: "dataUrl" } }));

    expect(errors).toEqual([]);
    expect(res.body.contentType).toBe("audio/mpeg");
    expect(res.body.audioDataUrl).toBe(`data:audio/mpeg;base64,${Buffer.from([1, 2]).toString("base64")}`);
  });

  it("streams binary chunks with chunked headers by default", async () => {
    stub.providers.openai = speechProvider(webStream([new Uint8Array([7]), new Uint8Array([8])]));
    const { res, errors } = await invoke("post", "/", fakeReq({ body: { provider: "openai", text: "hi", skipConversation: true } }));

    expect(errors).toEqual([]);
    expect(res.headers["Content-Type"]).toBe("audio/mpeg");
    expect(res.headers["Transfer-Encoding"]).toBe("chunked");
    expect(res.chunks).toEqual([new Uint8Array([7]), new Uint8Array([8])]);
    expect(res.ended).toBe(true);
  });

  it("forwards validation errors before any bytes are sent", async () => {
    const { res, errors } = await invoke("post", "/", fakeReq({ body: { text: "hi" } }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 400 });
    expect(res.headersSent).toBe(false);
  });

  it("swallows a failure once the stream has started", async () => {
    let reads = 0;
    stub.providers.openai = speechProvider({
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads === 1) return { done: false, value: new Uint8Array([1]) };
            throw new Error("stream broke");
          },
        };
      },
    });
    const { res, errors } = await invoke("post", "/", fakeReq({ body: { provider: "openai", text: "hi", skipConversation: true } }));

    expect(errors).toEqual([]);
    expect(res.headersSent).toBe(true);
    expect(res.chunks).toEqual([new Uint8Array([1])]);
  });

  it("skips the handler when mounted under audio-to-text", async () => {
    const { res, errors } = await invoke("post", "/", fakeReq({ baseUrl: "/audio-to-text", body: { provider: "openai", text: "hi" } }), 0);
    expect(errors).toEqual([]);
    expect(res.body).toBeUndefined();
    expect(res.chunks).toEqual([]);
  });
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
