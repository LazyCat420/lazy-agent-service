import crypto from "crypto";
import { handleConversation, handleAgent } from "../core/chat/ChatGeneration.ts";
import { getProvider } from "../providers/index.ts";
import { resolveMediaReference } from "../services/MediaResolutionService.ts";
import EmbeddingService from "../services/EmbeddingService.ts";
import FileService from "../services/FileService.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { WORKFLOW_ENDPOINTS, FILE_CATEGORIES } from "../constants.ts";
import type { SseEvent } from "../types/SseTypes.ts";

// ── Types ────────────────────────────────────────────────────

interface WorkflowMessage {
  role?: string;
  content?: string;
  images?: string[];
  audio?: string[];
  video?: string[];
  pdf?: string[];
}

interface WorkflowInputDatum {
  type: string;
  data: unknown;
  sourceNodeId: string | null;
}

interface WorkflowOutputs {
  text?: string;
  image?: string;
  audio?: string;
  embedding?: number[];
  conversation?: unknown[];
  tools?: {
    schemas: ToolSchemaEntry[];
    customMap: Map<string, WorkflowCustomTool>;
  };
  [key: string]: unknown;
}

interface ToolSchemaEntry {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface WorkflowCustomTool {
  name: string;
  description?: string;
  parameters?: Array<{
    name: string;
    type?: string;
    description?: string;
    required?: boolean;
    enum?: string[];
  }>;
  implementation?: string;
  _id?: string;
}

interface WorkflowModelNode {
  id: string;
  nodeType: string;
  label?: string;
  provider?: string;
  modelName?: string;
  modality?: string | null;
  content?: string;
  systemPrompt?: string;
  userPrompt?: string;
  outputTypes?: string[];
  messages?: WorkflowMessage[];
  staticInputs?: Record<string, unknown>;
  disabledTools?: string[];
  builtInTools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  customTools?: WorkflowCustomTool[];
}

interface WorkflowEdge {
  id?: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceModality: string;
  targetModality: string;
}

export interface WorkflowExecutionCallbacks {
  onNodeStart?: (nodeId: string) => void;
  onNodeComplete?: (nodeId: string, outputs: WorkflowOutputs) => void;
  onNodeError?: (nodeId: string, error: string) => void;
  onViewerPartial?: (nodeId: string, outputs: WorkflowOutputs) => void;
  signal?: AbortSignal;
}

interface ExecutionContext {
  project: string | null;
  username: string | null;
}

// ── Helpers ──────────────────────────────────────────────────

function resolveMinioRefToUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("minio://")) {
    const key = value.replace("minio://", "");
    const minioBase = MinioWrapper.getBucketUrl();
    if (minioBase) return `${minioBase}/${key}`;
    return null;
  }
  if (value.startsWith("data:") || value.startsWith("http")) return value;
  return null;
}

async function resolveToDataUrl(ref: unknown): Promise<string | null> {
  if (!ref) return null;

  if (typeof ref === "object" && ref !== null) {
    const mediaRef = ref as {
      data?: string;
      imageData?: string;
      mimeType?: string;
      minioRef?: string;
    };
    if (mediaRef.minioRef) return resolveMinioRefToUrl(mediaRef.minioRef);
    const base64 = mediaRef.data || mediaRef.imageData;
    if (base64) {
      const mime = mediaRef.mimeType || "image/png";
      return `data:${mime};base64,${base64}`;
    }
    return null;
  }

  if (typeof ref !== "string") return null;
  if (ref.startsWith("data:")) return ref;
  return resolveMinioRefToUrl(ref);
}

function resolveEndpoint(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
): string {
  const hasAudioInput = inputData.some((datum) => datum.type === "audio");
  const outputsImage = (node.outputTypes || []).includes("image");
  const outputsAudio = (node.outputTypes || []).includes("audio");
  const outputsEmbedding = (node.outputTypes || []).includes("embedding");

  if (outputsEmbedding) return WORKFLOW_ENDPOINTS.MODALITY_TO_EMBEDDING;
  if (outputsImage) return WORKFLOW_ENDPOINTS.TEXT_TO_IMAGE;
  if (hasAudioInput && !outputsAudio) return WORKFLOW_ENDPOINTS.AUDIO_TO_TEXT;
  if (outputsAudio) return WORKFLOW_ENDPOINTS.TEXT_TO_SPEECH;
  return WORKFLOW_ENDPOINTS.TEXT_TO_TEXT;
}

