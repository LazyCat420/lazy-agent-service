import crypto from "crypto";
import { handleConversation, handleAgent } from "../routes/ChatRoutes.js";
import { getProvider } from "../providers/index.js";
import { resolveMediaReference } from "../services/MediaResolutionService.js";
import EmbeddingService from "../services/EmbeddingService.js";
import FileService from "../services/FileService.js";
import MinioWrapper from "../wrappers/MinioWrapper.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { WORKFLOW_ENDPOINTS, FILE_CATEGORIES } from "../constants.js";
// ── Helpers ──────────────────────────────────────────────────
function resolveMinioRefToUrl(value) {
    if (typeof value !== "string")
        return null;
    if (value.startsWith("minio://")) {
        const key = value.replace("minio://", "");
        const minioBase = MinioWrapper.getBucketUrl();
        if (minioBase)
            return `${minioBase}/${key}`;
        return null;
    }
    if (value.startsWith("data:") || value.startsWith("http"))
        return value;
    return null;
}
async function resolveToDataUrl(ref) {
    if (!ref)
        return null;
    if (typeof ref === "object" && ref !== null) {
        const mediaRef = ref;
        if (mediaRef.minioRef)
            return resolveMinioRefToUrl(mediaRef.minioRef);
        const base64 = mediaRef.data || mediaRef.imageData;
        if (base64) {
            const mime = mediaRef.mimeType || "image/png";
            return `data:${mime};base64,${base64}`;
        }
        return null;
    }
    if (typeof ref !== "string")
        return null;
    if (ref.startsWith("data:"))
        return ref;
    return resolveMinioRefToUrl(ref);
}
function resolveEndpoint(node, inputData) {
    const hasAudioInput = inputData.some((datum) => datum.type === "audio");
    const outputsImage = (node.outputTypes || []).includes("image");
    const outputsAudio = (node.outputTypes || []).includes("audio");
    const outputsEmbedding = (node.outputTypes || []).includes("embedding");
    if (outputsEmbedding)
        return WORKFLOW_ENDPOINTS.MODALITY_TO_EMBEDDING;
    if (outputsImage)
        return WORKFLOW_ENDPOINTS.TEXT_TO_IMAGE;
    if (hasAudioInput && !outputsAudio)
        return WORKFLOW_ENDPOINTS.AUDIO_TO_TEXT;
    if (outputsAudio)
        return WORKFLOW_ENDPOINTS.TEXT_TO_SPEECH;
    return WORKFLOW_ENDPOINTS.TEXT_TO_TEXT;
}
// ── Topological Sort ─────────────────────────────────────────
function topologicalSort(nodes, edges) {
    const inDegree = {};
    const adjacency = {};
    for (const node of nodes) {
        inDegree[node.id] = 0;
        adjacency[node.id] = [];
    }
    for (const edge of edges) {
        inDegree[edge.targetNodeId] = (inDegree[edge.targetNodeId] || 0) + 1;
        adjacency[edge.sourceNodeId] = adjacency[edge.sourceNodeId] || [];
        adjacency[edge.sourceNodeId].push(edge.targetNodeId);
    }
    const queue = nodes
        .filter((node) => inDegree[node.id] === 0)
        .map((node) => node.id);
    const sorted = [];
    while (queue.length > 0) {
        const current = queue.shift();
        sorted.push(current);
        for (const neighbor of adjacency[current] || []) {
            inDegree[neighbor]--;
            if (inDegree[neighbor] === 0) {
                queue.push(neighbor);
            }
        }
    }
    return sorted;
}
// ── Single Model Node Execution ──────────────────────────────
async function executeModelNode(node, inputData, context, { toolSchemas, customToolMap, signal, } = {}) {
    const endpoint = resolveEndpoint(node, inputData);
    const outputs = {};
    const conversationId = crypto.randomUUID();
    const nodeLabel = node.label || node.modelName || "Model Node";
    const conversationMeta = {
        title: `🔀 ${nodeLabel} · ${node.provider || "unknown"}/${node.modelName || "unknown"}`,
        systemPrompt: node.systemPrompt || "",
    };
    if (endpoint === WORKFLOW_ENDPOINTS.TEXT_TO_TEXT) {
        const textParts = inputData
            .filter((datum) => datum.type === "text")
            .map((datum) => datum.data);
        const imageParts = inputData
            .filter((datum) => datum.type === "image")
            .map((datum) => datum.data);
        const audioParts = inputData
            .filter((datum) => datum.type === "audio")
            .map((datum) => datum.data);
        const videoParts = inputData
            .filter((datum) => datum.type === "video")
            .map((datum) => datum.data);
        const pdfParts = inputData
            .filter((datum) => datum.type === "pdf")
            .map((datum) => datum.data);
        const conversationParts = inputData
            .filter((datum) => datum.type === "conversation")
            .map((datum) => datum.data);
        const pipedText = textParts.join("\n\n");
        const hasMedia = imageParts.length > 0 ||
            audioParts.length > 0 ||
            videoParts.length > 0 ||
            pdfParts.length > 0;
        const buildMediaFields = (existing = {}) => {
            const fields = {};
            const images = [...(existing.images || []), ...imageParts];
            const audioItems = [...(existing.audio || []), ...audioParts];
            const videoItems = [...(existing.video || []), ...videoParts];
            const pdfItems = [...(existing.pdf || []), ...pdfParts];
            if (images.length > 0)
                fields.images = images;
            if (audioItems.length > 0)
                fields.audio = audioItems;
            if (videoItems.length > 0)
                fields.video = videoItems;
            if (pdfItems.length > 0)
                fields.pdf = pdfItems;
            return fields;
        };
        let finalMessages;
        if (conversationParts.length > 0) {
            finalMessages = conversationParts[0]
                .map((message) => ({
                role: message.role,
                content: message.content || "",
                ...(message.images && message.images.length > 0
                    ? { images: message.images }
                    : {}),
                ...(message.audio && message.audio.length > 0
                    ? { audio: message.audio }
                    : {}),
                ...(message.video && message.video.length > 0
                    ? { video: message.video }
                    : {}),
                ...(message.pdf && message.pdf.length > 0
                    ? { pdf: message.pdf }
                    : {}),
            }))
                .filter((message) => message.content ||
                (message.images && message.images.length > 0) ||
                (message.audio && message.audio.length > 0) ||
                (message.video && message.video.length > 0) ||
                (message.pdf && message.pdf.length > 0));
            const lastUserIndex = finalMessages
                .map((message, index) => ({ message, index }))
                .filter(({ message }) => message.role === "user")
                .pop()?.index;
            if (lastUserIndex !== undefined && (pipedText || hasMedia)) {
                const lastUser = finalMessages[lastUserIndex];
                finalMessages[lastUserIndex] = {
                    ...lastUser,
                    content: pipedText
                        ? lastUser.content
                            ? `${lastUser.content}\n\n${pipedText}`
                            : pipedText
                        : lastUser.content,
                    ...buildMediaFields(lastUser),
                };
            }
            else if (pipedText || hasMedia) {
                finalMessages.push({
                    role: "user",
                    content: pipedText || "",
                    ...buildMediaFields(),
                });
            }
        }
        else if (node.messages && node.messages.length > 0) {
            finalMessages = node.messages.map((message) => ({
                role: message.role,
                content: message.content || "",
                ...(message.images && message.images.length > 0
                    ? { images: message.images }
                    : {}),
                ...(message.audio && message.audio.length > 0
                    ? { audio: message.audio }
                    : {}),
                ...(message.video && message.video.length > 0
                    ? { video: message.video }
                    : {}),
                ...(message.pdf && message.pdf.length > 0 ? { pdf: message.pdf } : {}),
            }));
            const lastUserIndex = finalMessages
                .map((message, index) => ({ message, index }))
                .filter(({ message }) => message.role === "user")
                .pop()?.index;
            if (lastUserIndex !== undefined && (pipedText || hasMedia)) {
                const lastUser = finalMessages[lastUserIndex];
                finalMessages[lastUserIndex] = {
                    ...lastUser,
                    content: pipedText
                        ? lastUser.content
                            ? `${lastUser.content}\n\n${pipedText}`
                            : pipedText
                        : lastUser.content,
                    ...buildMediaFields(lastUser),
                };
            }
            else if (pipedText || hasMedia) {
                finalMessages.push({
                    role: "user",
                    content: pipedText || "",
                    ...buildMediaFields(),
                });
            }
        }
        else {
            const userMessage = {
                role: "user",
                content: pipedText || "",
                ...buildMediaFields(),
            };
            finalMessages = [userMessage];
        }
        // Collect events from handleConversation/handleAgent to extract response
        const collectedEvents = [];
        const emitCollector = (event) => {
            collectedEvents.push(event);
        };
        const generationParams = {
            provider: node.provider,
            model: node.modelName,
            messages: finalMessages,
            conversationId,
            conversationMeta,
            project: context.project,
            username: context.username,
            skipConversation: false,
        };
        if (toolSchemas !== null && toolSchemas !== undefined) {
            // Route through agent handler for tool-enabled runs
            generationParams.enabledTools = toolSchemas.map((tool) => tool.function?.name || "");
            generationParams.functionCallingEnabled = true;
            generationParams.agenticLoopEnabled = true;
            generationParams.autoApprove = true;
            generationParams.maxIterations = 10;
            await handleAgent(generationParams, emitCollector, { signal });
        }
        else {
            await handleConversation(generationParams, emitCollector, { signal });
        }
        // Extract text response from collected events
        const errorEvent = collectedEvents.find((event) => event.type === "error");
        if (errorEvent) {
            throw new Error(errorEvent.message || "Model generation failed");
        }
        const textResponse = collectedEvents
            .filter((event) => event.type === "chunk")
            .map((event) => event.content)
            .join("");
        outputs.text = textResponse || "";
        // Check for inline images in response
        const imageEvent = collectedEvents.find((event) => event.type === "image");
        if (imageEvent) {
            if (imageEvent.minioRef) {
                outputs.image =
                    (await resolveToDataUrl(imageEvent.minioRef)) || undefined;
            }
            else if (imageEvent.data) {
                const mime = imageEvent.mimeType || "image/png";
                outputs.image = `data:${mime};base64,${imageEvent.data}`;
            }
        }
    }
    else if (endpoint === WORKFLOW_ENDPOINTS.TEXT_TO_IMAGE) {
        const pipedPrompt = inputData.find((datum) => datum.type === "text")?.data || "";
        const rawImages = inputData
            .filter((datum) => datum.type === "image")
            .map((datum) => datum.data);
        const conversationParts = inputData
            .filter((datum) => datum.type === "conversation")
            .map((datum) => datum.data);
        let prompt;
        let systemPrompt;
        const messageImages = [];
        if (conversationParts.length > 0) {
            const conversationMessages = conversationParts[0].filter((message) => message.content ||
                (message.images && message.images.length > 0) ||
                message.audio);
            const systemMessage = conversationMessages.find((message) => message.role === "system");
            const userMessages = conversationMessages.filter((message) => message.role === "user");
            const lastUser = userMessages[userMessages.length - 1];
            systemPrompt = systemMessage?.content || undefined;
            const userContent = lastUser?.content || "";
            prompt = pipedPrompt
                ? userContent
                    ? `${userContent}\n\n${pipedPrompt}`
                    : pipedPrompt
                : userContent;
            userMessages.forEach((message) => {
                if (message.images && message.images.length > 0)
                    messageImages.push(...message.images);
            });
        }
        else if (node.messages && node.messages.length > 0) {
            const systemMessage = node.messages.find((message) => message.role === "system");
            const userMessages = node.messages.filter((message) => message.role === "user");
            const lastUser = userMessages[userMessages.length - 1];
            systemPrompt = systemMessage?.content || undefined;
            const userContent = lastUser?.content || "";
            prompt = pipedPrompt
                ? userContent
                    ? `${userContent}\n\n${pipedPrompt}`
                    : pipedPrompt
                : userContent;
            userMessages.forEach((message) => {
                if (message.images && message.images.length > 0)
                    messageImages.push(...message.images);
            });
        }
        else {
            systemPrompt = undefined;
            prompt = pipedPrompt;
        }
        const allRawImages = [...rawImages, ...messageImages];
        const imagePayloads = allRawImages.map((image) => {
            if (typeof image === "string" && image.startsWith("data:")) {
                return image;
            }
            return typeof image === "object" ? image : image;
        });
        // Build messages for chat endpoint
        const imageMessages = [];
        if (systemPrompt) {
            imageMessages.push({ role: "system", content: systemPrompt });
        }
        const userMessage = {
            role: "user",
            content: prompt || "",
        };
        if (imagePayloads.length > 0) {
            userMessage.images = imagePayloads;
        }
        imageMessages.push(userMessage);
        const collectedEvents = [];
        await handleConversation({
            provider: node.provider,
            model: node.modelName,
            messages: imageMessages,
            conversationId,
            conversationMeta,
            project: context.project,
            username: context.username,
            skipConversation: false,
        }, (event) => {
            collectedEvents.push(event);
        });
        const errorEvent = collectedEvents.find((event) => event.type === "error");
        if (errorEvent) {
            throw new Error(errorEvent.message || "Image generation failed");
        }
        const imageEvent = collectedEvents.find((event) => event.type === "image");
        if (imageEvent) {
            if (imageEvent.minioRef) {
                outputs.image =
                    (await resolveToDataUrl(imageEvent.minioRef)) || undefined;
            }
            else if (imageEvent.data) {
                const mime = imageEvent.mimeType || "image/png";
                outputs.image = `data:${mime};base64,${imageEvent.data}`;
            }
        }
        const textResponse = collectedEvents
            .filter((event) => event.type === "chunk")
            .map((event) => event.content)
            .join("");
        if (textResponse) {
            outputs.text = textResponse;
        }
    }
    else if (endpoint === WORKFLOW_ENDPOINTS.AUDIO_TO_TEXT) {
        const audioData = inputData.find((datum) => datum.type === "audio")?.data || "";
        const provider = getProvider(node.provider || "");
        if (!provider.transcribeAudio) {
            throw new Error(`Provider "${node.provider}" does not support audio transcription`);
        }
        const resolvedAudio = await resolveMediaReference(audioData, context.project || "", context.username || "");
        const audioUrl = resolvedAudio.providerRef;
        let audioBuffer;
        let mimeType = "audio/mpeg";
        const dataUrlMatch = audioUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUrlMatch) {
            mimeType = dataUrlMatch[1];
            audioBuffer = Buffer.from(dataUrlMatch[2], "base64");
        }
        else {
            audioBuffer = Buffer.from(audioUrl, "base64");
        }
        const transcribeOptions = {};
        if (node.userPrompt)
            transcribeOptions.prompt = node.userPrompt;
        else if (node.systemPrompt)
            transcribeOptions.prompt = node.systemPrompt;
        const result = await provider.transcribeAudio(audioBuffer, mimeType, node.modelName, transcribeOptions);
        outputs.text = result.text || "";
    }
    else if (endpoint === WORKFLOW_ENDPOINTS.TEXT_TO_SPEECH) {
        const textData = inputData.find((datum) => datum.type === "text")?.data || "";
        const provider = getProvider(node.provider || "");
        if (!provider.generateSpeech) {
            throw new Error(`Provider "${node.provider}" does not support text-to-speech`);
        }
        const result = await provider.generateSpeech(textData, undefined, {
            model: node.modelName,
        });
        const audioChunks = [];
        if (!result.stream) {
            throw new Error("Speech generation returned no stream");
        }
        const stream = result.stream;
        if ("pipe" in stream && typeof stream.pipe === "function") {
            const nodeStream = stream;
            for await (const chunk of nodeStream) {
                audioChunks.push(Buffer.from(chunk));
            }
        }
        else {
            const webStream = stream;
            const reader = webStream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value)
                    audioChunks.push(Buffer.from(value));
            }
        }
        const contentType = result.contentType || "audio/mpeg";
        const audioBuffer = Buffer.concat(audioChunks);
        // Upload to MinIO if available
        let audioUrl;
        try {
            const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
            const { ref } = await FileService.uploadFile(dataUrl, FILE_CATEGORIES.GENERATIONS, context.project, context.username);
            audioUrl = resolveMinioRefToUrl(ref) || dataUrl;
        }
        catch {
            audioUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
        }
        outputs.audio = audioUrl;
    }
    else if (endpoint === WORKFLOW_ENDPOINTS.MODALITY_TO_EMBEDDING) {
        const textParts = inputData
            .filter((datum) => datum.type === "text")
            .map((datum) => datum.data);
        const imageParts = inputData
            .filter((datum) => datum.type === "image")
            .map((datum) => datum.data);
        const audioPart = inputData.find((datum) => datum.type === "audio")?.data;
        const pipedText = textParts.join("\n\n");
        const combinedText = node.userPrompt
            ? pipedText
                ? `${node.userPrompt}\n\n${pipedText}`
                : node.userPrompt
            : pipedText;
        let content;
        const isMultimodal = imageParts.length > 0 || !!audioPart;
        if (!isMultimodal && combinedText) {
            content = combinedText;
        }
        else {
            const parts = [];
            if (combinedText)
                parts.push({ text: combinedText });
            const parseDataUrl = (data, fallbackMime) => {
                if (typeof data === "string" && data.includes(";base64,")) {
                    const segments = data.split(";base64,");
                    return {
                        data: segments[1],
                        mimeType: segments[0].replace("data:", ""),
                    };
                }
                return { data, mimeType: fallbackMime };
            };
            for (const image of imageParts) {
                const resolvedImage = await resolveMediaReference(image, context.project || "", context.username || "");
                const { data, mimeType } = parseDataUrl(resolvedImage.providerRef, "image/jpeg");
                parts.push({ inlineData: { data, mimeType } });
            }
            if (audioPart) {
                const resolvedAudio = await resolveMediaReference(audioPart, context.project || "", context.username || "");
                const { data, mimeType } = parseDataUrl(resolvedAudio.providerRef, "audio/mpeg");
                parts.push({ inlineData: { data, mimeType } });
            }
            content = parts;
        }
        const result = await EmbeddingService.generate(content, {
            provider: node.provider,
            model: node.modelName,
            project: context.project || undefined,
            username: context.username || undefined,
            source: "workflow",
            endpoint: "/workflows/run",
        });
        outputs.embedding = result.embedding;
    }
    return { outputs, conversationId };
}
// ── Main Workflow Executor ───────────────────────────────────
async function executeWorkflow(nodes, edges, context, callbacks) {
    const sortedIds = topologicalSort(nodes, edges);
    const nodeMap = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const nodeOutputs = {};
    const generatedConversationIds = [];
    // Pre-compute which viewers each node feeds into
    const viewerEdgesBySource = {};
    for (const edge of edges) {
        const targetNode = nodeMap[edge.targetNodeId];
        if (targetNode?.nodeType === "viewer") {
            (viewerEdgesBySource[edge.sourceNodeId] ??= []).push(edge);
        }
    }
    const viewerPartials = {};
    const erroredNodeIds = new Set();
    for (const nodeId of sortedIds) {
        // Check abort signal before each node
        if (callbacks.signal?.aborted) {
            logger.info(`[workflow] Aborting — signal received before node ${nodeId}`);
            break;
        }
        const node = nodeMap[nodeId];
        if (!node)
            continue;
        // Skip nodes with errored upstream dependencies
        const incomingEdges = edges.filter((edge) => edge.targetNodeId === nodeId);
        const hasErroredUpstream = incomingEdges.some((edge) => erroredNodeIds.has(edge.sourceNodeId));
        if (hasErroredUpstream) {
            erroredNodeIds.add(nodeId);
            nodeOutputs[nodeId] = {};
            continue;
        }
        try {
            callbacks.onNodeStart?.(nodeId);
            // ── Input nodes ────────────────────────────────────────────
            if (node.nodeType === "input") {
                if (node.modality === "conversation") {
                    const messages = structuredClone(node.messages || []);
                    const incomingConnections = edges.filter((edge) => edge.targetNodeId === nodeId);
                    for (const connection of incomingConnections) {
                        const sourceOutput = nodeOutputs[connection.sourceNodeId];
                        if (!sourceOutput)
                            continue;
                        const data = sourceOutput[connection.sourceModality];
                        if (!data)
                            continue;
                        const dotIndex = connection.targetModality.indexOf(".");
                        if (dotIndex === -1)
                            continue;
                        const messageIndex = parseInt(connection.targetModality.substring(0, dotIndex));
                        const modality = connection.targetModality.substring(dotIndex + 1);
                        if (messageIndex < 0 || messageIndex >= messages.length)
                            continue;
                        const message = messages[messageIndex];
                        if (modality === "text") {
                            message.content = message.content
                                ? `${message.content}\n\n${data}`
                                : data;
                        }
                        else if (modality === "image") {
                            message.images = [
                                ...(message.images || []),
                                data,
                            ];
                        }
                        else if (modality === "audio") {
                            message.audio = [
                                ...(message.audio || []),
                                data,
                            ];
                        }
                        else if (modality === "video") {
                            message.video = [
                                ...(message.video || []),
                                data,
                            ];
                        }
                        else if (modality === "pdf") {
                            message.pdf = [
                                ...(message.pdf || []),
                                data,
                            ];
                        }
                    }
                    nodeOutputs[nodeId] = { conversation: messages };
                }
                else {
                    nodeOutputs[nodeId] = node.modality
                        ? { [node.modality]: node.content || "" }
                        : {};
                }
                callbacks.onNodeComplete?.(nodeId, nodeOutputs[nodeId]);
                // Push partial updates to connected viewers
                if (viewerEdgesBySource[nodeId]) {
                    for (const edge of viewerEdgesBySource[nodeId]) {
                        const data = nodeOutputs[nodeId]?.[edge.sourceModality];
                        if (data) {
                            viewerPartials[edge.targetNodeId] ??= {};
                            viewerPartials[edge.targetNodeId][edge.targetModality] = data;
                            callbacks.onViewerPartial?.(edge.targetNodeId, {
                                ...viewerPartials[edge.targetNodeId],
                            });
                        }
                    }
                }
                continue;
            }
            // ── Tool nodes ─────────────────────────────────────────────
            if (node.nodeType === "tools") {
                const disabled = new Set(node.disabledTools || []);
                const builtIn = (node.builtInTools || []).filter((tool) => !disabled.has(tool.name));
                const custom = (node.customTools || []).filter((tool) => !disabled.has(tool.name || tool._id || ""));
                const schemas = [
                    ...builtIn.map((tool) => ({
                        type: "function",
                        function: {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.parameters || {
                                type: "object",
                                properties: {},
                                required: [],
                            },
                        },
                    })),
                    ...custom.map((tool) => {
                        const properties = {};
                        const required = [];
                        for (const parameter of tool.parameters || []) {
                            if (!parameter.name)
                                continue;
                            properties[parameter.name] = {
                                type: parameter.type || "string",
                                description: parameter.description || "",
                                ...(parameter.enum && parameter.enum.length > 0
                                    ? { enum: parameter.enum }
                                    : {}),
                            };
                            if (parameter.required)
                                required.push(parameter.name);
                        }
                        return {
                            type: "function",
                            function: {
                                name: tool.name,
                                description: tool.description || "",
                                parameters: { type: "object", properties, required },
                            },
                        };
                    }),
                ];
                const customMap = new Map();
                for (const tool of custom) {
                    customMap.set(tool.name, tool);
                }
                nodeOutputs[nodeId] = { tools: { schemas, customMap } };
                callbacks.onNodeComplete?.(nodeId, {});
                continue;
            }
            // ── Viewer nodes ───────────────────────────────────────────
            if (node.nodeType === "viewer") {
                const incomingConnections = edges.filter((edge) => edge.targetNodeId === nodeId);
                const collectedOutputs = {};
                for (const connection of incomingConnections) {
                    const sourceOutputs = nodeOutputs[connection.sourceNodeId];
                    if (sourceOutputs &&
                        sourceOutputs[connection.sourceModality] !== undefined) {
                        collectedOutputs[connection.targetModality] =
                            sourceOutputs[connection.sourceModality];
                    }
                }
                nodeOutputs[nodeId] = collectedOutputs;
                callbacks.onNodeComplete?.(nodeId, collectedOutputs);
                continue;
            }
            // ── Model nodes ────────────────────────────────────────────
            const incomingConnections = edges.filter((edge) => edge.targetNodeId === nodeId);
            const inputData = [];
            for (const connection of incomingConnections) {
                const sourceOutputs = nodeOutputs[connection.sourceNodeId];
                if (sourceOutputs &&
                    sourceOutputs[connection.sourceModality] !== undefined) {
                    inputData.push({
                        type: connection.targetModality,
                        data: sourceOutputs[connection.sourceModality],
                        sourceNodeId: connection.sourceNodeId,
                    });
                }
            }
            // Separate tool inputs from regular modality inputs
            const toolInputs = inputData.filter((datum) => datum.type === "tools");
            const regularInputData = inputData.filter((datum) => datum.type !== "tools");
            let toolSchemas = null;
            let customToolMap = null;
            if (toolInputs.length > 0) {
                toolSchemas = [];
                customToolMap = new Map();
                for (const toolInput of toolInputs) {
                    const toolData = toolInput.data;
                    if (toolData?.schemas)
                        toolSchemas.push(...toolData.schemas);
                    if (toolData?.customMap) {
                        for (const [key, value] of toolData.customMap)
                            customToolMap.set(key, value);
                    }
                }
            }
            // Include static inputs attached to the node
            if (node.staticInputs) {
                for (const [modality, data] of Object.entries(node.staticInputs)) {
                    if (data) {
                        regularInputData.push({ type: modality, data, sourceNodeId: null });
                    }
                }
            }
            // Execute the model
            logger.info(`[workflow] ▶ Executing node ${nodeId} (${node.provider}/${node.modelName})`);
            const { outputs, conversationId } = await executeModelNode(node, regularInputData, context, { toolSchemas, customToolMap, signal: callbacks.signal });
            nodeOutputs[nodeId] = outputs;
            if (conversationId)
                generatedConversationIds.push(conversationId);
            callbacks.onNodeComplete?.(nodeId, outputs);
            // Push partial updates to connected viewers
            if (viewerEdgesBySource[nodeId]) {
                for (const edge of viewerEdgesBySource[nodeId]) {
                    const data = outputs[edge.sourceModality];
                    if (data) {
                        viewerPartials[edge.targetNodeId] ??= {};
                        viewerPartials[edge.targetNodeId][edge.targetModality] = data;
                        callbacks.onViewerPartial?.(edge.targetNodeId, {
                            ...viewerPartials[edge.targetNodeId],
                        });
                    }
                }
            }
            logger.info(`[workflow] ✅ Node ${nodeId} complete`);
        }
        catch (error) {
            erroredNodeIds.add(nodeId);
            logger.error(`[workflow] ❌ Node ${nodeId} error: ${getErrorMessage(error)}`);
            callbacks.onNodeError?.(nodeId, getErrorMessage(error));
            nodeOutputs[nodeId] = {};
        }
    }
    return { nodeOutputs, conversationIds: generatedConversationIds };
}
// ── Public API ───────────────────────────────────────────────
const WorkflowExecutionService = {
    executeWorkflow,
    topologicalSort,
    resolveMinioRefToUrl,
    resolveToDataUrl,
    resolveEndpoint,
    executeModelNode,
};
export default WorkflowExecutionService;
//# sourceMappingURL=WorkflowExecutionService.js.map