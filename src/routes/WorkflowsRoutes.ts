import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response, NextFunction } from "express";
import { EventEmitter } from "node:events";
import { ObjectId, type Db } from "mongodb";
import logger from "../utils/logger.ts";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import FileService from "../services/FileService.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import { assembleGraph } from "../services/WorkflowAssembler.ts";
import WorkflowExecutionService from "../services/WorkflowExecutionService.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import { COLLECTIONS, FILE_CATEGORIES } from "../constants.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

interface CustomRequest extends Request {
  db: Db;
  project?: string;
  username?: string;
}

const router = Router();
router.use(requireDb);

const WORKFLOWS_COLLECTION = COLLECTIONS.WORKFLOWS;

/** Media fields on messages that may contain base64 data URLs. */
const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];

/**
 * Upload a single value if it's a base64 data URL, returning the minio:// ref.
 * Non-data-URL strings (minio://, http://, etc.) pass through unchanged.
 */
async function uploadIfDataUrl(
  value: unknown,
  category = FILE_CATEGORIES.UPLOADS,
  project: string | null = null,
  username: string | null = null,
) {
  if (typeof value === "string" && value.startsWith("data:")) {
    try {
      const { ref } = await FileService.uploadFile(
        value,
        category,
        project,
        username,
      );
      return ref;
    } catch (error: unknown) {
      logger.error(`Workflow file upload failed: ${getErrorMessage(error)}`);
      return value;
    }
  }
  return value;
}

/**
 * Walk all workflow nodes and upload any base64 data URLs to MinIO,
 * replacing them with minio:// refs. Mirrors the extractFiles pattern
 * used by ConversationService for chat messages.
 */
async function extractWorkflowFiles(
  nodes: unknown[],
  project: string | null = null,
  username: string | null = null,
) {
  if (!Array.isArray(nodes) || !FileService.isExternalStorage()) return nodes;

  const processed: Record<string, unknown>[] = [];
  for (const node of nodes) {
    const updated = { ...(node as Record<string, unknown>) };

    // 1. Node-level content (asset input nodes store content as a data URL)
    if (
      typeof updated.content === "string" &&
      updated.content.startsWith("data:")
    ) {
      updated.content = await uploadIfDataUrl(
        updated.content,
        FILE_CATEGORIES.UPLOADS,
        project,
        username,
      );
    }

    // 2. Messages array (conversation / model nodes)
    if (Array.isArray(updated.messages)) {
      const newMessages: Record<string, unknown>[] = [];
      for (const message of updated.messages) {
        const sanitizedMessage = { ...(message as Record<string, unknown>) };
        for (const field of MEDIA_FIELDS) {
          const value = sanitizedMessage[field];
          if (Array.isArray(value)) {
            const array: string[] = [];
            for (const item of value) {
              array.push(
                (await uploadIfDataUrl(
                  item,
                  FILE_CATEGORIES.UPLOADS,
                  project,
                  username,
                )) as string,
              );
            }
            sanitizedMessage[field] = array;
          } else if (typeof value === "string" && value.startsWith("data:")) {
            sanitizedMessage[field] = await uploadIfDataUrl(
              value,
              FILE_CATEGORIES.UPLOADS,
              project,
              username,
            );
          }
        }
        newMessages.push(sanitizedMessage);
      }
      updated.messages = newMessages;
    }

    // 3. Viewer nodes store receivedOutputs — same { modality: data } shape
    if (
      updated.receivedOutputs &&
      typeof updated.receivedOutputs === "object"
    ) {
      const newReceived: Record<string, unknown> = {};
      for (const [modality, data] of Object.entries(updated.receivedOutputs)) {
        newReceived[modality] = await uploadIfDataUrl(
          data,
          FILE_CATEGORIES.UPLOADS,
          project,
          username,
        );
      }
      updated.receivedOutputs = newReceived;
    }

    processed.push(updated);
  }
  return processed;
}

/**
 * Walk nodeResults and upload any base64 data URLs to MinIO.
 * Shape: { [nodeId]: { [modality]: dataUrl | messagesArray } }
 */