// ── Topological Sort ─────────────────────────────────────────

function topologicalSort(
  nodes: WorkflowModelNode[],
  edges: WorkflowEdge[],
): string[] {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};

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
  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
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

interface WorkflowMediaFields {
  images?: string[];
  audio?: string[];
  video?: string[];
  pdf?: string[];
}

interface ExtractedModalityParts {
  textParts: unknown[];
  imageParts: unknown[];
  audioParts: unknown[];
  videoParts: unknown[];
  pdfParts: unknown[];
  conversationParts: unknown[];
  pipedText: string;
  hasMedia: boolean;
}

function extractModalityPartsFromInputs(inputData: WorkflowInputDatum[]): ExtractedModalityParts {
  const textParts = inputData.filter((d) => d.type === "text").map((d) => d.data);
  const imageParts = inputData.filter((d) => d.type === "image").map((d) => d.data);
  const audioParts = inputData.filter((d) => d.type === "audio").map((d) => d.data);
  const videoParts = inputData.filter((d) => d.type === "video").map((d) => d.data);
  const pdfParts = inputData.filter((d) => d.type === "pdf").map((d) => d.data);
  const conversationParts = inputData.filter((d) => d.type === "conversation").map((d) => d.data);
  const hasMedia = Boolean(
    imageParts.length || audioParts.length || videoParts.length || pdfParts.length,
  );
  return {
    textParts,
    imageParts,
    audioParts,
    videoParts,
    pdfParts,
    conversationParts,
    pipedText: textParts.join("\n\n"),
    hasMedia,
  };
}

function buildWorkflowMediaFields(
  parts: ExtractedModalityParts,
  existing: WorkflowMediaFields = {},
): WorkflowMediaFields {
  const fields: WorkflowMediaFields = {};
  const images = [...(existing.images || []), ...parts.imageParts] as string[];
  const audioItems = [...(existing.audio || []), ...parts.audioParts] as string[];
  const videoItems = [...(existing.video || []), ...parts.videoParts] as string[];
  const pdfItems = [...(existing.pdf || []), ...parts.pdfParts] as string[];
  if (images.length > 0) fields.images = images;
  if (audioItems.length > 0) fields.audio = audioItems;
  if (videoItems.length > 0) fields.video = videoItems;
  if (pdfItems.length > 0) fields.pdf = pdfItems;
  return fields;
}

function normalizeWorkflowMessageMedia(message: WorkflowMessage): WorkflowMessage {
  const copy: WorkflowMessage = {
    role: message.role,
    content: message.content || "",
  };
  if (message.images && message.images.length > 0) copy.images = message.images;
  if (message.audio && message.audio.length > 0) copy.audio = message.audio;
  if (message.video && message.video.length > 0) copy.video = message.video;
  if (message.pdf && message.pdf.length > 0) copy.pdf = message.pdf;
  return copy;
}

function hasWorkflowMessageContentOrMedia(message: WorkflowMessage): boolean {
  if (message.content) return true;
  if (message.images && message.images.length > 0) return true;
  if (message.audio && message.audio.length > 0) return true;
  if (message.video && message.video.length > 0) return true;
  return Boolean(message.pdf && message.pdf.length > 0);
}

function mergePipedTextAndMediaIntoMessages(
  messages: WorkflowMessage[],
  parts: ExtractedModalityParts,
): void {
  if (!parts.pipedText && !parts.hasMedia) return;
  const lastUserIndex = messages
    .map((message, index: number) => ({ message, index }))
    .filter(({ message }) => message.role === "user")
    .pop()?.index;

  if (lastUserIndex === undefined) {
    messages.push({
      role: "user",
      content: parts.pipedText || "",
      ...buildWorkflowMediaFields(parts),
    });
    return;
  }
  const lastUser = messages[lastUserIndex];
  const mergedContent = parts.pipedText
    ? lastUser.content
      ? `${lastUser.content}\n\n${parts.pipedText}`
      : parts.pipedText
    : lastUser.content;
  messages[lastUserIndex] = {
    ...lastUser,
    content: mergedContent,
    ...buildWorkflowMediaFields(parts, lastUser),
  };
}

