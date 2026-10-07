import crypto from "crypto";
import WebhookEventBus from "./WebhookEventBus.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { registerCleanup } from "../utils/CleanupRegistry.js";
const DISPATCH_TIMEOUT_MS = 10_000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const SUBSCRIPTION_REFRESH_INTERVAL_MS = 30_000;
let cachedSubscriptions = [];
let refreshInterval = null;
function signPayload(payload, secret) {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
export function matchesFilter(event, filter) {
    for (const [key, value] of Object.entries(filter)) {
        if (value && event.data[key] !== value)
            return false;
    }
    return true;
}
export function matchesEventTypes(eventType, subscribedEvents) {
    if (subscribedEvents.includes("*"))
        return true;
    return subscribedEvents.includes(eventType);
}
async function dispatchToSubscription(subscription, event) {
    const jsonPayload = JSON.stringify(event);
    const signature = signPayload(jsonPayload, subscription.secret);
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        let timeoutHandle = null;
        try {
            const controller = new AbortController();
            timeoutHandle = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
            const response = await fetch(subscription.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Webhook-Signature": `sha256=${signature}`,
                    "X-Webhook-Event": event.eventType,
                    "X-Webhook-Id": event.webhookEventId,
                    "User-Agent": "Prism-Webhook/1.0",
                },
                body: jsonPayload,
                signal: controller.signal,
            });
            if (response.ok || (response.status >= 200 && response.status < 300)) {
                return;
            }
            logger.warn(`Webhook dispatch to ${subscription.url} returned ${response.status} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`);
        }
        catch (error) {
            logger.warn(`Webhook dispatch to ${subscription.url} failed (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ${errorMessage(error)}`);
        }
        finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(4, attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    logger.error(`Webhook dispatch to ${subscription.url} failed after ${MAX_RETRY_ATTEMPTS} attempts for event ${event.webhookEventId}`);
}
async function refreshSubscriptions() {
    try {
        const database = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!database)
            return;
        cachedSubscriptions = (await database
            .collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS)
            .find({ enabled: true })
            .toArray());
    }
    catch (error) {
        logger.error(`Failed to refresh webhook subscriptions: ${errorMessage(error)}`);
    }
}
function handleEvent(event) {
    for (const subscription of cachedSubscriptions) {
        if (!matchesEventTypes(event.eventType, subscription.events))
            continue;
        if (!matchesFilter(event, subscription.filter))
            continue;
        dispatchToSubscription(subscription, event).catch((error) => {
            logger.error(`Unhandled error dispatching webhook: ${errorMessage(error)}`);
        });
    }
}
const WebhookDispatcher = {
    async init() {
        await refreshSubscriptions();
        refreshInterval = setInterval(refreshSubscriptions, SUBSCRIPTION_REFRESH_INTERVAL_MS);
        WebhookEventBus.subscribe(handleEvent);
        const activeCount = cachedSubscriptions.length;
        if (activeCount > 0) {
            logger.info(`WebhookDispatcher initialized with ${activeCount} active subscription(s)`);
        }
        else {
            logger.info("WebhookDispatcher initialized (no active subscriptions)");
        }
    },
    async destroy() {
        WebhookEventBus.unsubscribe(handleEvent);
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
        cachedSubscriptions = [];
    },
    get activeSubscriptionCount() {
        return cachedSubscriptions.length;
    },
};
registerCleanup(async () => {
    await WebhookDispatcher.destroy();
});
export default WebhookDispatcher;
//# sourceMappingURL=WebhookDispatcher.js.map