import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import { COLLECTIONS } from "../constants.js";
import { deriveAgentId } from "@rodrigo-barraza/utilities-library";
import logger from "../utils/logger.js";
/** @returns {import("mongodb").Collection} */
function getCollection() {
    return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.CUSTOM_AGENTS);
}
const CustomAgentService = {
    async list() {
        const collection = getCollection();
        if (!collection)
            return [];
        return collection.find({}).sort({ createdAt: -1 }).toArray();
    },
    async get(id) {
        const collection = getCollection();
        if (!collection)
            return null;
        return collection.findOne({ _id: new ObjectId(id) });
    },
    async getByAgentId(agentId) {
        const collection = getCollection();
        if (!collection)
            return null;
        return collection.findOne({ agentId });
    },
    async create(data) {
        const collection = getCollection();
        if (!collection)
            throw new Error("Database not available");
        const agentId = deriveAgentId(data.name);
        // Check for duplicate agentId
        const existing = await collection.findOne({ agentId });
        if (existing) {
            throw new Error(`Agent with name "${data.name}" already exists`);
        }
        const document = {
            name: data.name,
            agentId,
            type: data.type || "",
            description: data.description || "",
            project: data.project || "coding",
            icon: data.icon || "",
            avatar: data.avatar || "",
            color: data.color || "",
            backgroundImage: data.backgroundImage || "",
            identity: data.identity || "",
            guidelines: data.guidelines || "",
            toolPolicy: data.toolPolicy || "",
            availableTools: Array.isArray(data.availableTools)
                ? data.availableTools
                : Array.isArray(data.enabledTools)
                    ? data.enabledTools
                    : [],
            enabledByDefaultTools: Array.isArray(data.enabledByDefaultTools)
                ? data.enabledByDefaultTools
                : [],
            policies: Array.isArray(data.policies) ? data.policies : [],
            platformRules: typeof data.platformRules === "object" && data.platformRules !== null
                ? data.platformRules
                : {},
            hasSomaticState: data.hasSomaticState || false,
            usesDirectoryTree: data.usesDirectoryTree || false,
            usesCodingGuidelines: data.usesCodingGuidelines || false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const result = await collection.insertOne(document);
        logger.info(`[CustomAgentService] Created agent "${document.name}" (${document.agentId})`);
        return { ...document, _id: result.insertedId };
    },
    async update(id, updates) {
        const collection = getCollection();
        if (!collection)
            throw new Error("Database not available");
        // If name changed, re-derive agentId and verify uniqueness
        const setFields = {
            ...updates,
            updatedAt: new Date().toISOString(),
        };
        if (updates.name) {
            const newAgentId = deriveAgentId(updates.name);
            const conflictingAgent = await collection.findOne({
                agentId: newAgentId,
                _id: { $ne: new ObjectId(id) },
            });
            if (conflictingAgent) {
                throw new Error(`Agent with name "${updates.name}" already exists`);
            }
            setFields.agentId = newAgentId;
        }
        // Remove _id from $set if present
        delete setFields._id;
        await collection.updateOne({ _id: new ObjectId(id) }, { $set: setFields });
        const updated = await collection.findOne({ _id: new ObjectId(id) });
        logger.info(`[CustomAgentService] Updated agent "${updated?.name}" (${updated?.agentId})`);
        return updated;
    },
    async delete(id) {
        const collection = getCollection();
        if (!collection)
            throw new Error("Database not available");
        const document = await collection.findOne({ _id: new ObjectId(id) });
        const result = await collection.deleteOne({ _id: new ObjectId(id) });
        if (document) {
            logger.info(`[CustomAgentService] Deleted agent "${document.name}" (${document.agentId})`);
        }
        return result.deletedCount > 0;
    },
};
export default CustomAgentService;
//# sourceMappingURL=CustomAgentService.js.map