function buildTextToTextWorkflowMessages(
  node: WorkflowModelNode,
  parts: ExtractedModalityParts,
): WorkflowMessage[] {
  if (parts.conversationParts.length > 0) {
    const finalMessages = (parts.conversationParts[0] as WorkflowMessage[])
      .map(normalizeWorkflowMessageMedia)
      .filter(hasWorkflowMessageContentOrMedia);
    mergePipedTextAndMediaIntoMessages(finalMessages, parts);
    return finalMessages;
  }
  if (node.messages && node.messages.length > 0) {
    const finalMessages = node.messages.map(normalizeWorkflowMessageMedia);
    mergePipedTextAndMediaIntoMessages(finalMessages, parts);
    return finalMessages;
  }
  return [
    {
      role: "user",
      content: parts.pipedText || "",
      ...buildWorkflowMediaFields(parts),
    },
  ];
}

async function resolveCollectedImageEventUrl(
  collectedEvents: SseEvent[],
): Promise<string | undefined> {
  const imageEvent = collectedEvents.find((event) => event.type === "image");
  if (!imageEvent) return undefined;
  if (imageEvent.minioRef) {
    return (await resolveToDataUrl(imageEvent.minioRef)) || undefined;
  }
  if (imageEvent.data) {
    const mime = imageEvent.mimeType || "image/png";
    return `data:${mime};base64,${imageEvent.data}`;
  }
  return undefined;
}

async function executeTextToTextModelNode(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
  context: ExecutionContext,
  conversationId: string,
  conversationMeta: { title: string; systemPrompt: string },
  toolSchemas: ToolSchemaEntry[] | null | undefined,
  signal: AbortSignal | undefined,
  outputs: WorkflowOutputs,
): Promise<void> {
  const parts = extractModalityPartsFromInputs(inputData);
  const finalMessages = buildTextToTextWorkflowMessages(node, parts);

  const collectedEvents: SseEvent[] = [];
  const emitCollector = (event: SseEvent) => {
    collectedEvents.push(event);
  };

  const generationParams: Record<string, unknown> = {
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
    generationParams.enabledTools = toolSchemas.map((tool) => tool.function?.name || "");
    generationParams.functionCallingEnabled = true;
    generationParams.agenticLoopEnabled = true;
    generationParams.autoApprove = true;
    generationParams.maxIterations = 10;
    await handleAgent(generationParams, emitCollector, { signal });
  } else {
    await handleConversation(generationParams, emitCollector, { signal });
  }

  const errorEvent = collectedEvents.find((event) => event.type === "error");
  if (errorEvent) {
    throw new Error(errorEvent.message || "Model generation failed");
  }

  outputs.text =
    collectedEvents
      .filter((event) => event.type === "chunk")
      .map((event) => event.content)
      .join("") || "";

  const resolvedImage = await resolveCollectedImageEventUrl(collectedEvents);
  if (resolvedImage !== undefined) {
    outputs.image = resolvedImage;
  }
}

