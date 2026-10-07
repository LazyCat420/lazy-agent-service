import { getModelByName } from "../config.js";
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
function isUtilityStep(step) {
    const label = step.label || "";
    // 🧠 prefix = internal decision steps (Emoji React, Image Detection, Fetch Count, etc.)
    return label.startsWith("🧠");
}
/**
 * Build compound port IDs for a conversation input node.
 * Format: "{messageIndex}.{modality}" e.g. "0.text", "1.text", "1.image"
 */
function buildConversationPorts(messages, supportedModalities = ["text"]) {
    const ports = [];
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
function resolveModelModalities(step) {
    const configModel = step.model ? getModelByName(step.model) : null;
    const isImageGen = step.outputType === "image";
    if (configModel) {
        return {
            label: configModel.label || null,
            inputTypes: configModel.inputTypes || ["text"],
            outputTypes: configModel.outputTypes || ["text"],
            rawInputTypes: configModel.inputTypes || ["text"],
            modelType: configModel.modelType || (isImageGen ? "image" : "conversation"),
            supportsSystemPrompt: configModel.supportsSystemPrompt !==
                undefined
                ? configModel
                    .supportsSystemPrompt
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
function assembleGraph(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        return { nodes: [], edges: [], nodeResults: {} };
    }
    const allNodes = [];
    const allEdges = [];
    const nodeResults = {};
    // Track the last non-utility model ID for chain edges
    let previousOutputModelId = null;
    steps.forEach((step, i) => {
        const baseX = 80 + i * STEP_WIDTH;
        const baseY = 80;
        const stepPrefix = `s${i}`;
        let inputY = baseY;
        const utility = isUtilityStep(step);
        const modalities = resolveModelModalities(step);
        // ── 1. Text Input: System Prompt ──
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
            });
            inputY += 200;
        }
        // ── 2. Text Input: User Message ──
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
            });
            inputY += 200;
        }
        // ── 3. Conversation Node ──
        const convId = `${stepPrefix}_conv`;
        const messages = [];
        if (step.systemPrompt)
            messages.push({ role: "system", content: step.systemPrompt });
        const userMessage = {
            role: "user",
            content: step.input || "",
        };
        messages.push(userMessage);
        if (step.output) {
            const assistantMessage = {
                role: "assistant",
                content: step.output,
            };
            if (step.outputImageRef)
                assistantMessage.images = [step.outputImageRef];
            messages.push(assistantMessage);
        }
        // Derive conversation supported modalities from the model's raw input types
        const supportedModalities = (modalities.rawInputTypes || ["text"]).filter((tool) => tool !== "conversation");
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
        });
        // Wire inputs → conversation node
        const sysIndex = 0;
        const userIndex = step.systemPrompt ? 1 : 0;
        if (step.systemPrompt) {
            allEdges.push({
                id: `${stepPrefix}_sys_to_conv`,
                sourceNodeId: sysId,
                targetNodeId: convId,
                sourceModality: "text",
                targetModality: `${sysIndex}.text`,
            });
        }
        if (step.input) {
            allEdges.push({
                id: `${stepPrefix}_user_to_conv`,
                sourceNodeId: userMessageId,
                targetNodeId: convId,
                sourceModality: "text",
                targetModality: `${userIndex}.text`,
            });
        }
        // ── 4. Model Node ──
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
        });
        // Wire conversation → model
        allEdges.push({
            id: `${stepPrefix}_conv_to_model`,
            sourceNodeId: convId,
            targetNodeId: modelId,
            sourceModality: "conversation",
            targetModality: "conversation",
        });
        // Store model results
        const result = {};
        if (step.output)
            result.text = step.output;
        if (step.outputImageRef)
            result.image = step.outputImageRef;
        nodeResults[modelId] = result;
        // ── 5. Output Viewer ──
        {
            const viewerId = `${stepPrefix}_viewer`;
            const viewerResult = {};
            if (step.output)
                viewerResult.text = step.output;
            if (step.outputImageRef)
                viewerResult.image = step.outputImageRef;
            allNodes.push({
                id: viewerId,
                nodeType: "viewer",
                modality: null,
                content: viewerResult.text || viewerResult.image || null,
                contentType: viewerResult.image
                    ? "image"
                    : viewerResult.text
                        ? "text"
                        : null,
                receivedOutputs: viewerResult,
                inputTypes: ["text", "image", "audio"],
                outputTypes: ["text", "image", "audio"],
                position: {
                    x: baseX + VIEWER_X_OFFSET,
                    y: baseY + 100,
                },
            });
            // Connect model outputs to viewer
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
        }
        // ── 6. Chain edge from previous output model → this model (non-utility only) ──
        if (!utility && previousOutputModelId) {
            allEdges.push({
                id: `chain_${previousOutputModelId}_to_${modelId}`,
                sourceNodeId: previousOutputModelId,
                targetNodeId: modelId,
                sourceModality: "text",
                targetModality: "text",
            });
        }
        // Track last non-utility model for chains
        if (!utility) {
            previousOutputModelId = modelId;
        }
    });
    return { nodes: allNodes, edges: allEdges, nodeResults };
}
export { assembleGraph };
//# sourceMappingURL=WorkflowAssembler.js.map