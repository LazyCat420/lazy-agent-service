import { expandMessagesForFunctionCall } from "../../utils/FunctionCallingUtilities.js";
import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import { mergeUsage, createUsageAccumulator, calculateTextCost, estimateTokens, } from "../../utils/CostCalculator.js";
import { calculateTokensPerSec } from "../../utils/math.js";
import { getPricing, TYPES } from "../../config.js";
import { stripToolCallMarkup } from "../../utils/StreamChunkDispatcher.js";
import ContextWindowManager from "../../utils/ContextWindowManager.js";
import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN, MINIMUM_CLAMPED_OUTPUT_TOKENS, MINIMUM_VIABLE_OUTPUT_TOKENS, } from "../../constants/TokenBudgetDefaults.js";
import ConversationGenerationTracker from "../ConversationGenerationTracker.js";
import RequestLogger from "../RequestLogger.js";
import FileService from "../FileService.js";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../../config.js";
import { COLLECTIONS, FILE_CATEGORIES } from "../../constants.js";
import { finalizeTextGeneration, computeNewTurnMessages, } from "./lifecycle/Finalizer.js";
import logger from "../../utils/logger.js";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, TOOL_NAMES, CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST, CORE_ORCHESTRATOR_TOOLS as CORE_ORCHESTRATOR_TOOLS_LIST, } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Span } from "../../platform/trace/Span.js";
import { TraceExporter } from "../../platform/trace/TraceExporter.js";
import { TraceContext } from "../../platform/trace/TraceContext.js";
import crypto from "node:crypto";
import ToolContext from "../ToolContext.js";
import WebhookEventBus from "../WebhookEventBus.js";
import ToolOrchestratorService from "../ToolOrchestratorService.js";
import AgenticToolResolver from "../AgenticToolResolver.js";
import { ToolDocFormatter } from "../system-prompt/ToolDocFormatter.js";
import { getToolPolicyAddendum } from "../personas/utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
/**
 * BaseAgenticHarness — abstract base class that defines the contract
 * for agentic loop execution strategies ("harnesses").
 *
 * Subclasses implement `run()` with their specific control flow
 * (standard tool loop, ReAct, plan-then-execute, etc.) while
 * inheriting shared infrastructure:
 *
 *   - Stream chunk routing (`processStreamChunk`)
 *   - Stream consumption (`consumeStream` — full pass with chunk routing)
 *   - Progress emission (`emitGenerationProgress`, `maybeEmitProgress`)
 *   - Iteration logging (`logIteration`)
 *   - Context window enforcement (`enforceContextWindow`)
 *   - LLM stream creation (`createProviderStream`)
 *   - Finalization (`finalize` — cost, persistence, done event)
 */