function extractPromptAndImagesFromMessages(
  messages: WorkflowMessage[],
  pipedPrompt: string,
): { prompt: string; systemPrompt: string | undefined; messageImages: unknown[] } {
  const systemMessage = messages.find((message) => message.role === "system");
  const userMessages = messages.filter((message) => message.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const systemPrompt = (systemMessage?.content as string) || undefined;
  const userContent = (lastUser?.content as string) || "";
  const prompt = pipedPrompt
    ? userContent
      ? `${userContent}\n\n${pipedPrompt}`
      : pipedPrompt
    : userContent;
  const messageImages: unknown[] = [];
  for (const message of userMessages) {
    if (message.images && message.images.length > 0) {
      messageImages.push(...message.images);
    }
  }
  return { prompt, systemPrompt, messageImages };
}

function resolveTextToImagePromptAndImages(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
) {
  const pipedPrompt =
    (inputData.find((datum) => datum.type === "text")?.data as string) || "";
  const rawImages = inputData
    .filter((datum) => datum.type === "image")
    .map((datum) => datum.data);
  const conversationParts = inputData
    .filter((datum) => datum.type === "conversation")
    .map((datum) => datum.data);

  if (conversationParts.length > 0) {
    const conversationMessages = (conversationParts[0] as WorkflowMessage[]).filter(
      (message) =>
        Boolean(
          message.content ||
            (message.images && message.images.length > 0) ||
            message.audio,
        ),
    );
    const extracted = extractPromptAndImagesFromMessages(conversationMessages, pipedPrompt);
    return { ...extracted, rawImages };
  }
  if (node.messages && node.messages.length > 0) {
    const extracted = extractPromptAndImagesFromMessages(node.messages, pipedPrompt);
    return { ...extracted, rawImages };
  }
  return {
    prompt: pipedPrompt,
    systemPrompt: undefined as string | undefined,
    messageImages: [] as unknown[],
    rawImages,
  };
}

async function executeTextToImageModelNode(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
  context: ExecutionContext,
  conversationId: string,
  conversationMeta: { title: string; systemPrompt: string },
  outputs: WorkflowOutputs,
): Promise<void> {
  const { prompt, systemPrompt, messageImages, rawImages } =
    resolveTextToImagePromptAndImages(node, inputData);
  const imagePayloads = [...rawImages, ...messageImages].map((image) =>
    typeof image === "object" ? image : (image as string),
  );

  const imageMessages: Record<string, unknown>[] = [];
  if (systemPrompt) {
    imageMessages.push({ role: "system", content: systemPrompt });
  }
  const userMessage: Record<string, unknown> = {
    role: "user",
    content: prompt || "",
  };
  if (imagePayloads.length > 0) {
    userMessage.images = imagePayloads;
  }
  imageMessages.push(userMessage);

  const collectedEvents: SseEvent[] = [];
  await handleConversation(
    {
      provider: node.provider,
      model: node.modelName,
      messages: imageMessages,
      conversationId,
      conversationMeta,
      project: context.project,
      username: context.username,
      skipConversation: false,
    },
    (event: SseEvent) => {
      collectedEvents.push(event);
    },
  );

  const errorEvent = collectedEvents.find((event) => event.type === "error");
  if (errorEvent) {
    throw new Error(errorEvent.message || "Image generation failed");
  }

  const resolvedImage = await resolveCollectedImageEventUrl(collectedEvents);
  if (resolvedImage !== undefined) {
    outputs.image = resolvedImage;
  }

  const textResponse = collectedEvents
    .filter((event) => event.type === "chunk")
    .map((event) => event.content)
    .join("");
  if (textResponse) {
    outputs.text = textResponse;
  }
}

async function executeAudioToTextModelNode(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
  context: ExecutionContext,
  outputs: WorkflowOutputs,
): Promise<void> {
  const audioData =
    (inputData.find((datum) => datum.type === "audio")?.data as string) || "";

  const provider = getProvider(node.provider || "");
  if (!provider.transcribeAudio) {
    throw new Error(`Provider "${node.provider}" does not support audio transcription`);
  }

  const resolvedAudio = await resolveMediaReference(
    audioData,
    context.project || "",
    context.username || "",
  );
  const audioUrl = resolvedAudio.providerRef;

  const dataUrlMatch = audioUrl.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = dataUrlMatch ? dataUrlMatch[1] : "audio/mpeg";
  const audioBuffer = Buffer.from(dataUrlMatch ? dataUrlMatch[2] : audioUrl, "base64");

  const transcribeOptions: Record<string, string> = {};
  const promptText = node.userPrompt || node.systemPrompt;
  if (promptText) transcribeOptions.prompt = promptText;

  const result = await provider.transcribeAudio(
    audioBuffer,
    mimeType,
    node.modelName,
    transcribeOptions,
  );
  outputs.text = result.text || "";
}

async function collectSpeechStreamChunks(stream: unknown): Promise<Buffer[]> {
  if (!stream) {
    throw new Error("Speech generation returned no stream");
  }
  const audioChunks: Buffer[] = [];
  if (
    typeof stream === "object" &&
    "pipe" in stream &&
    typeof (stream as import("stream").Readable).pipe === "function"
  ) {
    const nodeStream = stream as import("stream").Readable;
    for await (const chunk of nodeStream) {
      audioChunks.push(Buffer.from(chunk as Buffer | Uint8Array));
    }
    return audioChunks;
  }
  const webStream = stream as ReadableStream<Uint8Array>;
  const reader = webStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) audioChunks.push(Buffer.from(value));
  }
  return audioChunks;
}

