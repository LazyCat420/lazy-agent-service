import { getModelByName } from "../config.ts";
import type {
  WorkflowStep,
  WorkflowMessage,
  GraphNode,
  GraphEdge,
  NodeResult,
  NodeResultMap,
  AssembledGraph,
  ResolvedModalities,
  InputNode,
  ModelNode,
  ViewerNode,
} from "../types/workflow.ts";

// ─── LAYOUT CONSTANTS ───────────────────────────────────────

const STEP_WIDTH = 1250;
const INPUT_X_OFFSET = 0;
const CONV_X_OFFSET = 350;
const MODEL_X_OFFSET = 650;
const VIEWER_X_OFFSET = MODEL_X_OFFSET + 350;

// ─── HELPERS ────────────────────────────────────────────────

/**
 * Check if a step is an internal utility/decision step (not user-facing output).
 * These steps are shown in the graph but don't get viewers or chain edges,
 * keeping the graph clean and focused on meaningful output.
 */
function isUtilityStep(step: WorkflowStep): boolean {
  const label = step.label || "";
  // 🧠 prefix = internal decision steps (Emoji React, Image Detection, Fetch Count, etc.)
  return label.startsWith("🧠");
}

/**
 * Build compound port IDs for a conversation input node.
 * Format: "{messageIndex}.{modality}" e.g. "0.text", "1.text", "1.image"
 */
function buildConversationPorts(
  messages: WorkflowMessage[],
  supportedModalities: string[] = ["text"],
): string[] {
  const ports: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    ports.push(`${i}.text`);
    if (message.role === "user" || message.role === "assistant") {
      for (const modality of supportedModalities) {
        if (modality !== "text") {
          ports.push(`${i}.${modality}`);
        }
      }
    }
  }
  return ports;
}

/**
 * Resolve a model's input/output types from the Prism config.
 * Falls back to step-derived values if the model isn't found in config.
 */
function resolveModelModalities(step: WorkflowStep): ResolvedModalities {
  const configModel = step.model ? getModelByName(step.model) : null;
  const isImageGen = step.outputType === "image";

  if (configModel) {
    return {
      label: configModel.label || null,
      inputTypes: configModel.inputTypes || ["text"],
      outputTypes: configModel.outputTypes || ["text"],
      rawInputTypes: configModel.inputTypes || ["text"],
      modelType:
        configModel.modelType || (isImageGen ? "image" : "conversation"),
      supportsSystemPrompt:
        (configModel as Record<string, unknown>).supportsSystemPrompt !==
        undefined
          ? ((configModel as Record<string, unknown>)
              .supportsSystemPrompt as boolean)
          : (configModel.outputTypes?.includes("text") ?? true),
    };
  }

  // Fallback: derive from step data
  return {
    inputTypes: ["text"],
    outputTypes: isImageGen ? ["text", "image"] : ["text"],
    rawInputTypes: ["text"],
    modelType: isImageGen ? "image" : "conversation",
    supportsSystemPrompt: true,
  };
}

// ─── MAIN ASSEMBLER ─────────────────────────────────────────

/**
 * Assemble a visual workflow graph from raw step data.
 *
 * Each step produces:
 *   1. Text Input nodes (system prompt + user message)
 *   2. Conversation Input node (groups messages with compound ports)
 *   3. Model node (AI model with config-derived modality ports)
 *
 * Non-utility steps additionally produce:
 *   4. Output Viewer node (displays the model's text/image output)
 *   5. Chain edges (previous output model → this model)
 *
 * Utility steps (🧠 prefix) are shown in the graph but without viewers
 * or chain edges, keeping the visualization focused on output.
 */
function appendStepInputAndConversationNodes(
  step: WorkflowStep,
  stepPrefix: string,
  baseX: number,
  baseY: number,
  modalities: ReturnType<typeof resolveModelModalities>,
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
): string {
  let inputY = baseY;
  const sysId = `${stepPrefix}_sys`;
  if (step.systemPrompt) {
    allNodes.push({
      id: sysId,
      nodeType: "input",
      modality: "text",
      content: step.systemPrompt,
      inputTypes: [],
      outputTypes: ["text"],
      position: { x: baseX + INPUT_X_OFFSET, y: inputY },
    } as InputNode);
    inputY += 200;
  }

  const userMessageId = `${stepPrefix}_user`;
  if (step.input) {
    allNodes.push({
      id: userMessageId,
      nodeType: "input",
      modality: "text",
      content: step.input,
      inputTypes: [],
      outputTypes: ["text"],
      position: { x: baseX + INPUT_X_OFFSET, y: inputY },
    } as InputNode);
  }

  const convId = `${stepPrefix}_conv`;
  const messages: WorkflowMessage[] = [];
  if (step.systemPrompt) {
    messages.push({ role: "system", content: step.systemPrompt });
  }
  messages.push({ role: "user", content: step.input || "" });
  if (step.output) {
    const assistantMessage: WorkflowMessage & { images?: string[] } = {
      role: "assistant",
      content: step.output,
    };
    if (step.outputImageRef) assistantMessage.images = [step.outputImageRef];
    messages.push(assistantMessage);
  }

  const supportedModalities = (modalities.rawInputTypes || ["text"]).filter(
    (tool: string) => tool !== "conversation",
  );
  const convInputTypes = buildConversationPorts(messages, supportedModalities);

  allNodes.push({
    id: convId,
    nodeType: "input",
    modality: "conversation",
    messages,
    supportedModalities,
    customName: step.label || undefined,
    inputTypes: convInputTypes,
    outputTypes: ["conversation"],
    position: { x: baseX + CONV_X_OFFSET, y: baseY + 100 },
  } as InputNode);

  if (step.systemPrompt) {
    allEdges.push({
      id: `${stepPrefix}_sys_to_conv`,
      sourceNodeId: sysId,
      targetNodeId: convId,
      sourceModality: "text",
      targetModality: "0.text",
    });
  }
  if (step.input) {
    const userIndex = step.systemPrompt ? 1 : 0;
    allEdges.push({
      id: `${stepPrefix}_user_to_conv`,
      sourceNodeId: userMessageId,
      targetNodeId: convId,
      sourceModality: "text",
      targetModality: `${userIndex}.text`,
    });
  }
  return convId;
}