async function extractNodeResultFiles(
  nodeResults: Record<string, unknown>,
  project: string | null = null,
  username: string | null = null,
) {
  if (
    !nodeResults ||
    typeof nodeResults !== "object" ||
    !FileService.isExternalStorage()
  ) {
    return nodeResults;
  }

  const processed: Record<string, unknown> = {};
  for (const [nodeId, outputs] of Object.entries(nodeResults)) {
    if (!outputs || typeof outputs !== "object") {
      processed[nodeId] = outputs;
      continue;
    }
    const newOutputs: Record<string, unknown> = {};
    for (const [modality, data] of Object.entries(outputs)) {
      // conversation modality is an array of message objects with nested media
      if (modality === "conversation" && Array.isArray(data)) {
        const msgs: Record<string, unknown>[] = [];
        for (const message of data) {
          const sanitizedMessage = { ...(message as Record<string, unknown>) };
          for (const field of MEDIA_FIELDS) {
            const value = sanitizedMessage[field];
            if (Array.isArray(value)) {
              const array: string[] = [];
              for (const item of value) {
                array.push(
                  (await uploadIfDataUrl(
                    item,
                    FILE_CATEGORIES.UPLOADS,
                    project,
                    username,
                  )) as string,
                );
              }
              sanitizedMessage[field] = array;
            } else if (typeof value === "string" && value.startsWith("data:")) {
              sanitizedMessage[field] = await uploadIfDataUrl(
                value,
                FILE_CATEGORIES.UPLOADS,
                project,
                username,
              );
            }
          }
          msgs.push(sanitizedMessage);
        }
        newOutputs[modality] = msgs;
      } else {
        newOutputs[modality] = await uploadIfDataUrl(
          data,
          FILE_CATEGORIES.UPLOADS,
          project,
          username,
        );
      }
    }
    processed[nodeId] = newOutputs;
  }
  return processed;
}

/**
 * Convert a minio:// ref to an HTTP /files/ URL.
 * Non-minio strings (data URLs, http URLs, etc.) pass through unchanged.
 */
function resolveMinioRef(value: unknown, baseUrl: string) {
  if (typeof value === "string" && value.startsWith("minio://")) {
    const key = value.replace("minio://", "");
    // Use direct MinIO URL when available, otherwise proxy through Prism
    const minioBase = MinioWrapper.getBucketUrl();
    if (minioBase) return `${minioBase}/${key}`;
    return `${baseUrl}/files/${key}`;
  }
  return value;
}

/** Resolve minio:// refs inside one message's media fields. */
function resolveMessageMediaRefs(
  message: Record<string, unknown>,
  baseUrl: string,
): void {
  for (const field of MEDIA_FIELDS) {
    const value = message[field];
    if (Array.isArray(value)) {
      message[field] = value.map((item: unknown) =>
        resolveMinioRef(item, baseUrl),
      );
    } else if (typeof value === "string") {
      message[field] = resolveMinioRef(value, baseUrl);
    }
  }
}

/** Resolve minio:// refs on a single workflow node (content, messages, viewer outputs). */
function resolveNodeFileRefs(
  node: Record<string, unknown>,
  baseUrl: string,
): void {
  // Node-level content (asset input nodes)
  if (typeof node.content === "string") {
    node.content = resolveMinioRef(node.content, baseUrl);
  }

  // Messages array (conversation / model nodes)
  if (Array.isArray(node.messages)) {
    for (const message of node.messages as Record<string, unknown>[]) {
      resolveMessageMediaRefs(message, baseUrl);
    }
  }

  // Viewer receivedOutputs
  if (node.receivedOutputs && typeof node.receivedOutputs === "object") {
    const receivedOutputs = node.receivedOutputs as Record<string, unknown>;
    for (const [modality, data] of Object.entries(receivedOutputs)) {
      receivedOutputs[modality] = resolveMinioRef(data, baseUrl);
    }
  }
}