async function executeTextToSpeechModelNode(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
  context: ExecutionContext,
  outputs: WorkflowOutputs,
): Promise<void> {
  const textData =
    (inputData.find((datum) => datum.type === "text")?.data as string) || "";

  const provider = getProvider(node.provider || "");
  if (!provider.generateSpeech) {
    throw new Error(`Provider "${node.provider}" does not support text-to-speech`);
  }

  const result = await provider.generateSpeech(textData, undefined, {
    model: node.modelName,
  });
  const audioChunks = await collectSpeechStreamChunks(result.stream);
  const contentType = result.contentType || "audio/mpeg";
  const audioBuffer = Buffer.concat(audioChunks);
  const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;

  try {
    const { ref } = await FileService.uploadFile(
      dataUrl,
      FILE_CATEGORIES.GENERATIONS,
      context.project,
      context.username,
    );
    outputs.audio = resolveMinioRefToUrl(ref) || dataUrl;
  } catch {
    outputs.audio = dataUrl;
  }
}

function parseWorkflowBase64DataUrl(
  data: string,
  fallbackMime: string,
): { data: string; mimeType: string } {
  if (typeof data === "string" && data.includes(";base64,")) {
    const segments = data.split(";base64,");
    return {
      data: segments[1],
      mimeType: segments[0].replace("data:", ""),
    };
  }
  return { data, mimeType: fallbackMime };
}

async function buildEmbeddingMultimodalParts(
  combinedText: string,
  imageParts: unknown[],
  audioPart: unknown,
  context: ExecutionContext,
): Promise<Record<string, unknown>[]> {
  const parts: Record<string, unknown>[] = [];
  if (combinedText) parts.push({ text: combinedText });

  for (const image of imageParts) {
    const resolvedImage = await resolveMediaReference(
      image as string,
      context.project || "",
      context.username || "",
    );
    const { data, mimeType } = parseWorkflowBase64DataUrl(
      resolvedImage.providerRef,
      "image/jpeg",
    );
    parts.push({ inlineData: { data, mimeType } });
  }

  if (audioPart) {
    const resolvedAudio = await resolveMediaReference(
      audioPart as string,
      context.project || "",
      context.username || "",
    );
    const { data, mimeType } = parseWorkflowBase64DataUrl(
      resolvedAudio.providerRef,
      "audio/mpeg",
    );
    parts.push({ inlineData: { data, mimeType } });
  }
  return parts;
}

