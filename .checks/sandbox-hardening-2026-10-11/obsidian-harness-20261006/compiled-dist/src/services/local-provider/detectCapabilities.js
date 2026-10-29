import { TYPES } from "../../config.js";
import { THINKING_PATTERNS, FUNCTION_CALL_PATTERNS, VISION_PATTERNS, VIDEO_PATTERNS, AUDIO_PATTERNS, } from "./constants.js";
/** Check if a lowercased model name matches any pattern in a list. */
export function matchesAny(nameLower, patterns) {
    return patterns.some((pattern) => nameLower.includes(pattern));
}
export function detectCapabilities(modelKey, providerMeta = {}) {
    const nameLower = (modelKey || "").toLowerCase();
    const capabilities = providerMeta.capabilities || {};
    // Thinking / reasoning
    const hasReasoningCapability = !!capabilities.reasoning;
    const supportsThinking = hasReasoningCapability || matchesAny(nameLower, THINKING_PATTERNS);
    // Function calling / tool use
    const supportsFunctionCalling = !!capabilities.trained_for_tool_use ||
        matchesAny(nameLower, FUNCTION_CALL_PATTERNS);
    // Vision (images)
    const supportsVision = !!capabilities.vision || matchesAny(nameLower, VISION_PATTERNS);
    // Video
    const supportsVideo = matchesAny(nameLower, VIDEO_PATTERNS);
    // Audio
    const supportsAudio = matchesAny(nameLower, AUDIO_PATTERNS);
    // Build tools list
    const tools = [];
    if (supportsThinking)
        tools.push("Thinking");
    if (supportsFunctionCalling)
        tools.push("Tool Calling");
    // Build input types
    const inputTypes = [TYPES.TEXT];
    if (supportsVision)
        inputTypes.push(TYPES.IMAGE);
    if (supportsVideo)
        inputTypes.push(TYPES.VIDEO);
    if (supportsAudio)
        inputTypes.push(TYPES.AUDIO);
    return {
        thinking: supportsThinking,
        functionCalling: supportsFunctionCalling,
        vision: supportsVision,
        video: supportsVideo,
        audio: supportsAudio,
        tools,
        inputTypes,
        outputTypes: [TYPES.TEXT],
    };
}
//# sourceMappingURL=detectCapabilities.js.map