function resolveNodeResultsFileRefs(
  nodeResults: Record<string, unknown>,
  baseUrl: string,
): void {
  for (const outputs of Object.values(nodeResults) as Record<
    string,
    unknown
  >[]) {
    if (!outputs || typeof outputs !== "object") continue;
    for (const [modality, data] of Object.entries(outputs)) {
      // conversation modality is an array of message objects with nested media
      if (modality === "conversation" && Array.isArray(data)) {
        for (const message of data) {
          resolveMessageMediaRefs(message as Record<string, unknown>, baseUrl);
        }
      } else {
        (outputs as Record<string, unknown>)[modality] = resolveMinioRef(
          data,
          baseUrl,
        );
      }
    }
  }
}

/**
 * Walk a workflow document and replace all minio:// refs with HTTP /files/ URLs
 * so the frontend receives browser-renderable URLs directly.
 */
function resolveWorkflowFileRefs(
  workflow: Record<string, unknown>,
  baseUrl: string,
) {
  // Resolve nodes
  if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      resolveNodeFileRefs(node as Record<string, unknown>, baseUrl);
    }
  }

  // Resolve nodeResults: { [nodeId]: { [modality]: value | messagesArray } }
  if (workflow.nodeResults && typeof workflow.nodeResults === "object") {
    resolveNodeResultsFileRefs(
      workflow.nodeResults as Record<string, unknown>,
      baseUrl,
    );
  }

  return workflow;
}

function getBaseUrl(req: Request) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

/**
 * Compute list-display metadata from workflow nodes.
 * Single source of truth for providers and modalities.
 * Cost is computed separately from linked conversations (PATCH endpoint).
 */
function computeWorkflowMeta(nodes: Record<string, unknown>[]) {
  const providers = [
    ...new Set(
      (nodes || [])
        .filter(
          (record: Record<string, unknown>) =>
            !record.nodeType && record.provider,
        )
        .map((record: Record<string, unknown>) => record.provider as string),
    ),
  ];
  const modalities: Record<string, boolean> = {};
  for (const record of nodes || []) {
    // Only include boundary nodes: input assets define workflow inputs,
    // viewer nodes define workflow outputs
    if (record.nodeType === "input") {
      for (const tool of (record.outputTypes as string[]) || [])
        modalities[`${tool}In`] = true;
    } else if (record.nodeType === "viewer") {
      for (const tool of (record.inputTypes as string[]) || [])
        modalities[`${tool}Out`] = true;
    }
  }
  return { providers, modalities };
}

/**
 * GET /workflows
 * List all saved workflows (metadata only).
 */
router.get(
  "/",
  asyncHandler(
    async (req: CustomRequest, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        const source = req.query.source || "prism-client";
        const query = source === "all" ? {} : { source };

        const workflows = await db
          .collection(WORKFLOWS_COLLECTION)
          .find(query)
          .sort({ updatedAt: -1 })
          .project({ nodes: 0, edges: 0, nodeResults: 0, nodeStatuses: 0 })
          .toArray();

        res.json(workflows);
      } catch (error: unknown) {
        logger.error(`GET /workflows error: ${getErrorMessage(error)}`);
        next(error);
      }
    },
  ),
);

/**
 * GET /workflows/:id
 * Get a single workflow by ID (full document).
 */
router.get(
  "/:id",
  asyncHandler(
    async (req: CustomRequest, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        let filter: Record<string, unknown>;
        try {
          filter = { _id: new ObjectId(req.params.id as string) };
        } catch {
          filter = { workflowId: req.params.id };
        }

        const workflow = await db
          .collection(WORKFLOWS_COLLECTION)
          .findOne(filter);
        if (!workflow)
          return res.status(404).json({ error: "Workflow not found" });

        const baseUrl = getBaseUrl(req);
        resolveWorkflowFileRefs(workflow, baseUrl);

        res.json(workflow);
      } catch (error: unknown) {
        logger.error(`GET /workflows/:id error: ${getErrorMessage(error)}`);
        next(error);
      }
    },
  ),
);

