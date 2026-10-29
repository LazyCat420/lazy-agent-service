import crypto from "crypto";
import logger from "../utils/logger.js";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
const REPLAY_BUFFER_CAPACITY = 200;
const listeners = new Set();
const replayBuffer = [];
const WebhookEventBus = {
    emit(eventType, data) {
        const event = {
            webhookEventId: crypto.randomUUID(),
            webhookTimestamp: new Date().toISOString(),
            eventType,
            data,
        };
        replayBuffer.push(event);
        if (replayBuffer.length > REPLAY_BUFFER_CAPACITY) {
            replayBuffer.shift();
        }
        for (const listener of listeners) {
            try {
                listener(event);
            }
            catch (error) {
                logger.error(`WebhookEventBus listener error: ${errorMessage(error)}`);
            }
        }
    },
    subscribe(callback) {
        listeners.add(callback);
    },
    unsubscribe(callback) {
        listeners.delete(callback);
    },
    getReplayBuffer(since) {
        if (!since)
            return [...replayBuffer];
        return replayBuffer.filter((event) => event.webhookTimestamp > since);
    },
    get listenerCount() {
        return listeners.size;
    },
};
export default WebhookEventBus;
//# sourceMappingURL=WebhookEventBus.js.map