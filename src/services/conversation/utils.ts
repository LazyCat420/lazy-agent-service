import FileService from "../FileService.ts";
import logger from "../../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES } from "../ToolTaxonomyConstants.ts";
import { FILE_CATEGORIES } from "../../constants.ts";
import type { ChatMessage } from "../../types/admin.ts";
import type {
  MessagePayload,
  ConversationSettings,
  ConversationPatchInput,
  ConversationPatchFields,
} from "./types.ts";

interface ConversationDocument {
  id: string;
  totalCost?: number;
  requestErrorCount?: number;
  [key: string]: unknown;
}

/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 */
export async function extractFiles(
  messages: Array<ChatMessage | MessagePayload>,
  project: string | null = null,
  username: string | null = null,
): Promise<Array<ChatMessage | MessagePayload>> {
  if (!messages || !FileService.isExternalStorage()) return messages;

  const processed: Array<ChatMessage | MessagePayload> = [];
  for (const message of messages) {
    const updated = { ...message } as ChatMessage | MessagePayload;

    // Handle images
    if (message.images && message.images.length > 0) {
      const category =
        message.role === "assistant"
          ? FILE_CATEGORIES.GENERATIONS
          : FILE_CATEGORIES.UPLOADS;
      const newImages: string[] = [];
      for (const rawImage of message.images) {
        if (typeof rawImage !== "string") {
          newImages.push(String(rawImage));
          continue;
        }
        const image = rawImage;
        if (image.startsWith("minio://") || image.startsWith("http")) {
          newImages.push(image);
          continue;
        }
        if (image.startsWith("data:")) {
          try {
            const { ref } = await FileService.uploadFile(
              image,
              category,
              project,
              username,
            );
            newImages.push(ref);
          } catch (error: unknown) {
            logger.error(`Failed to upload file: ${errorMessage(error)}`);
            newImages.push(image);
          }
        } else {
          newImages.push(image);
        }
      }
      updated.images = newImages;
    }

    // Handle audio data URLs
    if (
      updated.audio &&
      typeof updated.audio === "string" &&
      updated.audio.startsWith("data:")
    ) {
      const category =
        updated.role === "assistant"
          ? FILE_CATEGORIES.GENERATIONS
          : FILE_CATEGORIES.UPLOADS;
      try {
        const { ref } = await FileService.uploadFile(
          updated.audio,
          category,
          project,
          username,
        );
        updated.audio = ref;
      } catch (error: unknown) {
        logger.error(`Failed to upload audio: ${errorMessage(error)}`);
      }
    }

    processed.push(updated);
  }
  return processed;
}

const WEB_SEARCH_NAMES: Set<string> = new Set([
  TOOL_NAMES.SEARCH_WEB,
  TOOL_NAMES.SEARCH_WEB_PREVIEW,
]);
const CODE_EXEC_NAMES: Set<string> = new Set([TOOL_NAMES.CODE_EXECUTION]);
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".webm"];

function classifySingleImageReferenceModality(
  imageReference: unknown,
  isUser: boolean,
  isAssistant: boolean,
  modalities: Record<string, boolean>,
): void {
  if (typeof imageReference !== "string") return;
  const isDocumentReference =
    imageReference.startsWith("data:application/") ||
    imageReference.startsWith("data:text/") ||
    imageReference.endsWith(".pdf") ||
    imageReference.endsWith(".txt");
  if (isDocumentReference) {
    modalities.docIn = true;
    return;
  }
  const isVideoReference =
    imageReference.startsWith("data:video/") ||
    VIDEO_EXTENSIONS.some((extension) => imageReference.endsWith(extension));
  if (isVideoReference) {
    if (isUser) modalities.videoIn = true;
    return;
  }
  if (isUser) modalities.imageIn = true;
  if (isAssistant) modalities.imageOut = true;
}

function classifyMessageMediaModalities(
  chatMessage: ChatMessage,
  isUser: boolean,
  isAssistant: boolean,
  modalities: Record<string, boolean>,
): void {
  if (chatMessage.images && chatMessage.images.length > 0) {
    for (const imageReference of chatMessage.images) {
      classifySingleImageReferenceModality(
        imageReference,
        isUser,
        isAssistant,
        modalities,
      );
    }
  } else if ((chatMessage as Record<string, unknown>).image) {
    if (isUser) modalities.imageIn = true;
    if (isAssistant) modalities.imageOut = true;
  }

  if (chatMessage.audio) {
    if (isUser) modalities.audioIn = true;
    if (isAssistant) modalities.audioOut = true;
  }

  const docs = (chatMessage as Record<string, unknown>).documents as
    | string[]
    | undefined;
  if (docs?.length) {
    modalities.docIn = true;
  }
}

function classifyMessageToolsAndInlineFeatures(
  chatMessage: ChatMessage,
  isAssistant: boolean,
  modalities: Record<string, boolean>,
): void {
  if (chatMessage.toolCalls && chatMessage.toolCalls.length > 0) {
    if (isAssistant) modalities.textOut = true;
    for (const toolCall of chatMessage.toolCalls) {
      const name = (toolCall.name || "").toLowerCase();
      if (WEB_SEARCH_NAMES.has(name)) {
        modalities.webSearch = true;
      } else if (CODE_EXEC_NAMES.has(name)) {
        modalities.codeExecution = true;
      } else {
        modalities.functionCalling = true;
      }
    }
  }

  if (isAssistant && typeof chatMessage.content === "string") {
    if (chatMessage.content.includes("> **Sources:**")) {
      modalities.webSearch = true;
    }
    if (chatMessage.content.includes("```exec-")) {
      modalities.codeExecution = true;
    }
  }

  if (chatMessage.role === "tool") {
    modalities.functionCalling = true;
  }
  if (isAssistant && chatMessage.thinking) {
    modalities.thinking = true;
  }
}