/**
 * POST /workflows
 * Save a new workflow document.
 *
 * Accepts two payload formats:
 * 1. Raw steps (from Lupos/bots): { steps, messageId, ... }
 *    → Prism assembles the visual graph using WorkflowAssembler
 * 2. Pre-built graph (from Prism Client editor): { nodes, edges, ... }
 *    → Passes through unchanged
 */
router.post(
  "/",
  asyncHandler(
    async (req: CustomRequest, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        const project = req.project;
        const username = req.username || null;

        let { nodes, edges, nodeResults } = req.body;

        // If the payload has steps but no pre-built nodes, assemble the graph
        if (
          Array.isArray(req.body.steps) &&
          req.body.steps.length > 0 &&
          !Array.isArray(nodes)
        ) {
          const graph = assembleGraph(req.body.steps);
          nodes = graph.nodes;
          edges = graph.edges;
          nodeResults = graph.nodeResults;
        }

        const processedNodes = await extractWorkflowFiles(
          nodes,
          project,
          username,
        );
        const processedResults = await extractNodeResultFiles(
          nodeResults,
          project,
          username,
        );

        const now = new Date().toISOString();
        const finalNodes = processedNodes || nodes;

        const meta = computeWorkflowMeta(
          finalNodes as Record<string, unknown>[],
        );

        // Compute totalCost from linked conversations (source of truth for cost)
        let totalCost = 0;
        const convIds = req.body.conversationIds;
        if (Array.isArray(convIds) && convIds.length > 0) {
          const conversations = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .find({ id: { $in: convIds } })
            .project({ totalCost: 1 })
            .toArray();
          totalCost = conversations.reduce(
            (sum: number, record: Record<string, unknown>) =>
              sum + ((record.totalCost as number) || 0),
            0,
          );
        }

        const workflow = {
          ...req.body,
          nodes: finalNodes,
          edges: edges || req.body.edges,
          nodeResults: processedResults || nodeResults,
          source: req.body.source || "prism-client",
          nodeCount: Array.isArray(finalNodes) ? finalNodes.length : 0,
          edgeCount: Array.isArray(edges) ? edges.length : 0,
          ...meta,
          totalCost,
          createdAt: now,
          updatedAt: now,
        };

        const result = await db
          .collection(WORKFLOWS_COLLECTION)
          .insertOne(workflow);
        res.json({ success: true, id: result.insertedId.toString() });
      } catch (error: unknown) {
        logger.error(`POST /workflows error: ${getErrorMessage(error)}`);
        next(error);
      }
    },
  ),
);

/**
 * PUT /workflows/:id
 * Update an existing workflow.
 */
router.put(
  "/:id",
  asyncHandler(
    async (req: CustomRequest, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        let filter: Record<string, unknown>;
        try {
          filter = { _id: new ObjectId(req.params.id as string) };
        } catch {
          filter = { workflowId: req.params.id };
        }

        const project = req.project;
        const username = req.username || null;
        const body = { ...req.body };
        if (Array.isArray(body.nodes)) {
          body.nodes = await extractWorkflowFiles(
            body.nodes,
            project,
            username,
          );
          body.nodeCount = body.nodes.length;

          // Recompute metadata
          Object.assign(body, computeWorkflowMeta(body.nodes));
        }
        if (body.nodeResults && typeof body.nodeResults === "object") {
          body.nodeResults = await extractNodeResultFiles(
            body.nodeResults,
            project,
            username,
          );
        }
        if (Array.isArray(body.edges)) body.edgeCount = body.edges.length;
        const update = {
          $set: {
            ...body,
            updatedAt: new Date().toISOString(),
          },
        };
        delete update.$set._id; // prevent overwriting _id

        const result = await db
          .collection(WORKFLOWS_COLLECTION)
          .updateOne(filter, update);
        if (result.matchedCount === 0)
          return res.status(404).json({ error: "Workflow not found" });

        res.json({ success: true });
      } catch (error: unknown) {
        logger.error(`PUT /workflows/:id error: ${getErrorMessage(error)}`);
        next(error);
      }
    },
  ),
);

/**
 * PATCH /workflows/:id/conversations
 * Append conversation IDs generated during workflow execution.
 * Body: { conversationIds: string[] }
 */
