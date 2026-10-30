/**
 * WorkflowsRoutes — file-reference rewriting, base64 extraction, list metadata
 * and the SSE run handler.
 *
 * Storage (MinIO/FileService), the execution engine and the Mongo collections
 * are stand-ins; every assertion is on the HTTP response or on the document the
 * route hands to Mongo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import router from "../WorkflowsRoutes.ts";

const state = vi.hoisted(() => ({
  externalStorage: false,
  bucketUrl: undefined as string | undefined,
  uploads: [] as string[],
  failUploadMatching: null as string | null,
  execution: null as null | ((nodes: unknown[], edges: unknown[], ctx: unknown, callbacks: any) => Promise<any>),
}));

vi.mock("../../wrappers/MinioWrapper.ts", () => ({
  default: {
    isAvailable: () => state.externalStorage,
    getBucketUrl: () => state.bucketUrl,
    getPublicUrl: (key: string) => `http://minio/bucket/${key}`,
  },
}));

vi.mock("../../services/FileService.ts", () => ({
  default: {
    isExternalStorage: () => state.externalStorage,
    async uploadFile(dataUrl: string) {
      if (state.failUploadMatching && dataUrl.includes(state.failUploadMatching)) {
        throw new Error("upload failed");
      }
      state.uploads.push(dataUrl);
      const extension = dataUrl.slice(5, dataUrl.indexOf(";"));
      return { ref: `minio://files/uploaded.${extension}`, size: dataUrl.length, contentType: "application/octet-stream" };
    },
  },
}));

vi.mock("../../services/WorkflowExecutionService.ts", () => ({
  default: {
    async executeWorkflow(nodes: unknown[], edges: unknown[], context: unknown, callbacks: any) {
      if (!state.execution) throw new Error("no execution stub installed");
      return state.execution(nodes, edges, context, callbacks);
    },
  },
}));

const handlerFor = (method: string, path: string) => {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`${method} ${path} is not registered`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: any) => Promise<unknown>;
};

const cursorOf = (value: unknown) => {
  const toArray = async () => value;
  const project = () => ({ toArray });
  const sort = () => ({ project, toArray });
  return { sort, project, toArray };
};

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    chunks: [] as string[],
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      // Real Express marks the response sent here; asyncHandler relies on that
      // flag to skip re-serialising a handler's `return res.json(...)` value.
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    writeHead(code: number) {
      res.statusCode = code;
      res.headersSent = true;
      return res;
    },
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
      return res;
    },
    on() {
      return res;
    },
  };
  return res;
}

function fakeReq(over: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { host: "prism.local" };
  return {
    db: undefined as any,
    params: {},
    body: {},
    query: {},
    headers,
    protocol: "http",
    project: "proj",
    username: "alice",
    setTimeout() {},
    socket: { setTimeout() {} },
    on() {},
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ...over,
  };
}

const invoke = async (method: string, path: string, req: any) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(method, path)(req, res, (error: unknown) => errors.push(error));
  return { res, errors };
};

/** Workflow collection plus the linked-conversation collection. */
function workflowDb(workflow: Record<string, unknown> | null, conversations: Record<string, unknown>[] = []) {
  const workflows = {
    find: vi.fn(() => cursorOf([workflow].filter(Boolean))),
    findOne: vi.fn(async () => workflow),
    insertOne: vi.fn(async (_doc: Record<string, unknown>) => ({ insertedId: { toString: () => "wf-1" } })),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
  };
  const db = {
    collection: vi.fn((name: string) =>
      name === "workflows" ? workflows : { find: vi.fn(() => cursorOf(conversations)) },
    ),
  };
  return { db, workflows };
}

beforeEach(() => {
  state.externalStorage = false;
  state.bucketUrl = undefined;
  state.uploads = [];
  state.failUploadMatching = null;
  state.execution = null;
});

