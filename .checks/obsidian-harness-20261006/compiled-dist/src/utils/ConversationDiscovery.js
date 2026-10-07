import { COLLECTIONS } from "../constants.js";
const MAX_CONVERSATION_DEPTH = 10;
/**
 * Recursively discover all descendant conversation IDs by walking the
 * `parentAgentConversationId` chain in the requests collection.
 *
 * Returns a Set containing the root conversation ID plus all descendants.
 * Used by admin conversation stats and ConversationService.
 */
export async function discoverDescendantConversationIds(database, rootConversationId, additionalFilter = {}) {
    // Find all active agentConversationIds that are directly tagged with this conversationId
    const conversationConversationIds = await database
        .collection(COLLECTIONS.REQUESTS)
        .distinct("agentConversationId", {
        conversationId: rootConversationId,
        ...additionalFilter,
    });
    const allConversationIds = new Set([
        rootConversationId,
        ...conversationConversationIds.filter(Boolean),
    ]);
    let frontier = [...allConversationIds];
    for (let depth = 0; depth < MAX_CONVERSATION_DEPTH && frontier.length > 0; depth++) {
        const childIds = await database
            .collection(COLLECTIONS.REQUESTS)
            .distinct("agentConversationId", {
            parentAgentConversationId: { $in: frontier },
            agentConversationId: { $nin: [...allConversationIds] },
            ...additionalFilter,
        });
        if (childIds.length === 0)
            break;
        const newIds = childIds.filter(Boolean);
        for (const id of newIds)
            allConversationIds.add(id);
        frontier = newIds;
    }
    return allConversationIds;
}
//# sourceMappingURL=ConversationDiscovery.js.map