router.patch(
  "/:id/conversations",
  asyncHandler(
    async (req: CustomRequest, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        let filter: Record<string, unknown>;
        try {
          filter = { _id: new ObjectId(req.params.id as string) };
        } catch {
          filter = { workflowId: req.params.id };
        }

        const { conversationIds } = req.body;
        if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
          return res
            .status(400)
            .json({ error: "conversationIds array required" });
        }

        const result = await db
          .collection(WORKFLOWS_COLLECTION)
          .updateOne(filter, {
            // MongoDB PushOperator typing is overly strict for dynamic schemas — cast to Document
            $push: { conversationIds: { $each: conversationIds } } as any,
            $set: { updatedAt: new Date().toISOString() },
          });

        if (result.matchedCount === 0)
          return res.status(404).json({ error: "Workflow not found" });

        // Recompute totalCost from all linked conversations
        // Conversations are the source of truth for cost (they track estimatedCost per message)
        const workflow = await db
          .collection(WORKFLOWS_COLLECTION)
          .findOne(filter);
        const allConvIds = workflow?.conversationIds || [];
        if (allConvIds.length > 0) {
          const conversations = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .find({ id: { $in: allConvIds } })
            .project({ totalCost: 1 })
            .toArray();
          const totalCost = conversations.reduce(
            (sum: number, record: Record<string, unknown>) =>
              sum + ((record.totalCost as number) || 0),
            0,
          );
          await db.collection(WORKFLOWS_COLLECTION).updateOne(filter, {
            $set: { totalCost },
          });
        }

        res.json({ success: true });
      } catch (error: unknown) {
        logger.error(
          `PATCH /workflows/:id/conversations error: ${getErrorMessage(error)}`,
        );
        next(error);
      }
    },
  ),
);

/**
 * DELETE /workflows/:id
 * Delete a workflow by ID.
 */
router.delete(
  "/:id",
  asyncHandler(
    async (req: CustomRequest, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        let filter: Record<string, unknown>;
        try {
          filter = { _id: new ObjectId(req.params.id as string) };
        } catch {
          filter = { workflowId: req.params.id };
        }

        await db.collection(WORKFLOWS_COLLECTION).deleteOne(filter);
        res.json({ success: true });
      } catch (error: unknown) {
        logger.error(`DELETE /workflows/:id error: ${getErrorMessage(error)}`);
        next(error);
      }
    },
  ),
);

// ── Workflow Execution (SSE) ────────────────────────────────

interface WorkflowRunState {
  completedNodes: Record<string, unknown>[];
  activeNodeId: string | null;
  totalNodes: number;
  startedAt: string;
}

const activeWorkflowRuns = new Map<string, AbortController>();
const workflowRunEmitters = new Map<string, EventEmitter>();
const workflowRunStates = new Map<string, WorkflowRunState>();

registerCleanup(async () => {
  if (activeWorkflowRuns.size === 0) return;
  logger.info(
    `[Workflow] Shutdown: aborting ${activeWorkflowRuns.size} active run(s)`,
  );
  for (const [workflowId, controller] of activeWorkflowRuns) {
    controller.abort();
    activeWorkflowRuns.delete(workflowId);
  }
});

/**
 * POST /workflows/:id/run
 * Execute a workflow DAG server-side, streaming progress via SSE.
 *
 * Streams events:
 *   node_start    { nodeId }
 *   node_complete  { nodeId, outputs }
 *   node_error     { nodeId, error }
 *   viewer_partial { nodeId, outputs }
 *   run_complete   { nodeResults, conversationIds, nodeStatuses }
 */
