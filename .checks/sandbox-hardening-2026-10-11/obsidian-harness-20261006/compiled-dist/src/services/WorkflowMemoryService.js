import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import { COLLECTIONS } from "../constants.js";
import EmbeddingService from "./EmbeddingService.js";
import AgentPersonaRegistry from "./AgentPersonaRegistry.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
// ────────────────────────────────────────────────────────────
// WorkflowMemoryService — Agent Workflow Memory (AWM)
// ────────────────────────────────────────────────────────────
// Based on "Agent Workflow Memory" (Zhu et al., ICML 2025).
//
// Extracts reusable workflow templates from successful agentic
// sessions and injects them as procedural memory on future
// similar tasks. This closes the cross-session learning gap:
// after solving a problem, the procedure is remembered and
// can be replayed (with adaptation) on analogous tasks.
//
// Architecture:
//   1. EXTRACTION (afterResponse hook):
//      On successful session completion (≥3 tool calls, no
//      circuit-breaker errors), compress the tool trajectory
//      into a workflow summary: ordered tool names + key args
//      + the final user request that initiated the session.
//      Embed and persist to `workflow_memories` collection.
//
//   2. RETRIEVAL (called from SystemPromptAssembler):
//      Given the current user message, query for similar past
//      workflows via embedding cosine similarity. Return the
//      top-K most relevant as procedural context.
// ────────────────────────────────────────────────────────────
const MINIMUM_TOOL_CALLS_FOR_WORKFLOW = 3;
const MAXIMUM_WORKFLOW_STEPS = 30;
const MAXIMUM_WORKFLOWS_PER_QUERY = 3;
const WORKFLOW_TEXT_MAXIMUM_CHARACTERS = 1500;
const WORKFLOW_COOLDOWN_MILLISECONDS = 60 * 1000;
/**
 * Extract a compressed workflow trajectory from a completed session.
 *
 * Scans messages for assistant messages with tool calls, extracts
 * the ordered tool sequence with key arguments, and compresses
 * the trajectory into a human-readable summary.
 */
