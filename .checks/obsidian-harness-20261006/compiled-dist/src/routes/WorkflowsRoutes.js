import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router } from "express";
import { EventEmitter } from "node:events";
import { ObjectId } from "mongodb";
import logger from "../utils/logger.js";
import requireDb from "../middleware/RequireDbMiddleware.js";
import FileService from "../services/FileService.js";
import MinioWrapper from "../wrappers/MinioWrapper.js";
import { assembleGraph } from "../services/WorkflowAssembler.js";
import WorkflowExecutionService from "../services/WorkflowExecutionService.js";
import { createAbortController } from "../utils/AbortController.js";
import { registerCleanup } from "../utils/CleanupRegistry.js";
import { COLLECTIONS, FILE_CATEGORIES } from "../constants.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = Router();
router.use(requireDb);
const WORKFLOWS_COLLECTION = COLLECTIONS.WORKFLOWS;
/** Media fields on messages that may contain base64 data URLs. */
const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];
/**
 * Upload a single value if it's a base64 data URL, returning the minio:// ref.
 * Non-data-URL strings (minio://, http://, etc.) pass through unchanged.
 */
async function uploadIfDataUrl(value, category = FILE_CATEGORIES.UPLOADS, project = null, username = null) {
    if (typeof value === "string" && value.startsWith("data:")) {
        try {
            const { ref } = await FileService.uploadFile(value, category, project, username);
            return ref;
        }
        catch (error) {
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
async function extractWorkflowFiles(nodes, project = null, username = null) {
    if (!Array.isArray(nodes) || !FileService.isExternalStorage())
        return nodes;
    const processed = [];
    for (const node of nodes) {
        const updated = { ...node };
        // 1. Node-level content (asset input nodes store content as a data URL)
        if (typeof updated.content === "string" &&
            updated.content.startsWith("data:")) {
            updated.content = await uploadIfDataUrl(updated.content, FILE_CATEGORIES.UPLOADS, project, username);
        }
        // 2. Messages array (conversation / model nodes)
        if (Array.isArray(updated.messages)) {
            const newMessages = [];
            for (const message of updated.messages) {
                const sanitizedMessage = { ...message };
                for (const field of MEDIA_FIELDS) {
                    const value = sanitizedMessage[field];
                    if (Array.isArray(value)) {
                        const array = [];
                        for (const item of value) {
                            array.push((await uploadIfDataUrl(item, FILE_CATEGORIES.UPLOADS, project, username)));
                        }
                        sanitizedMessage[field] = array;
                    }
                    else if (typeof value === "string" && value.startsWith("data:")) {
                        sanitizedMessage[field] = await uploadIfDataUrl(value, FILE_CATEGORIES.UPLOADS, project, username);
                    }
                }
                newMessages.push(sanitizedMessage);
            }
            updated.messages = newMessages;
        }
        // 3. Viewer nodes store receivedOutputs — same { modality: data } shape
        if (updated.receivedOutputs &&
            typeof updated.receivedOutputs === "object") {
            const newReceived = {};
            for (const [modality, data] of Object.entries(updated.receivedOutputs)) {
                newReceived[modality] = await uploadIfDataUrl(data, FILE_CATEGORIES.UPLOADS, project, username);
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
async function extractNodeResultFiles(nodeResults, project = null, username = null) {
    if (!nodeResults ||
        typeof nodeResults !== "object" ||
        !FileService.isExternalStorage()) {
        return nodeResults;
    }
    const processed = {};
    for (const [nodeId, outputs] of Object.entries(nodeResults)) {
        if (!outputs || typeof outputs !== "object") {
            processed[nodeId] = outputs;
            continue;
        }
        const newOutputs = {};
        for (const [modality, data] of Object.entries(outputs)) {
            // conversation modality is an array of message objects with nested media
            if (modality === "conversation" && Array.isArray(data)) {
                const msgs = [];
                for (const message of data) {
                    const sanitizedMessage = { ...message };
                    for (const field of MEDIA_FIELDS) {
                        const value = sanitizedMessage[field];
                        if (Array.isArray(value)) {
                            const array = [];
                            for (const item of value) {
                                array.push((await uploadIfDataUrl(item, FILE_CATEGORIES.UPLOADS, project, username)));
                            }
                            sanitizedMessage[field] = array;
                        }
                        else if (typeof value === "string" && value.startsWith("data:")) {
                            sanitizedMessage[field] = await uploadIfDataUrl(value, FILE_CATEGORIES.UPLOADS, project, username);
                        }
                    }
                    msgs.push(sanitizedMessage);
                }
                newOutputs[modality] = msgs;
            }
            else {
                newOutputs[modality] = await uploadIfDataUrl(data, FILE_CATEGORIES.UPLOADS, project, username);
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
function resolveMinioRef(value, baseUrl) {
    if (typeof value === "string" && value.startsWith("minio://")) {
        const key = value.replace("minio://", "");
        // Use direct MinIO URL when available, otherwise proxy through Prism
        const minioBase = MinioWrapper.getBucketUrl();
        if (minioBase)
            return `${minioBase}/${key}`;
        return `${baseUrl}/files/${key}`;
    }
    return value;
}
/**
 * Walk a workflow document and replace all minio:// refs with HTTP /files/ URLs
 * so the frontend receives browser-renderable URLs directly.
 */
function resolveWorkflowFileRefs(workflow, baseUrl) {
    // Resolve nodes
    if (Array.isArray(workflow.nodes)) {
        for (const node of workflow.nodes) {
            // Node-level content (asset input nodes)
            if (typeof node.content === "string") {
                node.content = resolveMinioRef(node.content, baseUrl);
            }
            // Messages array (conversation / model nodes)
            if (Array.isArray(node.messages)) {
                for (const message of node
                    .messages) {
                    for (const field of MEDIA_FIELDS) {
                        const value = message[field];
                        if (Array.isArray(value)) {
                            message[field] = value.map((item) => resolveMinioRef(item, baseUrl));
                        }
                        else if (typeof value === "string") {
                            message[field] = resolveMinioRef(value, baseUrl);
                        }
                    }
                }
            }
            // Viewer receivedOutputs
            if (node.receivedOutputs &&
                typeof node.receivedOutputs === "object") {
                for (const [modality, data] of Object.entries(node.receivedOutputs)) {
                    node.receivedOutputs[modality] = resolveMinioRef(data, baseUrl);
                }
            }
        }
    }
    // Resolve nodeResults: { [nodeId]: { [modality]: value | messagesArray } }
    if (workflow.nodeResults && typeof workflow.nodeResults === "object") {
        for (const outputs of Object.values(workflow.nodeResults)) {
            if (!outputs || typeof outputs !== "object")
                continue;
            for (const [modality, data] of Object.entries(outputs)) {
                // conversation modality is an array of message objects with nested media
                if (modality === "conversation" && Array.isArray(data)) {
                    for (const message of data) {
                        for (const field of MEDIA_FIELDS) {
                            const value = message[field];
                            if (Array.isArray(value)) {
                                message[field] = value.map((item) => resolveMinioRef(item, baseUrl));
                            }
                            else if (typeof value === "string") {
                                message[field] = resolveMinioRef(value, baseUrl);
                            }
                        }
                    }
                }
                else {
                    outputs[modality] = resolveMinioRef(data, baseUrl);
                }
            }
        }
    }
    return workflow;
}
function getBaseUrl(req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${proto}://${host}`;
}
/**
 * Compute list-display metadata from workflow nodes.
 * Single source of truth for providers and modalities.
 * Cost is computed separately from linked conversations (PATCH endpoint).
 */
function computeWorkflowMeta(nodes) {
    const providers = [
        ...new Set((nodes || [])
            .filter((record) => !record.nodeType && record.provider)
            .map((record) => record.provider)),
    ];
    const modalities = {};
    for (const record of nodes || []) {
        // Only include boundary nodes: input assets define workflow inputs,
        // viewer nodes define workflow outputs
        if (record.nodeType === "input") {
            for (const tool of record.outputTypes || [])
                modalities[`${tool}In`] = true;
        }
        else if (record.nodeType === "viewer") {
            for (const tool of record.inputTypes || [])
                modalities[`${tool}Out`] = true;
        }
    }
    return { providers, modalities };
}
/**
 * GET /workflows
 * List all saved workflows (metadata only).
 */
router.get("/", asyncHandler(async (req, res, next) => {
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
    }
    catch (error) {
        logger.error(`GET /workflows error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /workflows/:id
 * Get a single workflow by ID (full document).
 */
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
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
    }
    catch (error) {
        logger.error(`GET /workflows/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
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
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const project = req.project;
        const username = req.username || null;
        let { nodes, edges, nodeResults } = req.body;
        // If the payload has steps but no pre-built nodes, assemble the graph
        if (Array.isArray(req.body.steps) &&
            req.body.steps.length > 0 &&
            !Array.isArray(nodes)) {
            const graph = assembleGraph(req.body.steps);
            nodes = graph.nodes;
            edges = graph.edges;
            nodeResults = graph.nodeResults;
        }
        const processedNodes = await extractWorkflowFiles(nodes, project, username);
        const processedResults = await extractNodeResultFiles(nodeResults, project, username);
        const now = new Date().toISOString();
        const finalNodes = processedNodes || nodes;
        const meta = computeWorkflowMeta(finalNodes);
        // Compute totalCost from linked conversations (source of truth for cost)
        let totalCost = 0;
        const convIds = req.body.conversationIds;
        if (Array.isArray(convIds) && convIds.length > 0) {
            const conversations = await db
                .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                .find({ id: { $in: convIds } })
                .project({ totalCost: 1 })
                .toArray();
            totalCost = conversations.reduce((sum, record) => sum + (record.totalCost || 0), 0);
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
    }
    catch (error) {
        logger.error(`POST /workflows error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * PUT /workflows/:id
 * Update an existing workflow.
 */
router.put("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
            filter = { workflowId: req.params.id };
        }
        const project = req.project;
        const username = req.username || null;
        const body = { ...req.body };
        if (Array.isArray(body.nodes)) {
            body.nodes = await extractWorkflowFiles(body.nodes, project, username);
            body.nodeCount = body.nodes.length;
            // Recompute metadata
            Object.assign(body, computeWorkflowMeta(body.nodes));
        }
        if (body.nodeResults && typeof body.nodeResults === "object") {
            body.nodeResults = await extractNodeResultFiles(body.nodeResults, project, username);
        }
        if (Array.isArray(body.edges))
            body.edgeCount = body.edges.length;
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
    }
    catch (error) {
        logger.error(`PUT /workflows/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * PATCH /workflows/:id/conversations
 * Append conversation IDs generated during workflow execution.
 * Body: { conversationIds: string[] }
 */
router.patch("/:id/conversations", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
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
            $push: { conversationIds: { $each: conversationIds } },
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
            const totalCost = conversations.reduce((sum, record) => sum + (record.totalCost || 0), 0);
            await db.collection(WORKFLOWS_COLLECTION).updateOne(filter, {
                $set: { totalCost },
            });
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error(`PATCH /workflows/:id/conversations error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * DELETE /workflows/:id
 * Delete a workflow by ID.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
            filter = { workflowId: req.params.id };
        }
        await db.collection(WORKFLOWS_COLLECTION).deleteOne(filter);
        res.json({ success: true });
    }
    catch (error) {
        logger.error(`DELETE /workflows/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
const activeWorkflowRuns = new Map();
const workflowRunEmitters = new Map();
const workflowRunStates = new Map();
registerCleanup(async () => {
    if (activeWorkflowRuns.size === 0)
        return;
    logger.info(`[Workflow] Shutdown: aborting ${activeWorkflowRuns.size} active run(s)`);
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
router.post("/:id/run", asyncHandler(async (req, res) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
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
        if (req.socket)
            req.socket.setTimeout(0);
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
            if (clientClosed)
                return;
            try {
                res.write(":keepalive\n\n");
            }
            catch {
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
        const send = (type, data) => {
            if (clientClosed)
                return;
            try {
                const eventPayload = { type, ...data };
                res.write(`data: ${JSON.stringify(eventPayload)}\n\n`);
                emitter.emit("event", eventPayload);
            }
            catch {
                /* client already gone */
            }
        };
        // Send initial run info
        send("run_info", { totalNodes: nodes.length });
        // Track node results and statuses during execution
        const nodeResults = {};
        const nodeStatuses = {};
        logger.info(`[workflow] Starting execution for workflow ${registryKey} — ${nodes.length} node(s)`);
        const { nodeOutputs, conversationIds } = await WorkflowExecutionService.executeWorkflow(nodes, edges, {
            project: req.project || null,
            username: req.username || null,
        }, {
            signal: abortController.signal,
            onNodeStart: (nodeId) => {
                const state = workflowRunStates.get(registryKey);
                if (state)
                    state.activeNodeId = nodeId;
                nodeStatuses[nodeId] = "running";
                send("node_start", { nodeId });
            },
            onNodeComplete: (nodeId, outputs) => {
                const state = workflowRunStates.get(registryKey);
                if (state) {
                    state.completedNodes.push({ nodeId, outputs });
                    state.activeNodeId = null;
                }
                nodeResults[nodeId] = outputs;
                nodeStatuses[nodeId] = "done";
                send("node_complete", { nodeId, outputs });
            },
            onNodeError: (nodeId, error) => {
                const state = workflowRunStates.get(registryKey);
                if (state)
                    state.activeNodeId = null;
                nodeResults[nodeId] = { error };
                nodeStatuses[nodeId] = "error";
                send("node_error", { nodeId, error });
            },
            onViewerPartial: (nodeId, outputs) => {
                send("viewer_partial", { nodeId, outputs });
            },
        });
        // Auto-persist nodeResults and nodeStatuses back to the workflow
        try {
            const processedResults = await extractNodeResultFiles(nodeOutputs, req.project || null, req.username || null);
            const updatePayload = {
                nodeResults: processedResults || nodeOutputs,
                nodeStatuses,
                updatedAt: new Date().toISOString(),
            };
            // Auto-link generated conversation IDs
            if (conversationIds.length > 0) {
                updatePayload.conversationIds = [
                    ...(workflow.conversationIds || []),
                    ...conversationIds,
                ];
                // Recompute totalCost from all linked conversations
                const allConversationIds = updatePayload.conversationIds;
                const conversations = await db
                    .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                    .find({ id: { $in: allConversationIds } })
                    .project({ totalCost: 1 })
                    .toArray();
                updatePayload.totalCost = conversations.reduce((sum, conversation) => sum + (conversation.totalCost || 0), 0);
            }
            await db.collection(WORKFLOWS_COLLECTION).updateOne(filter, {
                $set: updatePayload,
            });
        }
        catch (persistError) {
            logger.error(`[workflow] Failed to persist results: ${getErrorMessage(persistError)}`);
        }
        // Emit run_complete to followers before cleanup
        const runCompleteData = {
            nodeResults: nodeOutputs,
            conversationIds,
            nodeStatuses,
        };
        emitter.emit("event", { type: "run_complete", ...runCompleteData });
        send("run_complete", runCompleteData);
        if (!clientClosed)
            res.end();
        cleanup();
        logger.success(`[workflow] Execution complete for ${registryKey} — ${conversationIds.length} conversation(s) created`);
    }
    catch (error) {
        logger.error(`POST /workflows/:id/run error: ${getErrorMessage(error)}`);
        if (res.headersSent) {
            try {
                res.write(`data: ${JSON.stringify({ type: "error", message: getErrorMessage(error) })}\n\n`);
                res.end();
            }
            catch {
                /* client already gone */
            }
        }
        else {
            res.status(500).json({ error: "Workflow execution failed" });
        }
    }
}));
/**
 * POST /workflows/:id/abort
 * Explicitly cancel a running workflow execution.
 */
router.post("/:id/abort", (req, res) => {
    const controller = activeWorkflowRuns.get(String(req.params.id));
    if (controller) {
        logger.info(`[workflow] Explicit abort requested for workflow ${req.params.id}`);
        controller.abort();
        activeWorkflowRuns.delete(String(req.params.id));
        res.json({ aborted: true });
    }
    else {
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
router.get("/:id/active", (req, res) => {
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
router.get("/:id/follow", (req, res) => {
    const state = workflowRunStates.get(String(req.params.id));
    const emitter = workflowRunEmitters.get(String(req.params.id));
    if (!state || !emitter) {
        return res.status(404).json({ error: "No active run for this workflow" });
    }
    // Disable timeouts
    req.setTimeout(0);
    if (req.socket)
        req.socket.setTimeout(0);
    // SSE headers
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    // Send total node count
    res.write(`data: ${JSON.stringify({ type: "run_info", totalNodes: state.totalNodes })}\n\n`);
    // Replay completed nodes
    for (const result of state.completedNodes) {
        res.write(`data: ${JSON.stringify({ type: "node_complete", ...result })}\n\n`);
    }
    // Send active node if one is currently running
    if (state.activeNodeId) {
        res.write(`data: ${JSON.stringify({ type: "node_start", nodeId: state.activeNodeId })}\n\n`);
    }
    // Subscribe to live events
    const handler = (event) => {
        try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        catch {
            /* follower disconnected */
        }
    };
    emitter.on("event", handler);
    // Keepalive
    const keepalive = setInterval(() => {
        try {
            res.write(":keepalive\n\n");
        }
        catch {
            /* gone */
        }
    }, 15_000);
    req.on("close", () => {
        emitter.off("event", handler);
        clearInterval(keepalive);
    });
});
export default router;
//# sourceMappingURL=WorkflowsRoutes.js.map