router.post(
  "/:id/run",
  asyncHandler(async (req: CustomRequest, res: Response) => {
    try {
      const { db } = req;

      let filter: Record<string, unknown>;
      try {
        filter = { _id: new ObjectId(req.params.id as string) };
      } catch {
        filter = { workflowId: req.params.id };
      }

      const workflow = await db
        .collection(WORKFLOWS_COLLECTION)
        .findOne(filter);
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      const nodes = workflow.nodes || [];
      const edges = workflow.edges || [];

      if (!Array.isArray(nodes) || nodes.length === 0) {
        return res.status(400).json({ error: "Workflow has no nodes" });
      }

      // Disable timeouts for long-running SSE streams
      req.setTimeout(0);
      if (req.socket) req.socket.setTimeout(0);

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const abortController = createAbortController();
      let clientClosed = false;

      const registryKey = String(req.params.id);
      activeWorkflowRuns.set(registryKey, abortController);

      // Set up pub/sub emitter and state for live reconnection
      const emitter = new EventEmitter();
      emitter.setMaxListeners(20);
      workflowRunEmitters.set(registryKey, emitter);
      workflowRunStates.set(registryKey, {
        completedNodes: [],
        activeNodeId: null,
        totalNodes: nodes.length,
        startedAt: new Date().toISOString(),
      });

      // Keepalive ping every 15s
      const keepalive = setInterval(() => {
        if (clientClosed) return;
        try {
          res.write(":keepalive\n\n");
        } catch {
          /* client already gone */
        }
      }, 15_000);

      const cleanup = () => {
        clientClosed = true;
        clearInterval(keepalive);
        activeWorkflowRuns.delete(registryKey);
        workflowRunEmitters.delete(registryKey);
        workflowRunStates.delete(registryKey);
      };

      req.on("close", () => {
        cleanup();
        abortController.abort();
      });

      const send = (type: string, data: Record<string, unknown>) => {
        if (clientClosed) return;
        try {
          const eventPayload = { type, ...data };
          res.write(`data: ${JSON.stringify(eventPayload)}\n\n`);
          emitter.emit("event", eventPayload);
        } catch {
          /* client already gone */
        }
      };

      // Send initial run info
      send("run_info", { totalNodes: nodes.length });

      // Track node results and statuses during execution
      const nodeResults: Record<string, unknown> = {};
      const nodeStatuses: Record<string, string> = {};

      logger.info(
        `[workflow] Starting execution for workflow ${registryKey} — ${nodes.length} node(s)`,
      );

      const { nodeOutputs, conversationIds } =
        await WorkflowExecutionService.executeWorkflow(
          nodes,
          edges,
          {
            project: req.project || null,
            username: req.username || null,
          },
          {
            signal: abortController.signal,
            onNodeStart: (nodeId: string) => {
              const state = workflowRunStates.get(registryKey);
              if (state) state.activeNodeId = nodeId;
              nodeStatuses[nodeId] = "running";
              send("node_start", { nodeId });
            },
            onNodeComplete: (
              nodeId: string,
              outputs: Record<string, unknown>,
            ) => {
              const state = workflowRunStates.get(registryKey);
              if (state) {
                state.completedNodes.push({ nodeId, outputs });
                state.activeNodeId = null;
              }
              nodeResults[nodeId] = outputs;
              nodeStatuses[nodeId] = "done";
              send("node_complete", { nodeId, outputs });
            },
            onNodeError: (nodeId: string, error: string) => {
              const state = workflowRunStates.get(registryKey);
              if (state) state.activeNodeId = null;
              nodeResults[nodeId] = { error };
              nodeStatuses[nodeId] = "error";
              send("node_error", { nodeId, error });
            },
            onViewerPartial: (
              nodeId: string,
              outputs: Record<string, unknown>,
            ) => {
              send("viewer_partial", { nodeId, outputs });
            },
          },
        );

      // Auto-persist nodeResults and nodeStatuses back to the workflow
      try {
        const processedResults = await extractNodeResultFiles(
          nodeOutputs as Record<string, unknown>,
          req.project || null,
          req.username || null,
        );

        const updatePayload: Record<string, unknown> = {
          nodeResults: processedResults || nodeOutputs,
          nodeStatuses,
          updatedAt: new Date().toISOString(),
        };

        // Auto-link generated conversation IDs
        if (conversationIds.length > 0) {
          updatePayload.conversationIds = [
            ...((workflow.conversationIds as string[]) || []),
            ...conversationIds,
          ];

          // Recompute totalCost from all linked conversations
          const allConversationIds = updatePayload.conversationIds as string[];
          const conversations = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .find({ id: { $in: allConversationIds } })
            .project({ totalCost: 1 })
            .toArray();
          updatePayload.totalCost = conversations.reduce(
            (sum: number, conversation: Record<string, unknown>) =>
              sum + ((conversation.totalCost as number) || 0),
            0,
          );
        }

        await db.collection(WORKFLOWS_COLLECTION).updateOne(filter, {
          $set: updatePayload,
        });
      } catch (persistError: unknown) {
        logger.error(
          `[workflow] Failed to persist results: ${getErrorMessage(persistError)}`,
        );
      }

      // Emit run_complete to followers before cleanup
      const runCompleteData = {
        nodeResults: nodeOutputs,
        conversationIds,
        nodeStatuses,
      };
      emitter.emit("event", { type: "run_complete", ...runCompleteData });
      send("run_complete", runCompleteData);

      if (!clientClosed) res.end();
      cleanup();

      logger.success(
        `[workflow] Execution complete for ${registryKey} — ${conversationIds.length} conversation(s) created`,
      );
    } catch (error: unknown) {
      logger.error(`POST /workflows/:id/run error: ${getErrorMessage(error)}`);
      if (res.headersSent) {
        try {
          res.write(
            `data: ${JSON.stringify({ type: "error", message: getErrorMessage(error) })}\n\n`,
          );
          res.end();
        } catch {
          /* client already gone */
        }
      } else {
        res.status(500).json({ error: "Workflow execution failed" });
      }
    }
  }),
);

