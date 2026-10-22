export default class LiveFrameService {
  // Map of agentConversationId -> array of base64 frames (oldest to newest)
  private static readonly frameBuffers = new Map<string, string[]>();
  private static readonly MAX_FRAME_COUNT = 3;

  /** Push a new frame into the rolling buffer for a conversation. */
  static pushFrame(agentConversationId: string, frameDataUrl: string): void {
    if (!agentConversationId) return;

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
  static getFrames(agentConversationId: string): string[] {
    if (!agentConversationId) return [];
    return this.frameBuffers.get(agentConversationId) || [];
  }

  /** Clear the buffer for a conversation. */
  static clear(agentConversationId: string): void {
    if (!agentConversationId) return;
    this.frameBuffers.delete(agentConversationId);
  }
}