describe("GET /workflows/:id — minio ref rewriting", () => {
  const workflow = () => ({
    _id: "wf-1",
    workflowId: "wf-1",
    nodes: [
      { id: "n1", content: "minio://files/a.png" },
      {
        id: "n2",
        messages: [
          { images: ["minio://files/b.png", "data:image/png;base64,AAAA"], audio: "minio://files/c.wav", video: "https://x/y.mp4" },
          { images: "minio://files/d.png" },
        ],
      },
      { id: "n3", receivedOutputs: { image: "minio://files/e.png", text: "plain" } },
    ],
    nodeResults: {
      n1: { text: "minio://files/f.txt", conversation: [{ images: ["minio://files/g.png"] }, { audio: ["minio://files/h.mp3", "minio://files/i.mp3"] }] },
      n2: null,
    },
  });

  it("rewrites every ref through the Prism proxy when no bucket URL is configured", async () => {
    const { db } = workflowDb(workflow());
    const { res, errors } = await invoke("get", "/:id", fakeReq({ db, params: { id: "wf-1" } }));

    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(200);
    expect(res.body.nodes[0].content).toBe("http://prism.local/files/files/a.png");
    expect(res.body.nodes[1].messages[0].images).toEqual(["http://prism.local/files/files/b.png", "data:image/png;base64,AAAA"]);
    expect(res.body.nodes[1].messages[0].audio).toBe("http://prism.local/files/files/c.wav");
    expect(res.body.nodes[1].messages[0].video).toBe("https://x/y.mp4");
    expect(res.body.nodes[1].messages[1].images).toBe("http://prism.local/files/files/d.png");
    expect(res.body.nodes[2].receivedOutputs).toEqual({ image: "http://prism.local/files/files/e.png", text: "plain" });
    expect(res.body.nodeResults.n1.text).toBe("http://prism.local/files/files/f.txt");
    expect(res.body.nodeResults.n1.conversation[0].images).toEqual(["http://prism.local/files/files/g.png"]);
    expect(res.body.nodeResults.n1.conversation[1].audio).toEqual([
      "http://prism.local/files/files/h.mp3",
      "http://prism.local/files/files/i.mp3",
    ]);
    // A null nodeResults entry is skipped rather than crashing.
    expect(res.body.nodeResults.n2).toBeNull();
  });

  it("prefers the direct bucket URL and honours forwarded headers", async () => {
    state.bucketUrl = "http://minio.example/bucket";
    const { db } = workflowDb(workflow());
    const { res } = await invoke("get", "/:id", fakeReq({
      db,
      params: { id: "wf-1" },
      headers: { host: "prism.local", "x-forwarded-proto": "https", "x-forwarded-host": "gateway.example" },
    }));

    expect(res.body.nodes[0].content).toBe("http://minio.example/bucket/files/a.png");
    expect(res.body.nodes[1].messages[1].images).toBe("http://minio.example/bucket/files/d.png");
  });

  it("falls back to workflowId for a non-ObjectId id and answers 404 when absent", async () => {
    const { db, workflows } = workflowDb(null);
    const { res } = await invoke("get", "/:id", fakeReq({ db, params: { id: "not-an-objectid" } }));

    expect(workflows.findOne).toHaveBeenCalledWith({ workflowId: "not-an-objectid" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Workflow not found" });
  });
});

describe("POST /workflows — base64 extraction and list metadata", () => {
  const graphBody = () => ({
    nodes: [
      { id: "in", nodeType: "input", outputTypes: ["text", "image"] },
      { id: "m1", provider: "openai" },
      { id: "m2", provider: "openai", nodeType: "model" },
      { id: "out", nodeType: "viewer", inputTypes: ["text"] },
    ],
    edges: [{ id: "e1" }, { id: "e2" }],
    conversationIds: ["c1", "c2"],
  });

  it("stores the document untouched when MinIO is not configured", async () => {
    const { db, workflows } = workflowDb(null, [{ totalCost: 2.5 }, { totalCost: 1.25 }]);
    const body = {
      ...graphBody(),
      nodes: [
        ...graphBody().nodes,
        { id: "n1", content: "data:image/png;base64,AAAA", messages: [{ role: "user", images: ["data:image/png;base64,BBBB"] }] },
      ],
      nodeResults: { n1: { image: "data:image/png;base64,CCCC" } },
    };
    const { res, errors } = await invoke("post", "/", fakeReq({ db, body }));

    expect(errors).toEqual([]);
    expect(res.body).toEqual({ success: true, id: "wf-1" });
    const stored = workflows.insertOne.mock.calls[0][0];
    expect(stored.nodes[4].content).toBe("data:image/png;base64,AAAA");
    expect(stored.nodes[4].messages[0].images).toEqual(["data:image/png;base64,BBBB"]);
    expect(stored.nodeResults).toEqual({ n1: { image: "data:image/png;base64,CCCC" } });
    expect(stored.providers).toEqual(["openai"]);
    expect(stored.modalities).toEqual({ textIn: true, imageIn: true, textOut: true });
    expect(stored.nodeCount).toBe(5);
    expect(stored.edgeCount).toBe(2);
    expect(stored.source).toBe("prism-client");
    expect(stored.totalCost).toBe(3.75);
  });

  it("uploads every base64 payload and rewrites refs, keeping failed uploads inline", async () => {
    state.externalStorage = true;
    state.failUploadMatching = "FAIL";
    const { db, workflows } = workflowDb(null);
    const body = {
      ...graphBody(),
      nodes: [
        { id: "n1", content: "data:image/png;base64,AAA" },
        {
          id: "n2",
          messages: [
            { images: ["data:image/png;base64,BBB", "https://keep/me.png"], audio: "data:audio/wav;base64,CCC" },
            { video: "data:video/mp4;base64,FAIL", pdf: ["data:application/pdf;base64,DDD"] },
          ],
          receivedOutputs: { image: "data:image/png;base64,EEE", text: "already-a-ref" },
        },
        { id: "n3" },
      ],
      nodeResults: {
        n1: { conversation: [{ images: ["data:image/png;base64,FFF"], audio: "data:audio/mp3;base64,GGG" }], image: "data:image/png;base64,HHH" },
        n2: "not-an-object",
      },
    };
    const { res } = await invoke("post", "/", fakeReq({ db, body }));

    expect(res.body).toEqual({ success: true, id: "wf-1" });
    const stored = workflows.insertOne.mock.calls[0][0];
    expect(stored.nodes[0].content).toBe("minio://files/uploaded.image/png");
    expect(stored.nodes[1].messages[0].images).toEqual(["minio://files/uploaded.image/png", "https://keep/me.png"]);
    expect(stored.nodes[1].messages[0].audio).toBe("minio://files/uploaded.audio/wav");
    // The failing upload is kept as its original data URL instead of dropping data.
    expect(stored.nodes[1].messages[1].video).toBe("data:video/mp4;base64,FAIL");
    expect(stored.nodes[1].messages[1].pdf).toEqual(["minio://files/uploaded.application/pdf"]);
    expect(stored.nodes[1].receivedOutputs).toEqual({ image: "minio://files/uploaded.image/png", text: "already-a-ref" });
    expect(stored.nodeResults.n1.conversation[0].images).toEqual(["minio://files/uploaded.image/png"]);
    expect(stored.nodeResults.n1.conversation[0].audio).toBe("minio://files/uploaded.audio/mp3");
    expect(stored.nodeResults.n1.image).toBe("minio://files/uploaded.image/png");
    expect(stored.nodeResults.n2).toBe("not-an-object");
  });

  it("assembles a graph from raw steps when no nodes are supplied", async () => {
    const { db, workflows } = workflowDb(null);
    const body = {
      steps: [{ label: "Draft", model: "gpt-5.2", input: "hello", output: "world" }],
      messageId: "msg-1",
    };
    const { res, errors } = await invoke("post", "/", fakeReq({ db, body }));

    expect(errors).toEqual([]);
    expect(res.body.success).toBe(true);
    const stored = workflows.insertOne.mock.calls[0][0];
    expect(stored.nodeCount).toBeGreaterThan(0);
    expect(stored.edgeCount).toBeGreaterThan(0);
    expect(stored.messageId).toBe("msg-1");
  });
});

describe("PUT /workflows/:id", () => {
  it("re-extracts nodes and nodeResults, recomputes meta and counts", async () => {
    state.externalStorage = true;
    const { db, workflows } = workflowDb(null);
    const body = {
      _id: "should-be-dropped",
      nodes: [
        { id: "in", nodeType: "input", outputTypes: ["text"] },
        { id: "m", provider: "google" },
      ],
      edges: [{ id: "e1" }],
      nodeResults: { in: { text: "data:text/plain;base64,AAA" } },
    };
    const { res, errors } = await invoke("put", "/:id", fakeReq({ db, params: { id: "wf-1" }, body }));

    expect(errors).toEqual([]);
    expect(res.body).toEqual({ success: true });
    const update = workflows.updateOne.mock.calls[0][1];
    expect(update.$set._id).toBeUndefined();
    expect(update.$set.nodeCount).toBe(2);
    expect(update.$set.edgeCount).toBe(1);
    expect(update.$set.providers).toEqual(["google"]);
    expect(update.$set.modalities).toEqual({ textIn: true });
    expect(update.$set.nodeResults).toEqual({ in: { text: "minio://files/uploaded.text/plain" } });
    expect(typeof update.$set.updatedAt).toBe("string");
  });

  it("answers 404 when the workflow does not exist", async () => {
    const { db, workflows } = workflowDb(null);
    workflows.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    const { res } = await invoke("put", "/:id", fakeReq({ db, params: { id: "abc" }, body: { nodes: [] } }));

    expect(workflows.updateOne.mock.calls[0][0]).toEqual({ workflowId: "abc" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /workflows/:id/conversations", () => {
  it("rejects a missing or empty conversationIds array", async () => {
    const { db } = workflowDb(null);
    for (const body of [{}, { conversationIds: [] }, { conversationIds: "c1" }]) {
      const { res } = await invoke("patch", "/:id/conversations", fakeReq({ db, params: { id: "wf-1" }, body }));
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "conversationIds array required" });
    }
  });

  it("pushes the ids and stores the recomputed cost", async () => {
    const workflow = { conversationIds: ["c1", "c2"] };
    const { db, workflows } = workflowDb(workflow, [{ totalCost: 2 }, { totalCost: 3 }]);
    const { res, errors } = await invoke("patch", "/:id/conversations", fakeReq({
      db,
      params: { id: "wf-1" },
      body: { conversationIds: ["c3"] },
    }));

    expect(errors).toEqual([]);
    expect(res.body).toEqual({ success: true });
    expect(workflows.updateOne.mock.calls[0][1].$push).toEqual({ conversationIds: { $each: ["c3"] } });
    expect(workflows.updateOne.mock.calls[1][1]).toEqual({ $set: { totalCost: 5 } });
  });

  it("skips the cost update when the workflow has no linked conversations", async () => {
    const { db, workflows } = workflowDb({});
    const { res } = await invoke("patch", "/:id/conversations", fakeReq({
      db,
      params: { id: "wf-1" },
      body: { conversationIds: ["c3"] },
    }));

    expect(res.body).toEqual({ success: true });
    expect(workflows.updateOne).toHaveBeenCalledTimes(1);
  });

  it("answers 404 when the push matches nothing", async () => {
    const { db, workflows } = workflowDb(null);
    workflows.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    const { res } = await invoke("patch", "/:id/conversations", fakeReq({
      db,
      params: { id: "wf-1" },
      body: { conversationIds: ["c3"] },
    }));

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /workflows/:id", () => {
  it("deletes by workflowId for a non-ObjectId and reports success", async () => {
    const { db, workflows } = workflowDb(null);
    const { res } = await invoke("delete", "/:id", fakeReq({ db, params: { id: "wf-legacy" } }));

    expect(res.body).toEqual({ success: true });
    expect(workflows.deleteOne).toHaveBeenCalledWith({ workflowId: "wf-legacy" });
  });
});

describe("POST /workflows/:id/run — SSE execution", () => {
  it("answers 404 when the workflow is missing and 400 when it has no nodes", async () => {
    const missing = workflowDb(null);
    const notFound = await invoke("post", "/:id/run", fakeReq({ db: missing.db, params: { id: "wf-1" } }));
    expect(notFound.res.statusCode).toBe(404);
    expect(notFound.res.body).toEqual({ error: "Workflow not found" });

    const empty = workflowDb({ nodes: [] });
    const noNodes = await invoke("post", "/:id/run", fakeReq({ db: empty.db, params: { id: "wf-1" } }));
    expect(noNodes.res.statusCode).toBe(400);
    expect(noNodes.res.body).toEqual({ error: "Workflow has no nodes" });
  });

  it("streams node events, persists results and links generated conversations", async () => {
    const workflow = { nodes: [{ id: "n1" }, { id: "n2" }], edges: [], conversationIds: ["old"] };
    const { db, workflows } = workflowDb(workflow, [{ totalCost: 1.5 }]);
    state.execution = async (nodes, _edges, _context, callbacks) => {
      callbacks.onNodeStart("n1");
      callbacks.onNodeComplete("n1", { text: "hi" });
      callbacks.onViewerPartial("n1", { text: "h" });
      callbacks.onNodeError("n2", "boom");
      return { nodeOutputs: { n1: { text: "hi" }, n2: { error: "boom" } }, conversationIds: ["c9"] };
    };

    const { res, errors } = await invoke("post", "/:id/run", fakeReq({ db, params: { id: "wf-1" } }));

    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    const events = res.chunks.map((chunk: string) => JSON.parse(chunk.replace(/^data: /, "")));
    expect(events.map((event: any) => event.type)).toEqual([
      "run_info",
      "node_start",
      "node_complete",
      "viewer_partial",
      "node_error",
      "run_complete",
    ]);
    expect(events[3].outputs).toEqual({ text: "h" });
    expect(events[5]).toMatchObject({ nodeResults: { n1: { text: "hi" } }, conversationIds: ["c9"] });

    const update = workflows.updateOne.mock.calls[0][1];
    expect(update.$set.nodeStatuses).toEqual({ n1: "done", n2: "error" });
    expect(update.$set.conversationIds).toEqual(["old", "c9"]);
    expect(update.$set.totalCost).toBe(1.5);

    // The run registry entry is cleared once the stream ends.
    const active = await invoke("get", "/:id/active", fakeReq({ params: { id: "wf-1" } }));
    expect(active.res.body).toEqual({ active: false });
  });

  it("reports a mid-stream failure as an SSE error event", async () => {
    const { db } = workflowDb({ nodes: [{ id: "n1" }], edges: [] });
    state.execution = async () => {
      throw new Error("engine exploded");
    };

    const { res } = await invoke("post", "/:id/run", fakeReq({ db, params: { id: "wf-1" } }));

    expect(res.headersSent).toBe(true);
    expect(res.ended).toBe(true);
    const last = JSON.parse(res.chunks.at(-1)!.replace(/^data: /, ""));
    expect(last).toEqual({ type: "error", message: "engine exploded" });
  });

  it("answers 500 before the stream starts when the lookup itself fails", async () => {
    const { db } = workflowDb(null);
    db.collection.mockReturnValue({ findOne: vi.fn(async () => { throw new Error("mongo down"); }) });
    const { res } = await invoke("post", "/:id/run", fakeReq({ db, params: { id: "wf-1" } }));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Workflow execution failed" });
  });
});