export default class BaseAgenticHarness {
    /** Harness identifier — subclasses MUST override. */
    static id = "base";
    static label = "Base (abstract)";
    static description = "Abstract base harness — do not use directly.";
    context;
    state;
    tools;
    trackerConversationId;
    _activeModelSpan = null;
    constructor(context, state, tools) {
        this.context = context;
        this.state = state;
        this.tools = tools;
        this.trackerConversationId = (context.parentAgentConversationId ||
            context.agentConversationId ||
            "");
    }
    /** Execute the agentic loop. Subclasses MUST override. */
    async run() {
        throw new Error(`${this.constructor.name}.run() is abstract — subclasses must override.`);
    }
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  DYNAMIC TOOL SET MUTATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    static CORE_AGENTIC_SET = new Set(CORE_AGENTIC_TOOLS_LIST);
    static CORE_ORCHESTRATOR_SET = new Set(CORE_ORCHESTRATOR_TOOLS_LIST);
    static toolDocFormatter = new ToolDocFormatter();
    /**
     * Check ToolContext for a dirty flag set by enable_tools / disable_tools.
     * If set, re-filter `this.tools` from the full schema catalog using the
     * dynamic enabled set stored in ToolContext.
     *
     * When tools are added, injects a documentation addendum into
     * currentMessages so the model receives human-readable descriptions
     * and parameter docs for dynamically activated tools (the initial
     * system prompt is only assembled on iteration 1 and never rebuilt).
     *
     * Returns true if the tool set was mutated.
     */
    checkAndApplyToolSetChanges(currentMessages) {
        const conversationId = this.context.agentConversationId;
        const toolContextStore = ToolContext.getStore(conversationId);
        if (!toolContextStore.get("toolSetDirty"))
            return false;
        toolContextStore.delete("toolSetDirty");
        const dynamicEnabledArray = toolContextStore.get("dynamicEnabledTools");
        if (!Array.isArray(dynamicEnabledArray))
            return false;
        const dynamicEnabledSet = new Set(dynamicEnabledArray);
        const previousToolNames = new Set(this.tools.finalTools.map((tool) => tool.name));
        const allSchemas = [
            ...ToolOrchestratorService.getToolSchemas(),
            ...ToolOrchestratorService.getMCPToolSchemas().map((mcpTool) => {
                const { _mcpServer, _mcpOriginalName, ...schema } = mcpTool;
                return schema;
            }),
        ];
        const isSubAgent = !!this.context.parentAgentConversationId;
        // When the model has native thinking, the think tool is redundant —
        // re-apply the same exclusion that AgenticToolResolver.resolve() does
        // during initial resolution, so dynamic tool set mutations don't
        // accidentally re-introduce it.
        const hasNativeThinking = AgenticToolResolver.detectNativeThinking(this.context.modelDefinition || undefined, this.context.providerName, this.context.resolvedModel, this.context.options?.thinkingEnabled);
        const filteredTools = allSchemas.filter((tool) => {
            if (hasNativeThinking && tool.name === TOOL_NAMES.THINK)
                return false;
            return (dynamicEnabledSet.has(tool.name) ||
                tool.name.startsWith("mcp__") ||
                BaseAgenticHarness.CORE_AGENTIC_SET.has(tool.name) ||
                (!isSubAgent &&
                    BaseAgenticHarness.CORE_ORCHESTRATOR_SET.has(tool.name)));
        });
        this.tools = {
            finalTools: filteredTools,
            resolvedEnabledTools: dynamicEnabledArray,
        };
        this.context.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.TOOL_SET_CHANGED,
            enabledCount: filteredTools.length,
            dynamicTools: dynamicEnabledArray,
        });
        // Compute newly added tools and inject documentation addendum
        const newlyAddedToolSchemas = filteredTools.filter((tool) => !previousToolNames.has(tool.name) &&
            !BaseAgenticHarness.CORE_AGENTIC_SET.has(tool.name) &&
            !BaseAgenticHarness.CORE_ORCHESTRATOR_SET.has(tool.name));
        if (currentMessages && newlyAddedToolSchemas.length > 0) {
            const activeLocale = this.context.options?.locale || PromptLocaleService.getDefaultLocale();
            const addendumDocumentation = BaseAgenticHarness.toolDocFormatter.buildToolDescriptions(newlyAddedToolSchemas.map((tool) => tool.name), undefined, undefined, newlyAddedToolSchemas.map((tool) => tool.name), undefined, undefined, activeLocale);
            if (addendumDocumentation) {
                const toolNamesList = newlyAddedToolSchemas
                    .map((tool) => tool.name)
                    .join(", ");
                const policyAddendum = getToolPolicyAddendum(newlyAddedToolSchemas.map((tool) => tool.name), activeLocale);
                const headerText = PromptLocaleService.get(activeLocale, "harness.toolSetUpdated.header", {
                    count: String(newlyAddedToolSchemas.length),
                    toolNames: toolNamesList,
                });
                const availableText = PromptLocaleService.get(activeLocale, "harness.toolSetUpdated.availableDocumentation");
                const guidelinesHeader = PromptLocaleService.get(activeLocale, "harness.toolSetUpdated.usageGuidelines");
                currentMessages.push({
                    role: "system",
                    content: `<tool-update>\n` +
                        `${headerText}\n\n` +
                        `${availableText}\n\n` +
                        addendumDocumentation +
                        (policyAddendum
                            ? `\n\n${guidelinesHeader}\n\n${policyAddendum}`
                            : "") +
                        `\n</tool-update>`,
                });
                logger.info(`[BaseAgenticHarness] Injected documentation addendum for ${newlyAddedToolSchemas.length} newly activated tools: [${toolNamesList}]` +
                    (policyAddendum
                        ? ` (with policy guidance)`
                        : ""));
            }
        }
        logger.info(`[BaseAgenticHarness] Tool set mutated: ${filteredTools.length} tools active (${dynamicEnabledArray.length} dynamic)`);
        return true;
    }
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  SHARED INFRASTRUCTURE — used by all harness subclasses
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ── Progress emission ────────────────────────────────────
    /** Emit a generation_progress status event with current session stats. */
    emitGenerationProgress() {
        const { emit } = this.context;
        const state = this.state;
        const stats = ConversationGenerationTracker.getConversationStats(this.trackerConversationId);
        if (stats.activeRequests > 0 || stats.totalOutputTokens > 0) {
            state.hwmOutputTokens = Math.max(state.hwmOutputTokens, stats.totalOutputTokens);
            state.hwmInputTokens = Math.max(state.hwmInputTokens, stats.totalInputTokens);
            state.hwmTotalTokens = Math.max(state.hwmTotalTokens, stats.totalTokens);
            state.hwmOutputCharacters = Math.max(state.hwmOutputCharacters, state.overallOutputCharacters);
            emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: STATUS_MESSAGES.GENERATION_PROGRESS,
                tokPerSec: stats.tokPerSec,
                activeRequests: stats.activeRequests,
                outputTokens: state.hwmOutputTokens,
                inputTokens: state.hwmInputTokens,
                totalTokens: state.hwmTotalTokens,
                outputCharacters: state.hwmOutputCharacters,
                avgTtft: stats.avgTtft,
            });
        }
        state.lastProgressEmitTime = performance.now();
        state.chunksSinceLastProgress = 0;
    }
    /** Check if it's time to emit a progress event. */
    maybeEmitProgress() {
        const state = this.state;
        state.chunksSinceLastProgress++;
        const timeSinceLast = performance.now() - state.lastProgressEmitTime;
        if (state.chunksSinceLastProgress >= state.PROGRESS_CHUNK_INTERVAL ||
            timeSinceLast >= state.PROGRESS_TIME_INTERVAL_MS) {
            this.emitGenerationProgress();
        }
    }
    /**
     * Emit a usage_update SSE event with the cumulative usage snapshot
     * and the server-computed estimatedCost (using CostCalculator).
     *
     * This is the authoritative intermediate cost during streaming —
     * the client should prefer this over any local recalculation.
     */
    emitUsageUpdate() {
        const { emit } = this.context;
        const state = this.state;
        const usage = { ...state.overallUsage, requests: state.iterations };
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[this.context.resolvedModel];
        const estimatedCost = calculateTextCost(usage, pricing);
        emit({
            type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
            usage,
            estimatedCost,
        });
    }
    // ── Context window enforcement ───────────────────────────
    /** Enforce token budget on messages before sending to provider. */
    enforceContextWindow(messages, toolCount) {
        const { modelDefinition, options = {}, emit } = this.context;
        const preEnforceCount = messages.length;
        const contextResult = ContextWindowManager.enforce(messages, {
            maxInputTokens: modelDefinition?.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS,
            maxOutputTokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
            toolCount,
            locale: options?.locale,
        });
        if (contextResult.truncated) {
            emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: STATUS_MESSAGES.CONTEXT_TRUNCATED,
                strategy: contextResult.strategy,
                estimatedTokens: contextResult.estimatedTokens,
            });
            // Recalculate originalMessageCount so finalize() slices correctly
            // against the post-truncation array, not the pre-truncation one.
            // Without this, the slice index points to the wrong position and
            // captures synthetic [CONTEXT NOTE] markers for DB persistence.
            const droppedCount = preEnforceCount - contextResult.messages.length;
            if (droppedCount > 0) {
                this.state.originalMessageCount = Math.max(0, this.state.originalMessageCount - droppedCount);
            }
            return contextResult.messages;
        }
        return messages;
    }
    // ── Provider stream creation ──────────────────────────────
    /**
     * Estimate total input tokens for an array of messages.
     * Uses the same ~4 chars/token heuristic as ContextWindowManager.
     */
    estimateInputTokens(messages) {
        let totalTokens = 0;
        for (const message of messages) {
            const content = typeof message.content === "string"
                ? message.content
                : message.content
                    ? JSON.stringify(message.content)
                    : "";
            totalTokens += estimateTokens(content);
            if (message.thinking) {
                totalTokens += estimateTokens(message.thinking);
            }
            const toolCalls = message.toolCalls || message.tool_calls;
            if (toolCalls) {
                totalTokens += estimateTokens(JSON.stringify(toolCalls));
            }
            if (message.images && Array.isArray(message.images)) {
                totalTokens += message.images.length * 1000;
            }
        }
        return totalTokens;
    }
    /**
     * Dynamically clamp maxTokens so that input + output never exceeds
     * the model's context window. This is the industry-standard approach
     * (used by OpenAI SDKs, Cursor, Claude Code) to prevent 400 errors
     * from context overflow on models with finite context windows.
     *
     * Returns the clamped maxTokens value. If no clamping is needed,
     * returns the original value unchanged.
     */
    clampOutputTokens(messages, requestedMaxTokens) {
        const { modelDefinition } = this.context;
        const contextWindow = modelDefinition?.maxInputTokens;
        if (!contextWindow || !requestedMaxTokens)
            return requestedMaxTokens;
        const estimatedInputTokens = this.estimateInputTokens(messages);
        const availableForOutput = contextWindow - estimatedInputTokens - OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN;
        if (requestedMaxTokens <= availableForOutput)
            return requestedMaxTokens;
        const clampedMaxTokens = Math.max(availableForOutput, MINIMUM_CLAMPED_OUTPUT_TOKENS);
        logger.warn(`[OutputTokenClamp] Clamping maxTokens from ${requestedMaxTokens} → ${clampedMaxTokens} ` +
            `(contextWindow=${contextWindow}, estimatedInput=${estimatedInputTokens}, ` +
            `safetyMargin=${OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN}). ` +
            `Without clamping: ${estimatedInputTokens + requestedMaxTokens} > ${contextWindow}.`);
        return clampedMaxTokens;
    }
    /**
     * Create an LLM text stream from the provider.
     * Handles liveAPI fallback, message expansion, and dynamic output
     * token clamping to prevent context window overflow.
     *
     * Returns `null` when the pre-flight context exhaustion guard (ported
     * from prism-service) determines that context pressure has clamped the
     * output budget below MINIMUM_VIABLE_OUTPUT_TOKENS — sending such a
     * request would only produce a mid-tool-call truncation. A
     * `context_exhausted` status event is emitted before returning null.
     */
    createProviderStream(messages, passOptions) {
        const { provider, providerName, resolvedModel, modelDefinition, signal } = this.context;
        if (this.context.runtimeToolExecutor) {
            const limit = this.context.options.maxTokens ?? 0;
            const consumed = this.state.overallUsage.inputTokens + this.state.overallUsage.outputTokens;
            const remaining = limit - consumed;
            if (remaining <= 0)
                throw Object.assign(new Error("Canonical token budget exhausted"), { code: "TOKEN_BUDGET_EXHAUSTED" });
            passOptions = { ...passOptions, maxTokens: Math.min(passOptions.maxTokens ?? remaining, remaining) };
        }
        const clampedMaxTokens = this.clampOutputTokens(messages, passOptions.maxTokens);
        // ── Pre-flight context exhaustion guard ──────────────────
        // Fires only when clamping actually reduced the requested budget below
        // the viable floor (an intentionally small requested maxTokens is fine).
        if (passOptions.maxTokens &&
            clampedMaxTokens !== undefined &&
            clampedMaxTokens !== passOptions.maxTokens &&
            clampedMaxTokens < MINIMUM_VIABLE_OUTPUT_TOKENS) {
            const contextWindow = modelDefinition?.maxInputTokens || 0;
            logger.warn(`[ContextExhaustionGuard] Output budget ${clampedMaxTokens} < ` +
                `${MINIMUM_VIABLE_OUTPUT_TOKENS} threshold — context window (${contextWindow}) exhausted. ` +
                `Skipping provider call instead of sending a doomed request.`);
            this.context.emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: "context_exhausted",
                availableOutputTokens: clampedMaxTokens,
                contextWindow,
            });
            const activeCtx = TraceContext.get();
            const exhaustedSpan = new Span({
                trace_id: activeCtx?.trace_id || this.context.rootSpan?.trace_id || this.context.traceId || crypto.randomUUID().replaceAll("-", "").slice(0, 32),
                parent_span_id: activeCtx?.current_span_id || this.context.rootSpan?.span_id || null,
                run_id: activeCtx?.run_id || this.context.runId || this.context.agentConversationId || "run_gen",
                name: `llm.generate:${resolvedModel}`,
                kind: "model_call",
                attributes: {
                    model: resolvedModel,
                    provider: providerName,
                    error: "context_exhausted",
                },
            });
            exhaustedSpan.end("ERROR", "context_exhausted");
            TraceExporter.getGlobalInstance().enqueueSpan(exhaustedSpan.toJSON());
            return null;
        }
        const clampedPassOptions = clampedMaxTokens !== passOptions.maxTokens
            ? { ...passOptions, maxTokens: clampedMaxTokens }
            : passOptions;
        const expandedMessages = expandMessagesForFunctionCall(messages, {
            filterDeleted: false,
        });
        // Start model span before provider invocation to capture setup errors and initial latency
        const activeCtx = TraceContext.get();
        const parentSpan = this.context.rootSpan;
        const modelSpan = new Span({
            trace_id: activeCtx?.trace_id || parentSpan?.trace_id || this.context.traceId || crypto.randomUUID().replaceAll("-", "").slice(0, 32),
            parent_span_id: activeCtx?.current_span_id || parentSpan?.span_id || null,
            run_id: activeCtx?.run_id || this.context.runId || this.context.agentConversationId || "run_gen",
            name: `llm.generate:${resolvedModel}`,
            kind: "model_call",
            attributes: {
                model: resolvedModel,
                provider: providerName,
            },
        });
        this._activeModelSpan = modelSpan;
        try {
            return modelDefinition?.liveAPI && provider.generateTextStreamLive
                ? provider.generateTextStreamLive(expandedMessages, resolvedModel, {
                    ...clampedPassOptions,
                    signal,
                })
                : provider.generateTextStream(expandedMessages, resolvedModel, {
                    ...clampedPassOptions,
                    signal,
                });
        }
        catch (setupErr) {
            const errMsg = setupErr instanceof Error ? setupErr.message : String(setupErr);
            modelSpan.end("ERROR", errMsg);
            TraceExporter.getGlobalInstance().enqueueSpan(modelSpan.toJSON());
            this._activeModelSpan = null;
            throw setupErr;
        }
    }
    // ── Stream consumption ────────────────────────────────────
    /**
     * Consume an LLM stream, routing each chunk through `processStreamChunk`.
     * Handles abort signals and stream teardown.
     *
     * Accepts `null` (from the context exhaustion guard in
     * `createProviderStream`) as a no-op — the pass ends with empty output
     * and each harness's empty-output/exhaustion handling takes over.
     */
    async consumeStream(stream, pass, allowedToolNames) {
        if (stream === null)
            return;
        const activeCtx = TraceContext.get();
        const parentSpan = this.context.rootSpan;
        const modelSpan = this._activeModelSpan || new Span({
            trace_id: activeCtx?.trace_id || parentSpan?.trace_id || this.context.traceId || crypto.randomUUID().replaceAll("-", "").slice(0, 32),
            parent_span_id: activeCtx?.current_span_id || parentSpan?.span_id || null,
            run_id: activeCtx?.run_id || this.context.runId || this.context.agentConversationId || "run_gen",
            name: `llm.generate:${this.context.resolvedModel}`,
            kind: "model_call",
            attributes: {
                model: this.context.resolvedModel,
                provider: this.context.providerName,
            },
        });
        this._activeModelSpan = null;
        try {
            for await (const chunk of stream) {
                const result = await this.processStreamChunk(chunk, pass, allowedToolNames);
                if (result.action === "break") {
                    const returnable = stream;
                    if (typeof returnable.return === "function")
                        returnable.return(undefined);
                    break;
                }
            }
            if (pass.usageReported) {
                modelSpan.setAttributes({
                    tokens_input: pass.usage.inputTokens,
                    tokens_output: pass.usage.outputTokens,
                    tokens_cache: pass.usage.cacheReadInputTokens,
                    total_tokens: (pass.usage.totalTokens ?? ((pass.usage.inputTokens || 0) + (pass.usage.outputTokens || 0))),
                });
            }
            modelSpan.end("OK");
            TraceExporter.getGlobalInstance().enqueueSpan(modelSpan.toJSON());
        }
        catch (err) {
            modelSpan.end("ERROR", err instanceof Error ? err.message : String(err));
            TraceExporter.getGlobalInstance().enqueueSpan(modelSpan.toJSON());
            throw err;
        }
    }
    // ── Session tracking helpers ──────────────────────────────
    /** Register a request with ConversationGenerationTracker. */
    registerTrackerRequest(passRequestId) {
        const { providerName, resolvedModel, parentAgentConversationId, agentConversationId, } = this.context;
        const resolvedParent = parentAgentConversationId;
        const resolvedAgent = agentConversationId;
        ConversationGenerationTracker.register(this.trackerConversationId, passRequestId, {
            provider: providerName,
            model: resolvedModel,
            source: resolvedParent ? "sub-agent" : "orchestrator",
            subAgentId: resolvedParent ? resolvedAgent : null,
        });
    }
    // ── Stream chunk processing ───────────────────────────────
    /**
     * Process a single stream chunk — routes to the appropriate handler.
     * Returns an action descriptor for the caller:
     *   `continue` — chunk was consumed, keep iterating
     *   `toolCall` — a tool call was detected
     *   `skip`     — chunk was filtered/dropped
     *   `break`    — abort signal received
     */
    processStreamChunk(chunk, pass, allowedToolNames) {
        const { emit, signal } = this.context;
        const state = this.state;
        // Cast to a loose typed object — we branch on `type` below
        const streamChunk = chunk;
        // Abort check
        if (signal?.aborted)
            return { action: "break" };
        // ── Usage event ──────────────────────────────────────
        if (streamChunk?.type === "usage") {
            const usageChunk = streamChunk.usage;
            pass.usageReported = usageChunk !== undefined && Object.values(usageChunk).some(value => typeof value === "number");
            mergeUsage(state.overallUsage, usageChunk);
            mergeUsage(pass.usage, usageChunk);
            const rawUsage = streamChunk.usage;
            if (pass.requestId) {
                const reportedInput = usageChunk?.inputTokens || rawUsage?.promptTokens || 0;
                const reportedOutput = usageChunk?.outputTokens || 0;
                const trackerUpdate = {};
                if (reportedInput > 0)
                    trackerUpdate.inputTokens = reportedInput;
                if (reportedOutput > 0)
                    trackerUpdate.outputTokens = reportedOutput;
                if (usageChunk?.tokensPerSec != null && usageChunk.tokensPerSec > 0) {
                    trackerUpdate.providerTokPerSec = usageChunk.tokensPerSec;
                }
                if (Object.keys(trackerUpdate).length > 0) {
                    ConversationGenerationTracker.update(pass.requestId, trackerUpdate);
                }
            }
            return { action: "continue" };
        }
        // ── Rate limits ──────────────────────────────────────
        if (streamChunk?.type === "rateLimits") {
            state.lastRateLimits = streamChunk.rateLimits || null;
            return { action: "continue" };
        }
        // ── Stop reason (truncation detection) ───────────────
        if (streamChunk?.type === "stopReason") {
            pass.stopReason = streamChunk.stopReason || undefined;
            return { action: "continue" };
        }
        // ── Thinking ─────────────────────────────────────────
        if (streamChunk?.type === "thinking") {
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            state.streamedThinking += streamChunk.content || "";
            pass.streamedThinking += streamChunk.content || "";
            if (state.displayThinkingFragments.length === 0 || state.lastDisplaySegType !== "thinking") {
                logger.debug(`[Harness:Thinking] NEW thinking segment on iteration ${state.iterations}, ` +
                    `fragments=${state.displayThinkingFragments.length}, lastSegType=${state.lastDisplaySegType}, ` +
                    `contentLen=${(streamChunk.content || "").length}ch`);
            }
            // Display segment tracking
            if (state.lastDisplaySegType !== "thinking") {
                state.displaySegments.push({
                    type: SERVER_SENT_EVENT_TYPES.THINKING,
                    fragmentIndex: state.displayThinkingFragments.length,
                });
                state.displayThinkingFragments.push("");
                state.lastDisplaySegType = "thinking";
            }
            state.displayThinkingFragments[state.displayThinkingFragments.length - 1] += streamChunk.content || "";
            state.overallOutputCharacters += (streamChunk.content || "").length;
            if (pass.requestId) {
                ConversationGenerationTracker.recordChunkTiming(pass.requestId, (streamChunk.content || "").length);
            }
            emit({
                type: SERVER_SENT_EVENT_TYPES.THINKING,
                content: streamChunk.content || "",
                outputCharacters: state.overallOutputCharacters,
            });
            this.maybeEmitProgress();
            return { action: "continue" };
        }
        // ── Thinking signature (Anthropic) ───────────────────
        if (streamChunk?.type === "thinking_signature") {
            pass.thinkingSignature = streamChunk.signature || "";
            return { action: "continue" };
        }
        // ── Tool call start (early disclosure) ─────────────────
        if (streamChunk?.type === "toolCallStart") {
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            emit({
                type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
                tool: {
                    name: streamChunk.name || "",
                    args: {},
                    id: streamChunk.id || "",
                },
                status: "streaming",
            });
            this.maybeEmitProgress();
            return { action: "continue" };
        }
        // ── Tool call argument delta ─────────────────────────
        if (streamChunk?.type === "toolCallDelta") {
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            state.overallOutputCharacters += streamChunk.characters;
            if (pass.requestId) {
                ConversationGenerationTracker.recordChunkTiming(pass.requestId, streamChunk.characters);
            }
            this.maybeEmitProgress();
            return { action: "continue" };
        }
        // ── Tool call ────────────────────────────────────────
        if (streamChunk?.type === "toolCall") {
            if (streamChunk.name) {
                const resolvedName = this._resolveToolName(streamChunk.name);
                if (resolvedName && resolvedName !== streamChunk.name) {
                    logger.info(`[AgenticLoop] Resolved raw tool call "${streamChunk.name}" to canonical "${resolvedName}"`);
                    streamChunk.name = resolvedName;
                }
            }
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            if (pass.requestId) {
                ConversationGenerationTracker.recordChunkTiming(pass.requestId, JSON.stringify(streamChunk.args || {}).length);
            }
            this.maybeEmitProgress();
            // Native MCP tool calls: pass through directly
            if (streamChunk.native) {
                const toolName = streamChunk.name || "";
                const toolCallId = streamChunk.id || `ntc-${state.streamedToolCalls.length}`;
                if (streamChunk.status === "calling") {
                    state.streamedToolCalls.push({
                        id: toolCallId,
                        name: toolName,
                        args: streamChunk.args || {},
                    });
                    this._trackToolDisplaySegment(toolCallId);
                    WebhookEventBus.emit("request.tool_call.started", {
                        requestId: this.context.requestId || null,
                        toolName,
                        toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
                        toolCallId,
                        toolArgs: streamChunk.args || {},
                        agent: this.context.agent || null,
                        conversationId: this.context.conversationId || null,
                        agentConversationId: this.context.agentConversationId || null,
                        project: this.context.project,
                        username: this.context.username,
                        provider: this.context.providerName,
                        model: this.context.resolvedModel,
                        iteration: this.state.iterations,
                    });
                }
                else if (streamChunk.status === "done" ||
                    streamChunk.status === "error") {
                    const existing = state.streamedToolCalls.find((toolCall) => (streamChunk.id && toolCall.id === streamChunk.id) ||
                        (!streamChunk.id && toolCall.name === streamChunk.name));
                    if (existing) {
                        existing.result = streamChunk.result;
                        existing.status = streamChunk.status;
                        if (streamChunk.args && Object.keys(streamChunk.args).length > 0)
                            existing.args = streamChunk.args;
                    }
                    WebhookEventBus.emit("request.tool_call.completed", {
                        requestId: this.context.requestId || null,
                        toolName,
                        toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
                        toolCallId,
                        toolResult: streamChunk.result || null,
                        durationMs: null,
                        status: streamChunk.status,
                        agent: this.context.agent || null,
                        conversationId: this.context.conversationId || null,
                        agentConversationId: this.context.agentConversationId || null,
                        project: this.context.project,
                        username: this.context.username,
                        provider: this.context.providerName,
                        model: this.context.resolvedModel,
                    });
                }
                emit({
                    type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
                    id: streamChunk.id || null,
                    name: streamChunk.name,
                    args: streamChunk.args || {},
                    result: streamChunk.result || undefined,
                    status: streamChunk.status || "calling",
                });
                return { action: "continue" };
            }
            // Schema enforcement
            const toolName = streamChunk.name || "";
            let isUnauthorized = false;
            if (!allowedToolNames.has(toolName)) {
                if (this.tools.finalTools.some((t) => t.name === toolName)) {
                    logger.info(`[AgenticLoop] Auto-loading registered tool "${toolName}" called directly by LLM`);
                    this.state.loadedTools.add(toolName);
                    allowedToolNames.add(toolName);
                }
                else {
                    logger.warn(`[AgenticLoop] Unauthorized tool call "${toolName}" — not in schema: [${[...allowedToolNames].join(", ")}]`);
                    isUnauthorized = true;
                }
            }
            const standardToolCallId = streamChunk.id || `toolCall-${state.streamedToolCalls.length}`;
            const toolCall = {
                id: standardToolCallId,
                responsesItemId: streamChunk.responsesItemId || undefined,
                name: toolName,
                args: streamChunk.args || {},
                thoughtSignature: streamChunk.thoughtSignature || undefined,
                reasoningItem: streamChunk.reasoningItem || undefined,
                isUnauthorized,
            };
            pass.pendingToolCalls.push(toolCall);
            state.streamedToolCalls.push({ ...toolCall });
            this._trackToolDisplaySegment(standardToolCallId);
            emit({
                type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
                tool: {
                    name: toolName,
                    args: streamChunk.args || {},
                    id: standardToolCallId,
                },
                status: "calling",
            });
            WebhookEventBus.emit("request.tool_call.started", {
                requestId: this.context.requestId || null,
                toolName,
                toolEmoji: ToolOrchestratorService.getToolEmoji(toolName),
                toolCallId: standardToolCallId,
                toolArgs: streamChunk.args || {},
                agent: this.context.agent || null,
                conversationId: this.context.conversationId || null,
                agentConversationId: this.context.agentConversationId || null,
                project: this.context.project,
                username: this.context.username,
                provider: this.context.providerName,
                model: this.context.resolvedModel,
                iteration: this.state.iterations,
            });
            return { action: "toolCall", toolCall: toolCall };
        }
        // ── Image ────────────────────────────────────────────
        if (streamChunk?.type === "image") {
            return this._handleImageChunk(streamChunk, pass);
        }
        // ── Pass-through events ──────────────────────────────
        if (streamChunk?.type === "executableCode") {
            emit({
                type: "executableCode",
                code: streamChunk.code,
                language: streamChunk.language,
            });
            return { action: "continue" };
        }
        if (streamChunk?.type === "codeExecutionResult") {
            emit({
                type: "codeExecutionResult",
                output: streamChunk.output,
                outcome: streamChunk.outcome,
            });
            return { action: "continue" };
        }
        if (streamChunk?.type === "webSearchResult") {
            emit({ type: "webSearchResult", results: streamChunk.results });
            return { action: "continue" };
        }
        if (streamChunk?.type === "audio") {
            emit({
                type: SERVER_SENT_EVENT_TYPES.AUDIO,
                data: streamChunk.data,
                mimeType: streamChunk.mimeType,
            });
            if (streamChunk.data)
                state.streamedAudioChunks.push(streamChunk.data);
            if (streamChunk.mimeType) {
                const rateMatch = streamChunk.mimeType.match(/rate=(\d+)/);
                if (rateMatch)
                    state.audioSampleRate = parseInt(rateMatch[1], 10);
            }
            return { action: "continue" };
        }
        if (streamChunk?.type === "status") {
            const { type: _type, ...statusRest } = streamChunk;
            emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, ...statusRest });
            return { action: "continue" };
        }
        // ── Text chunk (default) ─────────────────────────────
        this._recordFirstToken(pass);
        this._recordTiming(pass);
        const rawChunkString = typeof chunk === "string" ? chunk : "";
        state.overallOutputCharacters += rawChunkString.length;
        pass.outputCharacters += rawChunkString.length;
        pass.streamedText += rawChunkString;
        // Strip tool call XML markup leaked by some local models
        const cleanedPassText = stripToolCallMarkup(pass.streamedText);
        const chunkString = cleanedPassText.slice((pass.finalStreamedText || "").length);
        pass.finalStreamedText = cleanedPassText;
        state.finalStreamedText = cleanedPassText;
        if (state.planModeActive)
            state.planModeText += chunkString;
        // Display segment tracking
        if (state.lastDisplaySegType !== "text") {
            state.displaySegments.push({
                type: SERVER_SENT_EVENT_TYPES.TEXT,
                fragmentIndex: state.displayTextFragments.length,
            });
            state.displayTextFragments.push("");
            state.lastDisplaySegType = "text";
        }
        state.displayTextFragments[state.displayTextFragments.length - 1] +=
            chunkString;
        if (pass.requestId) {
            ConversationGenerationTracker.recordChunkTiming(pass.requestId, rawChunkString.length);
        }
        if (chunkString)
            emit({
                type: SERVER_SENT_EVENT_TYPES.CHUNK,
                content: chunkString,
                outputCharacters: state.overallOutputCharacters,
            });
        this.maybeEmitProgress();
        return { action: "continue" };
    }
    // ── Iteration logging ─────────────────────────────────────
    /** Log a single iteration to the request log. */
    logIteration(pass, currentMessages) {
        const { resolvedModel, providerName, project, username, agent, conversationId, agentConversationId, parentAgentConversationId, traceId, } = this.context;
        const state = this.state;
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        const passTotalSec = (performance.now() - pass.start) / 1000;
        const passGenerationSec = pass.firstTokenTime && pass.generationEnd
            ? (pass.generationEnd - pass.firstTokenTime) / 1000
            : null;
        const passTokensPerSec = calculateTokensPerSec(pass.usage.outputTokens, passGenerationSec);
        const passEstimatedCost = calculateTextCost(pass.usage, pricing);
        // Two-phase completion: if we pre-inserted a pending skeleton on
        // iteration start, update it in-place instead of inserting a new doc.
        const legacyPayload = {
            requestId: `${this.context.requestId}-${state.iterations}`,
            endpoint: "/agent",
            operation: "agent:iteration",
            project,
            username,
            clientIp: this.context.clientIp,
            agent: agent || null,
            provider: providerName,
            model: resolvedModel,
            conversationId,
            agentConversationId,
            parentAgentConversationId: parentAgentConversationId || null,
            traceId: traceId || null,
            success: true,
            usage: pass.usage,
            estimatedCost: passEstimatedCost,
            tokensPerSec: passTokensPerSec,
            timeToGenerationSec: pass.firstTokenTime
                ? (pass.firstTokenTime - pass.start) / 1000
                : null,
            generationSec: passGenerationSec,
            totalSec: passTotalSec,
            options: pass.options,
            messages: currentMessages,
            text: pass.streamedText,
            thinking: pass.streamedThinking,
            images: pass.streamedImages,
            toolCalls: pass.pendingToolCalls,
            outputCharacters: pass.outputCharacters,
            agenticIteration: state.iterations,
        };
        const fullPayload = {
            requestId: `${this.context.requestId}-${state.iterations}`,
            endpoint: "/agent",
            operation: "agent:iteration",
            project,
            username,
            clientIp: this.context.clientIp,
            agent: agent || null,
            provider: providerName,
            model: resolvedModel,
            conversationId,
            agentConversationId,
            parentAgentConversationId: parentAgentConversationId || null,
            traceId: traceId || null,
            toolsUsed: pass.pendingToolCalls.length > 0,
            toolDisplayNames: pass.pendingToolCalls.length > 0
                ? [...new Set(pass.pendingToolCalls.map((toolCall) => toolCall.name))]
                : [],
            toolApiNames: pass.pendingToolCalls.length > 0
                ? [...new Set(pass.pendingToolCalls.map((toolCall) => toolCall.name))]
                : [],
            success: true,
            inputTokens: Number(pass.usage.inputTokens) || 0,
            outputTokens: Number(pass.usage.outputTokens) || 0,
            cacheReadInputTokens: Number(pass.usage.cacheReadInputTokens) || 0,
            cacheCreationInputTokens: Number(pass.usage.cacheCreationInputTokens) || 0,
            reasoningOutputTokens: Number(pass.usage.reasoningOutputTokens) || 0,
            estimatedCost: passEstimatedCost,
            tokensPerSec: passTokensPerSec,
            temperature: pass.options?.temperature ?? null,
            maxTokens: pass.options?.maxTokens ?? null,
            topP: pass.options?.topP ?? null,
            topK: pass.options?.topK ?? null,
            frequencyPenalty: pass.options?.frequencyPenalty ?? null,
            presencePenalty: pass.options?.presencePenalty ?? null,
            stopSequences: pass.options?.stopSequences ?? null,
            messageCount: currentMessages?.length ?? 0,
            inputCharacters: currentMessages?.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0) ?? 0,
            outputCharacters: pass.outputCharacters,
            timeToGeneration: pass.firstTokenTime
                ? roundMilliseconds((pass.firstTokenTime - pass.start) / 1000)
                : null,
            generationTime: passGenerationSec !== null ? roundMilliseconds(passGenerationSec) : null,
            totalTime: roundMilliseconds(passTotalSec),
            requestPayload: {
                messages: currentMessages?.map((message) => ({
                    role: message.role,
                    content: message.content,
                })) ?? [],
                agenticIteration: state.iterations,
            },
            responsePayload: {
                text: pass.streamedText || null,
                thinking: pass.streamedThinking || null,
                ...(pass.streamedImages.length > 0 ? { images: pass.streamedImages } : {}),
                toolCalls: pass.pendingToolCalls.length > 0
                    ? pass.pendingToolCalls.map((toolCall) => ({
                        name: toolCall.name,
                        id: toolCall.id,
                        args: toolCall.args,
                    }))
                    : null,
                usage: pass.usage,
            },
        };
        pass.pendingRequestDocumentIdPromise.then((pendingRequestDocumentId) => {
            if (pendingRequestDocumentId) {
                RequestLogger.completePending(pendingRequestDocumentId, fullPayload).catch((error) => logger.error(`[AgenticLoopService] Failed to complete pending request: ${errorMessage(error)}`));
            }
            else {
                RequestLogger.logChatGeneration(legacyPayload).catch((error) => logger.error(`[AgenticLoopService] Failed to log intermediate request: ${errorMessage(error)}`));
            }
        }).catch((error) => {
            logger.error(`[BaseAgenticHarness] Error resolving pendingRequestDocumentIdPromise: ${errorMessage(error)}`);
            RequestLogger.logChatGeneration(legacyPayload).catch((loggingError) => logger.error(`[AgenticLoopService] Failed to log intermediate request on fallback: ${errorMessage(loggingError)}`));
        });
    }
    // ── Per-iteration pass state factory ──────────────────────
    /** Create a fresh per-iteration pass state object. */
    createPassState(passOptions) {
        const { resolvedModel, providerName, project, username, agent, conversationId, agentConversationId, parentAgentConversationId, traceId, requestId, } = this.context;
        const pendingPromise = RequestLogger.insertPending({
            requestId: `${requestId}-${this.state.iterations}`,
            endpoint: "/agent",
            operation: "agent:iteration",
            project,
            username,
            clientIp: this.context.clientIp,
            agent: agent || null,
            harness: passOptions?.harness || null,
            provider: providerName,
            model: resolvedModel,
            conversationId,
            traceId: traceId || null,
            agentConversationId: agentConversationId || null,
            parentAgentConversationId: parentAgentConversationId || null,
            agenticIteration: this.state.iterations,
        }).catch((error) => {
            logger.error(`[BaseAgenticHarness] Failed to insert pending request: ${errorMessage(error)}`);
            return null;
        });
        const passState = {
            streamedText: "",
            finalStreamedText: "",
            streamedThinking: "",
            thinkingSignature: "",
            pendingToolCalls: [],
            streamedImages: [],
            start: performance.now(),
            firstTokenTime: null,
            generationEnd: null,
            outputCharacters: 0,
            usage: createUsageAccumulator(),
            options: passOptions,
            requestId: null, // set after tracker registration
            pendingRequestDocumentIdPromise: pendingPromise,
        };
        return passState;
    }
    // ── Finalization ──────────────────────────────────────────
    /**
     * Shared finalization logic — cost calculation, persistence,
     * done event, sub-agent snapshot persistence, and afterResponse hooks.
     *
     * Lifted from ReActHarness so all harnesses share the same
     * finalization path without copy-paste.
     */
    async finalize(currentMessages, hooks) {
        const context = this.context;
        const state = this.state;
        if (context.signal?.aborted) {
            state.conversationOutcome = "aborted";
        }
        const { agentConversationId, conversationId, project, username } = context;
        const requestStart = context.requestStart ?? performance.now();
        const now = performance.now();
        state.overallUsage.requests = state.iterations;
        const { cleanSegments, cleanTextFragments, cleanThinkingFragments } = state.getCleanDisplayData();
        // If the last message of the original context was already persisted (e.g. background timer reminder or scheduled task),
        // we slice from originalMessageCount so we don't append it again. Otherwise, we slice from
        // originalMessageCount - 1 to capture the user's triggering message for this turn.
        const newTurnMessages = computeNewTurnMessages(context.messages, currentMessages, state.originalMessageCount);
        logger.info(`[AgenticLoop] finalize: conversation=${agentConversationId} conversationId=${conversationId} project=${project} ` +
            `originalMsgCount=${state.originalMessageCount} currentMsgs=${currentMessages.length} ` +
            `newTurnMsgs=${newTurnMessages.length} ` +
            `roles=[${newTurnMessages.map((conversationMessage) => conversationMessage.role).join(",")}] ` +
            `text=${(state.finalStreamedText || "").length}chars`);
        await finalizeTextGeneration(context, {
            text: state.finalStreamedText.trim(),
            thinking: state.streamedThinking.trim() || "",
            images: state.streamedImages,
            toolCalls: state.streamedToolCalls,
            audioChunks: state.streamedAudioChunks,
            audioSampleRate: state.audioSampleRate,
            usage: state.overallUsage,
            outputCharacters: state.overallOutputCharacters,
            timeToGenerationSec: state.overallFirstTokenTime
                ? (state.overallFirstTokenTime - requestStart) / 1000
                : null,
            generationSec: state.overallFirstTokenTime && state.overallGenerationEnd
                ? (state.overallGenerationEnd - state.overallFirstTokenTime) / 1000
                : null,
            totalSec: (now - requestStart) / 1000,
            rateLimits: state.lastRateLimits,
            contentSegments: cleanSegments,
            textFragments: cleanTextFragments,
            thinkingFragments: cleanThinkingFragments,
            resolvedEnabledTools: this.tools.resolvedEnabledTools,
        }, newTurnMessages);
        // Persist sub-agent snapshots for orchestrator conversations
        if (state.streamedToolCalls.some((toolCall) => toolCall.name === TOOL_NAMES.CREATE_SUBAGENT) &&
            conversationId) {
            try {
                const { default: OrchestratorService } = await import("../OrchestratorService.js");
                const activeSubAgentsList = OrchestratorService.listAllDescendantSubAgents(conversationId);
                if (activeSubAgentsList.length > 0) {
                    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_CONVERSATIONS);
                    const agentSessionDocument = await collection.findOne({ id: conversationId, project, username }, { projection: { subAgents: 1 } });
                    const existingSubAgentsList = agentSessionDocument?.subAgents || [];
                    const mergedSubAgentsMap = new Map();
                    for (const subAgent of existingSubAgentsList) {
                        mergedSubAgentsMap.set(subAgent.agentId, subAgent);
                    }
                    for (const subAgent of activeSubAgentsList) {
                        mergedSubAgentsMap.set(subAgent.agentId, subAgent);
                    }
                    const finalSubAgentsList = Array.from(mergedSubAgentsMap.values());
                    await collection.updateOne({ id: conversationId, project, username }, {
                        $set: {
                            subAgents: finalSubAgentsList,
                            subAgentsUpdatedAt: new Date().toISOString(),
                        },
                    });
                    logger.info(`[AgenticLoop] Persisted ${finalSubAgentsList.length} sub-agent(s) to conversation ${conversationId}`);
                }
            }
            catch (error) {
                logger.error(`[AgenticLoop] Failed to persist sub-agents: ${errorMessage(error)}`);
            }
        }
        // afterResponse hook (fire-and-forget)
        hooks
            .run("afterResponse", context, {
            text: state.finalStreamedText,
            thinking: state.streamedThinking,
            toolCalls: state.streamedToolCalls,
            messages: currentMessages,
            conversationOutcome: state.conversationOutcome,
        })
            .catch((error) => logger.error(`[AgenticLoopService] afterResponse hooks failed: ${errorMessage(error)}`));
        // Append the final assistant message so that the in-memory messages array
        // returned to the Orchestrator/caller includes the final text response.
        currentMessages.push({
            role: "assistant",
            content: state.finalStreamedText.trim(),
            ...(state.streamedThinking.trim() && {
                thinking: state.streamedThinking.trim(),
            }),
            ...(state.streamedImages.length > 0 && { images: state.streamedImages }),
            ...(state.streamedToolCalls.length > 0 && {
                toolCalls: state.streamedToolCalls.map((toolCall) => ({
                    id: toolCall.id || null,
                    responsesItemId: toolCall.responsesItemId || undefined,
                    name: toolCall.name,
                    args: toolCall.args,
                    thoughtSignature: toolCall.thoughtSignature || undefined,
                    reasoningItem: toolCall.reasoningItem || undefined,
                    result: toolCall.result,
                })),
            }),
        });
    }
    // ── Private helpers ───────────────────────────────────────
    _recordFirstToken(pass) {
        const state = this.state;
        if (!state.overallFirstTokenTime)
            state.overallFirstTokenTime = performance.now();
        if (!pass.firstTokenTime) {
            pass.firstTokenTime = performance.now();
            const ttftSec = (pass.firstTokenTime - pass.start) / 1000;
            if (pass.requestId)
                ConversationGenerationTracker.update(pass.requestId, { ttft: ttftSec });
            this.context.emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: STATUS_MESSAGES.GENERATION_STARTED,
                timeToFirstToken: ttftSec,
            });
        }
    }
    _recordTiming(pass) {
        this.state.overallGenerationEnd = performance.now();
        pass.generationEnd = performance.now();
    }
    _trackToolDisplaySegment(toolCallId) {
        const state = this.state;
        const lastSeg = state.displaySegments[state.displaySegments.length - 1];
        if (state.lastDisplaySegType === "tools" && lastSeg?.type === "tools") {
            lastSeg.toolIds.push(toolCallId);
        }
        else {
            state.displaySegments.push({ type: "tools", toolIds: [toolCallId] });
            state.lastDisplaySegType = "tools";
        }
    }
    _resolveToolName(toolName) {
        // 1. Direct match
        if (this.tools.finalTools.some((t) => t.name === toolName)) {
            return toolName;
        }
        const cleanName = toolName.toLowerCase().replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
        // 2. Exact match after stripping MCP prefixes
        for (const t of this.tools.finalTools) {
            const cleanT = t.name.toLowerCase().replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
            if (cleanT === cleanName) {
                return t.name;
            }
        }
        // 3. Match without "get_" or "post_" prefixes
        const cleanWithoutGet = cleanName.replace(/^(get_|post_|execute_)/, "");
        for (const t of this.tools.finalTools) {
            const cleanT = t.name.toLowerCase().replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "").replace(/^(get_|post_|execute_)/, "");
            if (cleanT === cleanWithoutGet) {
                return t.name;
            }
        }
        return undefined;
    }
    async _handleImageChunk(chunk, pass) {
        const { emit, project, username } = this.context;
        const state = this.state;
        let minioRef = null;
        if (chunk.data) {
            try {
                const mimeType = chunk.mimeType || "image/png";
                const dataUrl = `data:${mimeType};base64,${chunk.data}`;
                const { ref } = await FileService.uploadFile(dataUrl, FILE_CATEGORIES.GENERATIONS, project, username);
                minioRef = ref;
            }
            catch (error) {
                logger.error(`MinIO upload failed: ${errorMessage(error)}`);
            }
            const imgRef = minioRef ||
                `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`;
            state.streamedImages.push(imgRef);
            pass.streamedImages.push(imgRef);
        }
        emit({
            type: SERVER_SENT_EVENT_TYPES.IMAGE,
            ...(minioRef ? {} : { data: chunk.data }),
            mimeType: chunk.mimeType,
            minioRef,
        });
        return { action: "continue" };
    }
}
//# sourceMappingURL=BaseAgenticHarness.js.map