function appendStepModelAndViewerNodes(
  step: WorkflowStep,
  stepPrefix: string,
  convId: string,
  baseX: number,
  baseY: number,
  modalities: ReturnType<typeof resolveModelModalities>,
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  nodeResults: NodeResultMap,
): string {
  const modelId = `${stepPrefix}_model`;
  allNodes.push({
    id: modelId,
    modelName: step.model || "any",
    provider: step.type?.toLowerCase() || "any",
    displayName: modalities.label || step.model || "Step",
    modelType: modalities.modelType,
    inputTypes: ["conversation"],
    rawInputTypes: modalities.rawInputTypes,
    outputTypes: modalities.outputTypes,
    supportsSystemPrompt: modalities.supportsSystemPrompt,
    position: { x: baseX + MODEL_X_OFFSET, y: baseY + 100 },
    stepMeta: {
      duration: step.duration,
      timestamp: step.timestamp,
      index: step.index,
    },
  } as ModelNode);

  allEdges.push({
    id: `${stepPrefix}_conv_to_model`,
    sourceNodeId: convId,
    targetNodeId: modelId,
    sourceModality: "conversation",
    targetModality: "conversation",
  });

  const result: NodeResult = {};
  if (step.output) result.text = step.output;
  if (step.outputImageRef) result.image = step.outputImageRef;
  nodeResults[modelId] = result;

  const viewerId = `${stepPrefix}_viewer`;
  const viewerResult: NodeResult = { ...result };
  const viewerContentType = viewerResult.image
    ? "image"
    : viewerResult.text
      ? "text"
      : null;

  allNodes.push({
    id: viewerId,
    nodeType: "viewer",
    modality: null,
    content: viewerResult.text || viewerResult.image || null,
    contentType: viewerContentType,
    receivedOutputs: viewerResult,
    inputTypes: ["text", "image", "audio"],
    outputTypes: ["text", "image", "audio"],
    position: {
      x: baseX + VIEWER_X_OFFSET,
      y: baseY + 100,
    },
  } as ViewerNode);

  if (step.output) {
    allEdges.push({
      id: `${stepPrefix}_model_to_viewer_text`,
      sourceNodeId: modelId,
      targetNodeId: viewerId,
      sourceModality: "text",
      targetModality: "text",
    });
  }
  if (step.outputImageRef) {
    allEdges.push({
      id: `${stepPrefix}_model_to_viewer_image`,
      sourceNodeId: modelId,
      targetNodeId: viewerId,
      sourceModality: "image",
      targetModality: "image",
    });
  }
  nodeResults[viewerId] = viewerResult;
  return modelId;
}

function assembleGraph(steps: WorkflowStep[]): AssembledGraph {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { nodes: [], edges: [], nodeResults: {} };
  }

  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  const nodeResults: NodeResultMap = {};
  let previousOutputModelId: string | null = null;

  steps.forEach((step: WorkflowStep, i: number) => {
    const baseX = 80 + i * STEP_WIDTH;
    const baseY = 80;
    const stepPrefix = `s${i}`;
    const utility = isUtilityStep(step);
    const modalities = resolveModelModalities(step);

    const convId = appendStepInputAndConversationNodes(
      step,
      stepPrefix,
      baseX,
      baseY,
      modalities,
      allNodes,
      allEdges,
    );

    const modelId = appendStepModelAndViewerNodes(
      step,
      stepPrefix,
      convId,
      baseX,
      baseY,
      modalities,
      allNodes,
      allEdges,
      nodeResults,
    );

    if (!utility && previousOutputModelId) {
      allEdges.push({
        id: `chain_${previousOutputModelId}_to_${modelId}`,
        sourceNodeId: previousOutputModelId,
        targetNodeId: modelId,
        sourceModality: "text",
        targetModality: "text",
      });
    }

    if (!utility) {
      previousOutputModelId = modelId;
    }
  });

  return { nodes: allNodes, edges: allEdges, nodeResults };
}

export { assembleGraph };