async function executeModalityToEmbeddingModelNode(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
  context: ExecutionContext,
  outputs: WorkflowOutputs,
): Promise<void> {
  const textParts = inputData.filter((d) => d.type === "text").map((d) => d.data);
  const imageParts = inputData.filter((d) => d.type === "image").map((d) => d.data);
  const audioPart = inputData.find((d) => d.type === "audio")?.data;

  const pipedText = textParts.join("\n\n");
  const combinedText = node.userPrompt
    ? pipedText
      ? `${node.userPrompt}\n\n${pipedText}`
      : node.userPrompt
    : pipedText;

  const isMultimodal = imageParts.length > 0 || Boolean(audioPart);
  const content: string | Record<string, unknown>[] =
    !isMultimodal && combinedText
      ? combinedText
      : await buildEmbeddingMultimodalParts(combinedText, imageParts, audioPart, context);

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

async function executeModelNode(
  node: WorkflowModelNode,
  inputData: WorkflowInputDatum[],
  context: ExecutionContext,
  {
    toolSchemas,
    customToolMap: _customToolMap,
    signal,
  }: {
    toolSchemas?: ToolSchemaEntry[] | null;
    customToolMap?: Map<string, WorkflowCustomTool> | null;
    signal?: AbortSignal;
  } = {},
): Promise<{ outputs: WorkflowOutputs; conversationId: string }> {
  const endpoint = resolveEndpoint(node, inputData);
  const outputs: WorkflowOutputs = {};

  const conversationId = crypto.randomUUID();
  const nodeLabel = node.label || node.modelName || "Model Node";
  const conversationMeta = {
    title: `🔀 ${nodeLabel} · ${node.provider || "unknown"}/${node.modelName || "unknown"}`,
    systemPrompt: node.systemPrompt || "",
  };

  if (endpoint === WORKFLOW_ENDPOINTS.TEXT_TO_TEXT) {
    await executeTextToTextModelNode(
      node,
      inputData,
      context,
      conversationId,
      conversationMeta,
      toolSchemas,
      signal,
      outputs,
    );
  } else if (endpoint === WORKFLOW_ENDPOINTS.TEXT_TO_IMAGE) {
    await executeTextToImageModelNode(
      node,
      inputData,
      context,
      conversationId,
      conversationMeta,
      outputs,
    );
  } else if (endpoint === WORKFLOW_ENDPOINTS.AUDIO_TO_TEXT) {
    await executeAudioToTextModelNode(node, inputData, context, outputs);
  } else if (endpoint === WORKFLOW_ENDPOINTS.TEXT_TO_SPEECH) {
    await executeTextToSpeechModelNode(node, inputData, context, outputs);
  } else if (endpoint === WORKFLOW_ENDPOINTS.MODALITY_TO_EMBEDDING) {
    await executeModalityToEmbeddingModelNode(node, inputData, context, outputs);
  }

  return { outputs, conversationId };
}

// ── Main Workflow Executor ───────────────────────────────────

function buildViewerEdgesBySource(
  edges: WorkflowEdge[],
  nodeMap: Record<string, WorkflowModelNode>,
): Record<string, WorkflowEdge[]> {
  const viewerEdgesBySource: Record<string, WorkflowEdge[]> = {};
  for (const edge of edges) {
    const targetNode = nodeMap[edge.targetNodeId];
    if (targetNode?.nodeType === "viewer") {
      (viewerEdgesBySource[edge.sourceNodeId] ??= []).push(edge);
    }
  }
  return viewerEdgesBySource;
}

function pushViewerPartialUpdatesForNode(
  nodeId: string,
  outputs: WorkflowOutputs | undefined,
  viewerEdgesBySource: Record<string, WorkflowEdge[]>,
  viewerPartials: Record<string, WorkflowOutputs>,
  callbacks: WorkflowExecutionCallbacks,
): void {
  const viewerEdges = viewerEdgesBySource[nodeId];
  if (!viewerEdges || !outputs) return;
  for (const edge of viewerEdges) {
    const data = outputs[edge.sourceModality];
    if (!data) continue;
    viewerPartials[edge.targetNodeId] ??= {};
    viewerPartials[edge.targetNodeId][edge.targetModality] = data;
    callbacks.onViewerPartial?.(edge.targetNodeId, {
      ...viewerPartials[edge.targetNodeId],
    });
  }
}

const CONVERSATION_MEDIA_KEY_MAP: Record<string, "images" | "audio" | "video" | "pdf"> = {
  image: "images",
  audio: "audio",
  video: "video",
  pdf: "pdf",
};

function applyConversationModalityToMessage(
  message: WorkflowMessage,
  modality: string,
  data: unknown,
): void {
  if (modality === "text") {
    message.content = message.content ? `${message.content}\n\n${data}` : (data as string);
    return;
  }
  const fieldKey = CONVERSATION_MEDIA_KEY_MAP[modality];
  if (fieldKey) {
    const current = (message[fieldKey] as string[] | undefined) || [];
    message[fieldKey] = [...current, data as string];
  }
}

function applyConversationInputConnection(
  messages: WorkflowMessage[],
  connection: WorkflowEdge,
  nodeOutputs: Record<string, WorkflowOutputs>,
): void {
  const sourceOutput = nodeOutputs[connection.sourceNodeId];
  const data = sourceOutput?.[connection.sourceModality];
  if (!data) return;

  const dotIndex = connection.targetModality.indexOf(".");
  if (dotIndex === -1) return;
  const messageIndex = parseInt(connection.targetModality.substring(0, dotIndex));
  const modality = connection.targetModality.substring(dotIndex + 1);
  if (messageIndex < 0 || messageIndex >= messages.length) return;

  applyConversationModalityToMessage(messages[messageIndex], modality, data);
}

function executeWorkflowInputNode(
  node: WorkflowModelNode,
  incomingConnections: WorkflowEdge[],
  nodeOutputs: Record<string, WorkflowOutputs>,
): WorkflowOutputs {
  if (node.modality === "conversation") {
    const messages = structuredClone(node.messages || []);
    for (const connection of incomingConnections) {
      applyConversationInputConnection(messages, connection, nodeOutputs);
    }
    return { conversation: messages };
  }
  if (!node.modality) return {};
  return { [node.modality]: node.content || "" };
}

function buildCustomWorkflowToolSchemaEntry(tool: WorkflowCustomTool): ToolSchemaEntry {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of tool.parameters || []) {
    if (!parameter.name) continue;
    const propDef: Record<string, unknown> = {
      type: parameter.type || "string",
      description: parameter.description || "",
    };
    if (parameter.enum && parameter.enum.length > 0) {
      propDef.enum = parameter.enum;
    }
    properties[parameter.name] = propDef;
    if (parameter.required) required.push(parameter.name);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: { type: "object", properties, required },
    },
  };
}