/**
 * POST /workflows/:id/abort
 * Explicitly cancel a running workflow execution.
 */
router.post("/:id/abort", (req: Request, res: Response) => {
  const controller = activeWorkflowRuns.get(String(req.params.id));
  if (controller) {
    logger.info(
      `[workflow] Explicit abort requested for workflow ${req.params.id}`,
    );
    controller.abort();
    activeWorkflowRuns.delete(String(req.params.id));
    res.json({ aborted: true });
  } else {
    res.json({
      aborted: false,
      message: "No active run found for this workflow",
    });
  }
});

/**
 * GET /workflows/:id/active
 * Check if a workflow has an active run and return current state.
 */
router.get("/:id/active", (req: Request, res: Response) => {
  const state = workflowRunStates.get(String(req.params.id));
  if (!state) {
    return res.json({ active: false });
  }
  res.json({
    active: true,
    totalNodes: state.totalNodes,
    completedNodes: state.completedNodes,
    activeNodeId: state.activeNodeId,
    startedAt: state.startedAt,
  });
});

/**
 * GET /workflows/:id/follow
 * Reconnect to an in-progress workflow run via SSE.
 * Replays completed node events, then streams live.
 */
router.get("/:id/follow", (req: Request, res: Response) => {
  const state = workflowRunStates.get(String(req.params.id));
  const emitter = workflowRunEmitters.get(String(req.params.id));
  if (!state || !emitter) {
    return res.status(404).json({ error: "No active run for this workflow" });
  }

  // Disable timeouts
  req.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send total node count
  res.write(
    `data: ${JSON.stringify({ type: "run_info", totalNodes: state.totalNodes })}\n\n`,
  );

  // Replay completed nodes
  for (const result of state.completedNodes) {
    res.write(
      `data: ${JSON.stringify({ type: "node_complete", ...result })}\n\n`,
    );
  }

  // Send active node if one is currently running
  if (state.activeNodeId) {
    res.write(
      `data: ${JSON.stringify({ type: "node_start", nodeId: state.activeNodeId })}\n\n`,
    );
  }

  // Subscribe to live events
  const handler = (event: Record<string, unknown>) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* follower disconnected */
    }
  };
  emitter.on("event", handler);

  // Keepalive
  const keepalive = setInterval(() => {
    try {
      res.write(":keepalive\n\n");
    } catch {
      /* gone */
    }
  }, 15_000);

  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(keepalive);
  });
});

export default router;