/**
 * Compute input/output modalities from messages for lightweight querying.
 */
export function computeModalities(
  messages: ChatMessage[],
): Record<string, boolean> {
  const modalities = {
    textIn: false,
    textOut: false,
    imageIn: false,
    imageOut: false,
    audioIn: false,
    audioOut: false,
    videoIn: false,
    docIn: false,
    webSearch: false,
    codeExecution: false,
    functionCalling: false,
    thinking: false,
  };

  for (const chatMessage of messages || []) {
    if (chatMessage.deleted) continue;
    const isUser = chatMessage.role === "user";
    const isAssistant = chatMessage.role === "assistant";
    if (chatMessage.content && (isUser || isAssistant)) {
      if (isUser && !(chatMessage as Record<string, unknown>).liveTranscription)
        modalities.textIn = true;
      if (isAssistant) modalities.textOut = true;
    }
    classifyMessageMediaModalities(chatMessage, isUser, isAssistant, modalities);
    classifyMessageToolsAndInlineFeatures(chatMessage, isAssistant, modalities);
  }
  return modalities;
}

/**
 * Extract unique providers from messages and settings.
 */
export function extractProviders(
  messages: ChatMessage[],
  settings: ConversationSettings | null,
): string[] {
  const providers = new Set<string>();
  for (const chatMessage of messages || []) {
    if (chatMessage.deleted) continue;
    if ((chatMessage as Record<string, unknown>).provider) {
      providers.add(
        (
          (chatMessage as Record<string, unknown>).provider as string
        ).toLowerCase(),
      );
    }
  }
  if (settings?.provider) providers.add(settings.provider.toLowerCase());
  return [...providers];
}

/**
 * Compute total estimated cost across all messages.
 */
export function computeTotalCost(messages: ChatMessage[]): number {
  let total = 0;
  for (const chatMessage of messages || []) {
    if (chatMessage.deleted) continue;
    const cost = (chatMessage as Record<string, unknown>).estimatedCost;
    if (typeof cost === "number") total += cost;
  }
  return total;
}

/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 */
export function buildConversationPatchFields({
  title,
  messages,
  systemPrompt,
  settings,
}: ConversationPatchInput): ConversationPatchFields {
  const setFields: ConversationPatchFields = {
    updatedAt: new Date().toISOString(),
  };
  if (title !== undefined) setFields.title = title;
  if (messages !== undefined) {
    setFields.messages = messages;
    setFields.modalities = computeModalities(messages);
    setFields.providers = extractProviders(messages, settings || null);
    setFields.totalCost = computeTotalCost(messages);

    const modelNamesSet = new Set<string>();
    for (const message of messages || []) {
      if (message.deleted) continue;
      if (message.role === "assistant" && message.model) {
        modelNamesSet.add(message.model as string);
      }
    }
    if (modelNamesSet.size === 0 && settings?.model) {
      modelNamesSet.add(settings.model as string);
    }
    setFields.modelNames = Array.from(modelNamesSet);
  }
  if (systemPrompt !== undefined) setFields.systemPrompt = systemPrompt;
  if (settings !== undefined) {
    setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
  }
  return setFields;
}

/**
 * Enrich conversations list with authoritative totalCost from request logs.
 */
export function enrichConversationsWithRequestCosts(
  conversations: ConversationDocument[],
  requestLogCosts: Array<{
    _id: string;
    totalCost: number;
    requestErrorCount?: number;
  }>,
): void {
  if (conversations.length === 0) return;
  const costMap = new Map(
    requestLogCosts.map((costEntry) => [
      costEntry._id,
      {
        totalCost: costEntry.totalCost,
        requestErrorCount: costEntry.requestErrorCount || 0,
      },
    ]),
  );
  for (const conversation of conversations) {
    const conversationId = conversation.id;
    const aggregated = costMap.get(conversationId);
    if (aggregated) {
      if (aggregated.totalCost > 0) {
        conversation.totalCost = Math.max(
          conversation.totalCost || 0,
          aggregated.totalCost,
        );
      }
      if (aggregated.requestErrorCount > 0) {
        conversation.requestErrorCount = aggregated.requestErrorCount;
      }
    }
  }
}

/**
 * Enrich a single conversation's totalCost with request logs.
 */
export function enrichSingleConversationCost(
  conversation: ConversationDocument,
  requestLogAggregation: Array<{
    _id: string;
    totalCost: number;
    requestErrorCount?: number;
  }>,
): void {
  if (requestLogAggregation.length > 0) {
    if (requestLogAggregation[0].totalCost > 0) {
      conversation.totalCost = Math.max(
        conversation.totalCost || 0,
        requestLogAggregation[0].totalCost,
      );
    }
    if ((requestLogAggregation[0].requestErrorCount || 0) > 0) {
      conversation.requestErrorCount =
        requestLogAggregation[0].requestErrorCount;
    }
  }
}