function executeWorkflowToolsNode(node: WorkflowModelNode): WorkflowOutputs {
  const disabled = new Set(node.disabledTools || []);
  const builtIn = (node.builtInTools || []).filter((tool) => !disabled.has(tool.name));
  const custom = (node.customTools || []).filter(
    (tool) => !disabled.has(tool.name || tool._id || ""),
  );

  const schemas: ToolSchemaEntry[] = [
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
    ...custom.map(buildCustomWorkflowToolSchemaEntry),
  ];

  const customMap = new Map<string, WorkflowCustomTool>();
  for (const tool of custom) {
    customMap.set(tool.name, tool);
  }
  return { tools: { schemas, customMap } };
}

function executeWorkflowViewerNode(
  incomingConnections: WorkflowEdge[],
  nodeOutputs: Record<string, WorkflowOutputs>,
): WorkflowOutputs {
  const collectedOutputs: Record<string, unknown> = {};
  for (const connection of incomingConnections) {
    const sourceOutputs = nodeOutputs[connection.sourceNodeId];
    if (sourceOutputs && sourceOutputs[connection.sourceModality] !== undefined) {
      collectedOutputs[connection.targetModality] =
        sourceOutputs[connection.sourceModality];
    }
  }
  return collectedOutputs;
}

function mergeWorkflowToolInputs(toolInputs: WorkflowInputDatum[]): {
  toolSchemas: ToolSchemaEntry[] | null;
  customToolMap: Map<string, WorkflowCustomTool> | null;
} {
  if (toolInputs.length === 0) {
    return { toolSchemas: null, customToolMap: null };
  }
  const toolSchemas: ToolSchemaEntry[] = [];
  const customToolMap = new Map<string, WorkflowCustomTool>();
  for (const toolInput of toolInputs) {
    const toolData = toolInput.data as {
      schemas?: ToolSchemaEntry[];
      customMap?: Map<string, WorkflowCustomTool>;
    };
    if (toolData?.schemas) toolSchemas.push(...toolData.schemas);
    if (toolData?.customMap) {
      for (const [key, value] of toolData.customMap) {
        customToolMap.set(key, value);
      }
    }
  }
  return { toolSchemas, customToolMap };
}

function collectWorkflowModelNodeInputs(
  node: WorkflowModelNode,
  incomingConnections: WorkflowEdge[],
  nodeOutputs: Record<string, WorkflowOutputs>,
) {
  const inputData: WorkflowInputDatum[] = [];
  for (const connection of incomingConnections) {
    const sourceOutputs = nodeOutputs[connection.sourceNodeId];
    if (sourceOutputs && sourceOutputs[connection.sourceModality] !== undefined) {
      inputData.push({
        type: connection.targetModality,
        data: sourceOutputs[connection.sourceModality],
        sourceNodeId: connection.sourceNodeId,
      });
    }
  }
  const toolInputs = inputData.filter((datum) => datum.type === "tools");
  const regularInputData = inputData.filter((datum) => datum.type !== "tools");
  const { toolSchemas, customToolMap } = mergeWorkflowToolInputs(toolInputs);

  if (node.staticInputs) {
    for (const [modality, data] of Object.entries(node.staticInputs)) {
      if (data) {
        regularInputData.push({ type: modality, data, sourceNodeId: null });
      }
    }
  }
  return { regularInputData, toolSchemas, customToolMap };
}

