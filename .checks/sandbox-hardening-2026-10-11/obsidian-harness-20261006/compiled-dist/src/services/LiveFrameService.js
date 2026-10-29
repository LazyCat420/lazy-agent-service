export default class LiveFrameService {
    // Map of agentConversationId -> array of base64 frames (oldest to newest)
    static frameBuffers = new Map();
    static MAX_FRAME_COUNT = 3;
    /** Push a new frame into the rolling buffer for a conversation. */
    static pushFrame(agentConversationId, frameDataUrl) {
        if (!agentConversationId)
            return;
        let frameBuffer = this.frameBuffers.get(agentConversationId);
        if (!frameBuffer) {
            frameBuffer = [];
            this.frameBuffers.set(agentConversationId, frameBuffer);
        }
        frameBuffer.push(frameDataUrl);
        // Keep only the last N frames
        if (frameBuffer.length > this.MAX_FRAME_COUNT) {
            frameBuffer.shift();
        }
    }
    /** Get the current frames for a conversation. */
    static getFrames(agentConversationId) {
        if (!agentConversationId)
            return [];
        return this.frameBuffers.get(agentConversationId) || [];
    }
    /** Clear the buffer for a conversation. */
    static clear(agentConversationId) {
        if (!agentConversationId)
            return;
        this.frameBuffers.delete(agentConversationId);
    }
}
//# sourceMappingURL=LiveFrameService.js.map