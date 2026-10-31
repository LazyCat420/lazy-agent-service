import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import { deriveAgentId } from "@rodrigo-barraza/utilities-library";
import logger from "../utils/logger.ts";

/** @returns {import("mongodb").Collection} */
function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.CUSTOM_AGENTS);
}

/** A string field, or the fallback when the caller did not supply one. */
function textOrFallback(value: unknown, fallback: string): string {
  return (value as string) || fallback;
}

/** availableTools, else enabledTools, else []. */
function pickAvailableTools(data: Record<string, unknown>): unknown[] {
  if (Array.isArray(data.availableTools)) return data.availableTools;
  return Array.isArray(data.enabledTools) ? data.enabledTools : [];
}

/** Platform rules object, or {} when it is not a non-null object. */
function pickPlatformRules(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** The document a create call inserts, with defaults for everything optional. */
function buildCustomAgentDocument(
  data: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> {
  return {
    name: data.name,
    agentId,
    type: textOrFallback(data.type, ""),
    description: textOrFallback(data.description, ""),
    project: textOrFallback(data.project, "coding"),
    icon: textOrFallback(data.icon, ""),
    avatar: textOrFallback(data.avatar, ""),
    color: textOrFallback(data.color, ""),
    backgroundImage: textOrFallback(data.backgroundImage, ""),
    identity: textOrFallback(data.identity, ""),
    guidelines: textOrFallback(data.guidelines, ""),
    toolPolicy: textOrFallback(data.toolPolicy, ""),
    availableTools: pickAvailableTools(data),
    enabledByDefaultTools: Array.isArray(data.enabledByDefaultTools)
      ? data.enabledByDefaultTools
      : [],
    policies: Array.isArray(data.policies) ? data.policies : [],
    platformRules: pickPlatformRules(data.platformRules),
    hasSomaticState: data.hasSomaticState || false,
    usesDirectoryTree: data.usesDirectoryTree || false,
    usesCodingGuidelines: data.usesCodingGuidelines || false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const CustomAgentService = {
  async list() {
    const collection = getCollection();
    if (!collection) return [];
    return collection.find({}).sort({ createdAt: -1 }).toArray();
  },
  async get(id: string) {
    const collection = getCollection();
    if (!collection) return null;
    return collection.findOne({ _id: new ObjectId(id) });
  },
  async getByAgentId(agentId: Record<string, unknown>) {
    const collection = getCollection();
    if (!collection) return null;
    return collection.findOne({ agentId });
  },
  async create(data: Record<string, unknown>) {
    const collection = getCollection();
    if (!collection) throw new Error("Database not available");

    const agentId = deriveAgentId(data.name as string);

    // Check for duplicate agentId
    const existing = await collection.findOne({ agentId });
    if (existing) {
      throw new Error(`Agent with name "${data.name}" already exists`);
    }

    const document = buildCustomAgentDocument(data, agentId);

    const result = await collection.insertOne(document);
    logger.info(
      `[CustomAgentService] Created agent "${document.name}" (${document.agentId})`,
    );
    return { ...document, _id: result.insertedId };
  },
  async update(id: string, updates: Record<string, unknown>) {
    const collection = getCollection();
    if (!collection) throw new Error("Database not available");

    // If name changed, re-derive agentId and verify uniqueness
    const setFields: Record<string, unknown> = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    if (updates.name) {
      const newAgentId = deriveAgentId(updates.name as string);
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
    logger.info(
      `[CustomAgentService] Updated agent "${updated?.name}" (${updated?.agentId})`,
    );
    return updated;
  },
  async delete(id: string) {
    const collection = getCollection();
    if (!collection) throw new Error("Database not available");

    const document = await collection.findOne({ _id: new ObjectId(id) });
    const result = await collection.deleteOne({ _id: new ObjectId(id) });
    if (document) {
      logger.info(
        `[CustomAgentService] Deleted agent "${document.name}" (${document.agentId})`,
      );
    }
    return result.deletedCount > 0;
  },
};

export default CustomAgentService;