async function executeSingleWorkflowGraphNode(params: {
  nodeId: string;
  node: WorkflowModelNode;
  incomingConnections: WorkflowEdge[];
  nodeOutputs: Record<string, WorkflowOutputs>;
  generatedConversationIds: string[];
  viewerEdgesBySource: Record<string, WorkflowEdge[]>;
  viewerPartials: Record<string, WorkflowOutputs>;
  context: ExecutionContext;
  callbacks: WorkflowExecutionCallbacks;
}): Promise<void> {
  const {
    nodeId,
    node,
    incomingConnections,
    nodeOutputs,
    generatedConversationIds,
    viewerEdgesBySource,
    viewerPartials,
    context,
    callbacks,
  } = params;
  callbacks.onNodeStart?.(nodeId);

  if (node.nodeType === "input") {
    nodeOutputs[nodeId] = executeWorkflowInputNode(node, incomingConnections, nodeOutputs);
    callbacks.onNodeComplete?.(nodeId, nodeOutputs[nodeId]);
    pushViewerPartialUpdatesForNode(
      nodeId,
      nodeOutputs[nodeId],
      viewerEdgesBySource,
      viewerPartials,
      callbacks,
    );
    return;
  }

  if (node.nodeType === "tools") {
    nodeOutputs[nodeId] = executeWorkflowToolsNode(node);
    callbacks.onNodeComplete?.(nodeId, {});
    return;
  }

  if (node.nodeType === "viewer") {
    const collectedOutputs = executeWorkflowViewerNode(incomingConnections, nodeOutputs);
    nodeOutputs[nodeId] = collectedOutputs;
    callbacks.onNodeComplete?.(nodeId, collectedOutputs);
    return;
  }

  const { regularInputData, toolSchemas, customToolMap } = collectWorkflowModelNodeInputs(
    node,
    incomingConnections,
    nodeOutputs,
  );
  logger.info(`[workflow] ▶ Executing node ${nodeId} (${node.provider}/${node.modelName})`);
  const { outputs, conversationId } = await executeModelNode(
    node,
    regularInputData,
    context,
    { toolSchemas, customToolMap, signal: callbacks.signal },
  );

  nodeOutputs[nodeId] = outputs;
  if (conversationId) generatedConversationIds.push(conversationId);
  callbacks.onNodeComplete?.(nodeId, outputs);
  pushViewerPartialUpdatesForNode(
    nodeId,
    outputs,
    viewerEdgesBySource,
    viewerPartials,
    callbacks,
  );
  logger.info(`[workflow] ✅ Node ${nodeId} complete`);
}

async function executeWorkflow(
  nodes: WorkflowModelNode[],
  edges: WorkflowEdge[],
  context: ExecutionContext,
  callbacks: WorkflowExecutionCallbacks,
): Promise<{
  nodeOutputs: Record<string, WorkflowOutputs>;
  conversationIds: string[];
}> {
  const sortedIds = topologicalSort(nodes, edges);
  const nodeMap = Object.fromEntries(nodes.map((node) => [node.id, node]));

  const nodeOutputs: Record<string, WorkflowOutputs> = {};
  const generatedConversationIds: string[] = [];
  const viewerEdgesBySource = buildViewerEdgesBySource(edges, nodeMap);
  const viewerPartials: Record<string, WorkflowOutputs> = {};
  const erroredNodeIds = new Set<string>();

  for (const nodeId of sortedIds) {
    if (callbacks.signal?.aborted) {
      logger.info(`[workflow] Aborting — signal received before node ${nodeId}`);
      break;
    }

    const node = nodeMap[nodeId];
    if (!node) continue;

    const incomingConnections = edges.filter((edge) => edge.targetNodeId === nodeId);
    const hasErroredUpstream = incomingConnections.some((edge) =>
      erroredNodeIds.has(edge.sourceNodeId),
    );
    if (hasErroredUpstream) {
      erroredNodeIds.add(nodeId);
      nodeOutputs[nodeId] = {};
      continue;
    }

    try {
      await executeSingleWorkflowGraphNode({
        nodeId,
        node,
        incomingConnections,
        nodeOutputs,
        generatedConversationIds,
        viewerEdgesBySource,
        viewerPartials,
        context,
        callbacks,
      });
    } catch (error: unknown) {
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