function extractWorkflowTrajectory(messages, userRequest) {
    const steps = [];
    for (const message of messages) {
        if (message.role !== "assistant" || !message.toolCalls?.length)
            continue;
        for (const toolCall of message.toolCalls) {
            const toolCallRecord = toolCall;
            const resultObject = toolCallRecord.result;
            const hasError = !!(resultObject &&
                typeof resultObject === "object" &&
                resultObject.error);
            const keyArguments = {};
            if (toolCallRecord.args) {
                for (const [key, value] of Object.entries(toolCallRecord.args)) {
                    const stringifiedValue = typeof value === "string" ? value : JSON.stringify(value);
                    if (stringifiedValue.length <= 100) {
                        keyArguments[key] = stringifiedValue;
                    }
                    else {
                        keyArguments[key] = `${stringifiedValue.slice(0, 80)}…`;
                    }
                }
            }
            steps.push({
                toolName: toolCallRecord.name,
                isSuccess: !hasError,
                keyArguments,
            });
            if (steps.length >= MAXIMUM_WORKFLOW_STEPS)
                break;
        }
        if (steps.length >= MAXIMUM_WORKFLOW_STEPS)
            break;
    }
    if (steps.length < MINIMUM_TOOL_CALLS_FOR_WORKFLOW)
        return null;
    const successfulSteps = steps.filter((step) => step.isSuccess);
    const failedSteps = steps.filter((step) => !step.isSuccess);
    const stepSummaryLines = steps.map((step, index) => {
        const statusMarker = step.isSuccess ? "✓" : "✗";
        const argumentSummary = Object.entries(step.keyArguments)
            .slice(0, 3)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ");
        return `${index + 1}. ${statusMarker} ${step.toolName}(${argumentSummary})`;
    });
    const summary = `Task: ${userRequest.slice(0, 200)}\n` +
        `Steps (${successfulSteps.length} succeeded, ${failedSteps.length} failed):\n` +
        stepSummaryLines.join("\n");
    return { steps, summary };
}
const WorkflowMemoryService = {
    /**
     * Create an afterResponse hook handler for AgentHooks.
     * Extracts and persists workflow memory after successful sessions.
     * Runs as fire-and-forget (inspect category).
     */
    createHook() {
        return async (context, output) => {
            WorkflowMemoryService.extractAndPersist(context, output).catch((error) => logger.error(`[WorkflowMemoryService] Background extraction failed: ${getErrorMessage(error)}`));
        };
    },
    /**
     * Extract a workflow from the completed session and persist it.
     */
    async extractAndPersist(context, output) {
        const { conversationId, agentConversationId, project, username, agent } = context;
        const resolvedAgentConversationId = agentConversationId || "";
        if (!conversationId || !resolvedAgentConversationId)
            return;
        if (!AgentPersonaRegistry.isAgentProject(project))
            return;
        // Only persist workflows from sessions that completed successfully.
        // Exhausted, errored, or aborted sessions produce unreliable procedures.
        const sessionOutcome = output.sessionOutcome || "completed";
        if (sessionOutcome !== "completed") {
            logger.info(`[WorkflowMemoryService] Skipping — session outcome is "${sessionOutcome}" (requires "completed")`);
            return;
        }
        const messages = output.messages || context.messages || [];
        if (messages.length < 4)
            return;
        const userMessages = messages.filter((message) => message.role === "user");
        const firstUserMessage = userMessages[0];
        if (!firstUserMessage || typeof firstUserMessage.content !== "string")
            return;
        const userRequest = firstUserMessage.content.slice(0, 500);
        const trajectory = extractWorkflowTrajectory(messages, userRequest);
        if (!trajectory)
            return;
        const database = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!database)
            return;
        const workflowCollection = database.collection(COLLECTIONS.WORKFLOW_MEMORIES);
        const existingWorkflow = await workflowCollection.findOne({
            conversationId,
            agentConversationId: resolvedAgentConversationId,
        });
        if (existingWorkflow) {
            const existingCreatedAt = existingWorkflow.createdAt;
            if (existingCreatedAt) {
                const elapsed = Date.now() - new Date(existingCreatedAt).getTime();
                if (elapsed < WORKFLOW_COOLDOWN_MILLISECONDS)
                    return;
            }
        }
        const embeddingSourceText = trajectory.summary.slice(0, 2000);
        const embedding = await EmbeddingService.embed(embeddingSourceText, {
            source: "workflow-memory",
            project,
            endpoint: "/agent",
            traceId: context.traceId,
            agentConversationId: resolvedAgentConversationId,
            agent,
        });
        const workflowDocument = {
            conversationId,
            agentConversationId: resolvedAgentConversationId,
            project,
            username,
            agent: agent || "CODING",
            userRequest,
            stepCount: trajectory.steps.length,
            steps: trajectory.steps,
            summary: trajectory.summary,
            embedding,
            createdAt: new Date().toISOString(),
        };
        await workflowCollection.updateOne({ conversationId, agentConversationId: resolvedAgentConversationId }, { $set: workflowDocument }, { upsert: true });
        logger.info(`[WorkflowMemoryService] Persisted workflow for ${conversationId} ` +
            `(${trajectory.steps.length} steps, ${embeddingSourceText.length} chars embedded)`);
    },
    /**
     * Retrieve similar past workflows for the current user request.
     *
     * Uses MongoDB vector search ($vectorSearch) if available,
     * falling back to in-memory cosine similarity scan.
     *
     * Returns formatted text ready for injection into the system prompt,
     * or null if no relevant workflows are found.
     */
    async retrieveRelevantWorkflows(agent, project, queryText, options = {}) {
        if (!queryText || !project)
            return null;
        const database = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!database)
            return null;
        const workflowCollection = database.collection(COLLECTIONS.WORKFLOW_MEMORIES);
        const workflowCount = await workflowCollection.countDocuments({
            agent,
            project,
        });
        if (workflowCount === 0)
            return null;
        const queryEmbedding = await EmbeddingService.embed(queryText, {
            source: "workflow-query",
            project,
            endpoint: options.endpoint || "/agent",
            traceId: options.traceId,
            conversationId: options.conversationId,
            agentConversationId: options.agentConversationId,
            agent,
        });
        const maximumResults = options.maximumResults || MAXIMUM_WORKFLOWS_PER_QUERY;
        const allWorkflows = await workflowCollection
            .find({ agent, project }, {
            projection: {
                summary: 1,
                embedding: 1,
                userRequest: 1,
                stepCount: 1,
                createdAt: 1,
            },
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
        const scoredWorkflows = allWorkflows
            .filter((workflow) => Array.isArray(workflow.embedding) && workflow.embedding.length > 0)
            .map((workflow) => ({
            summary: workflow.summary,
            userRequest: workflow.userRequest,
            stepCount: workflow.stepCount,
            score: cosineSimilarity(queryEmbedding, workflow.embedding),
        }))
            .filter((scored) => scored.score > 0.4)
            .sort((workflowA, workflowB) => workflowB.score - workflowA.score)
            .slice(0, maximumResults);
        if (scoredWorkflows.length === 0)
            return null;
        let totalCharacters = 0;
        const workflowBlocks = [];
        for (const scored of scoredWorkflows) {
            const block = `### Past Workflow (similarity: ${(scored.score * 100).toFixed(0)}%)\n` +
                scored.summary;
            if (totalCharacters + block.length > WORKFLOW_TEXT_MAXIMUM_CHARACTERS)
                break;
            totalCharacters += block.length;
            workflowBlocks.push(block);
        }
        if (workflowBlocks.length === 0)
            return null;
        logger.info(`[WorkflowMemoryService] Retrieved ${workflowBlocks.length} relevant workflow(s) ` +
            `for agent="${agent}" (top score: ${(scoredWorkflows[0].score * 100).toFixed(0)}%)`);
        return (`## Past Successful Workflows\n` +
            `The following are procedures from past sessions that solved similar tasks. ` +
            `Use them as reference — adapt the approach, don't copy blindly.\n\n` +
            workflowBlocks.join("\n\n"));
    },
};
function cosineSimilarity(vectorA, vectorB) {
    if (vectorA.length !== vectorB.length || vectorA.length === 0)
        return 0;
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;
    for (let i = 0; i < vectorA.length; i++) {
        dotProduct += vectorA[i] * vectorB[i];
        magnitudeA += vectorA[i] * vectorA[i];
        magnitudeB += vectorB[i] * vectorB[i];
    }
    const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}
export default WorkflowMemoryService;
//# sourceMappingURL=WorkflowMemoryService.js.map