// ─────────────────────────────────────────────────────────────
// ConversationGenerationTracker
// ─────────────────────────────────────────────────────────────
// Per-conversation in-memory tracker for active LLM requests.
// Tracks token throughput at the source (backend provider level)
// so the frontend receives authoritative tok/s data instead of
// computing rates from SSE chunk inter-arrival times.
//
// Each active LLM request registers itself here with timing and
// token data. The aggregate conversation tok/s is computed on demand
// from all active requests — covering the orchestrator, sub-agents,
// and tool sub-requests (e.g. generate_image → Prism /chat).
//
// Tracked metrics per request:
//   - outputTokens  (incremental, per chunk/thinking)
//   - inputTokens   (set once, from provider usage report)
//   - ttft          (time to first token, seconds)
//
// Conversation-level accumulators persist across request completions
// so cumulative counts never decrease.
// ─────────────────────────────────────────────────────────────
// ── Rate computation guards ─────────────────────────────────
// Prevent anomalous spikes from single large chunks or very
// short elapsed windows. Rate is only reported once enough
// samples have accumulated to produce a statistically meaningful
// average. The token estimate (~4 chars/token) can massively
// overcount on large thinking deltas, so we need a generous
// window to let the rate stabilize before reporting.
const MIN_ELAPSED_SEC = 0.5; // 500ms minimum sample window
const MIN_TOKENS_FOR_RATE = 10; // minimum tokens before reporting rate
// ── State ───────────────────────────────────────────────────
const activeRequests = new Map();
const conversationIndex = new Map();
const conversationAccumulators = new Map();
const ConversationGenerationTracker = {
    register(agentConversationId, requestId, { provider, model, source = "orchestrator", subAgentId = null, } = {}) {
        if (!agentConversationId || !requestId)
            return;
        const entry = {
            requestId,
            agentConversationId,
            startTime: performance.now(),
            firstTokenTime: null,
            lastTokenTime: null,
            outputTokens: 0,
            chunkCount: 0,
            outputCharacters: 0,
            inputTokens: 0,
            ttft: null,
            provider: provider || "any",
            model: model || "any",
            source,
            subAgentId: subAgentId ?? null,
            providerTokPerSec: null,
        };
        activeRequests.set(requestId, entry);
        // Maintain conversation → requests index
        if (!conversationIndex.has(agentConversationId)) {
            conversationIndex.set(agentConversationId, new Set());
        }
        conversationIndex.get(agentConversationId).add(requestId);
        // Initialize conversation accumulator (idempotent — preserves across iterations)
        if (!conversationAccumulators.has(agentConversationId)) {
            conversationAccumulators.set(agentConversationId, {
                completedOutputTokens: 0,
                completedInputTokens: 0,
                ttftSamples: [],
                completedTokPerSecSamples: [],
            });
        }
    },
    /**
     * Update a tracked request with new token data.
     * Called on each chunk/thinking event or on usage completion.
     */
    update(requestId, { outputTokens, inputTokens, ttft, providerTokPerSec } = {}) {
        const entry = activeRequests.get(requestId);
        if (!entry)
            return;
        const now = performance.now();
        if (!entry.firstTokenTime)
            entry.firstTokenTime = now;
        entry.lastTokenTime = now;
        if (outputTokens != null) {
            entry.outputTokens = outputTokens;
        }
        if (inputTokens != null) {
            entry.inputTokens = inputTokens;
        }
        if (ttft != null) {
            entry.ttft = ttft;
        }
        if (providerTokPerSec != null) {
            entry.providerTokPerSec = providerTokPerSec;
        }
    },
    /**
     * Record chunk timing, increment the chunk counter, and accumulate
     * output characters for token estimation.
     *
     * The character count provides a much more accurate token estimate
     * than raw chunk count: Anthropic sends large thinking deltas
     * (50-200+ chars) as a single chunk, so chunkCount severely
     * undercounts tokens. Using `outputCharacters / 4` (~4 chars/token
     * for English) gives a reliable cross-provider heuristic.
     */
    recordChunkTiming(requestId, charCount = 0) {
        const entry = activeRequests.get(requestId);
        if (!entry)
            return;
        const now = performance.now();
        if (!entry.firstTokenTime)
            entry.firstTokenTime = now;
        entry.lastTokenTime = now;
        entry.chunkCount++;
        entry.outputCharacters += charCount;
    },
    /**
     * Mark a request as complete and remove it from active tracking.
     * Rolls the request's final token counts and computed tok/s into
     * the conversation accumulator so cumulative totals remain monotonically
     * non-decreasing.
     */
    complete(requestId) {
        const entry = activeRequests.get(requestId);
        if (!entry)
            return;
        // Use provider-reported output tokens when available (authoritative).
        // Fall back to chars/4 estimation when the provider didn't report usage
        // (e.g. OpenAI response.completed event intermittently missing).
        const effectiveOutputTokens = entry.outputTokens > 0
            ? entry.outputTokens
            : entry.outputCharacters > 0
                ? Math.ceil(entry.outputCharacters / 4)
                : 0;
        // Compute this request's tok/s from the effective token count and
        // the timing window captured during streaming.
        let requestTokPerSec = null;
        if (entry.providerTokPerSec != null && entry.providerTokPerSec > 0) {
            requestTokPerSec = entry.providerTokPerSec;
        }
        else if (effectiveOutputTokens > 0 &&
            entry.firstTokenTime &&
            entry.lastTokenTime) {
            const elapsed = (entry.lastTokenTime - entry.firstTokenTime) / 1000;
            if (elapsed >= MIN_ELAPSED_SEC) {
                requestTokPerSec = effectiveOutputTokens / elapsed;
            }
        }
        // Roll completed metrics into the conversation accumulator
        const accumulator = conversationAccumulators.get(entry.agentConversationId);
        if (accumulator) {
            accumulator.completedOutputTokens += effectiveOutputTokens;
            accumulator.completedInputTokens += entry.inputTokens;
            if (entry.ttft != null) {
                accumulator.ttftSamples.push(entry.ttft);
            }
            // Persist tok/s so it survives across iteration boundaries
            if (requestTokPerSec != null) {
                accumulator.completedTokPerSecSamples.push(requestTokPerSec);
            }
        }
        activeRequests.delete(requestId);
        const conversationSet = conversationIndex.get(entry.agentConversationId);
        if (conversationSet) {
            conversationSet.delete(requestId);
            if (conversationSet.size === 0)
                conversationIndex.delete(entry.agentConversationId);
        }
    },
    /**
     * Compute aggregate stats for all active requests in a conversation.
     *
     * Rate computation uses a warm-up guard: tok/s is only reported once
     * a request has accumulated at least MIN_TOKENS_FOR_RATE tokens over
     * at least MIN_ELAPSED_SEC seconds. This prevents anomalous spikes
     * from single large chunks arriving in near-zero elapsed time.
     */
    getConversationStats(agentConversationId) {
        const requestIds = conversationIndex.get(agentConversationId);
        const accumulator = conversationAccumulators.get(agentConversationId);
        const completedOutputTokens = accumulator?.completedOutputTokens || 0;
        const completedInputTokens = accumulator?.completedInputTokens || 0;
        const ttftSamples = accumulator?.ttftSamples || [];
        if (!requestIds || requestIds.size === 0) {
            const totalOut = completedOutputTokens;
            const totalIn = completedInputTokens;
            const avgTtft = ttftSamples.length > 0
                ? ttftSamples.reduce((ttftSample, b) => ttftSample + b, 0) / ttftSamples.length
                : null;
            // Use the most recent completed tok/s (last iteration's rate)
            const completedSamples = accumulator?.completedTokPerSecSamples || [];
            const lastTokPerSec = completedSamples.length > 0
                ? parseFloat(completedSamples[completedSamples.length - 1].toFixed(1))
                : null;
            return {
                tokPerSec: lastTokPerSec,
                activeRequests: 0,
                totalOutputTokens: totalOut,
                totalInputTokens: totalIn,
                totalTokens: totalIn + totalOut,
                avgTtft,
            };
        }
        let totalTokPerSec = 0;
        let generatingCount = 0;
        let activeOutputTokens = 0;
        let activeInputTokens = 0;
        let activeTtftSum = 0;
        let activeTtftCount = 0;
        for (const rid of requestIds) {
            const request = activeRequests.get(rid);
            if (!request)
                continue;
            activeOutputTokens += request.outputTokens;
            activeInputTokens += request.inputTokens;
            if (request.ttft != null) {
                activeTtftSum += request.ttft;
                activeTtftCount++;
            }
            // Only compute tok/s for requests that have warmed up:
            // - firstTokenTime and lastTokenTime must exist
            // - enough tokens/chunks to be statistically meaningful
            // - enough elapsed time to avoid early-burst spikes
            //
            // Use provider-reported outputTokens when available (authoritative,
            // set at stream end). During streaming, estimate from cumulative
            // output characters using ~4 chars/token heuristic. This is far
            // more accurate than raw chunkCount for providers like Anthropic
            // that send large thinking deltas as single chunks.
            const estimatedFromChars = request.outputCharacters > 0
                ? Math.ceil(request.outputCharacters / 4)
                : request.chunkCount;
            const effectiveTokens = request.outputTokens > 0 ? request.outputTokens : estimatedFromChars;
            if (request.firstTokenTime &&
                request.lastTokenTime &&
                effectiveTokens >= MIN_TOKENS_FOR_RATE) {
                if (request.providerTokPerSec != null && request.providerTokPerSec > 0) {
                    totalTokPerSec += request.providerTokPerSec;
                    generatingCount++;
                }
                else {
                    const elapsed = (request.lastTokenTime - request.firstTokenTime) / 1000;
                    if (elapsed >= MIN_ELAPSED_SEC) {
                        totalTokPerSec += effectiveTokens / elapsed;
                        generatingCount++;
                    }
                }
            }
        }
        const totalOut = completedOutputTokens + activeOutputTokens;
        const totalIn = completedInputTokens + activeInputTokens;
        // Average TTFT across completed + active samples
        const allTtftSum = ttftSamples.reduce((ttftSample, b) => ttftSample + b, 0) +
            activeTtftSum;
        const allTtftCount = ttftSamples.length + activeTtftCount;
        const avgTtft = allTtftCount > 0 ? allTtftSum / allTtftCount : null;
        // Tok/s: aggregate throughput across all active requests (sum, not average).
        // When multiple sub-agents generate in parallel, the conversation-level rate
        // reflects total tokens/sec being produced across the entire conversation.
        let tokPerSec = null;
        if (generatingCount > 0) {
            tokPerSec = parseFloat(totalTokPerSec.toFixed(1));
        }
        else {
            const completedSamples = accumulator?.completedTokPerSecSamples || [];
            if (completedSamples.length > 0) {
                tokPerSec = parseFloat(completedSamples[completedSamples.length - 1].toFixed(1));
            }
        }
        return {
            tokPerSec,
            activeRequests: requestIds.size,
            // Cumulative: completed requests + in-flight requests
            totalOutputTokens: totalOut,
            totalInputTokens: totalIn,
            totalTokens: totalIn + totalOut,
            avgTtft: avgTtft != null ? parseFloat(avgTtft.toFixed(3)) : null,
        };
    },
    getSessionStats(agentConversationId) {
        return this.getConversationStats(agentConversationId);
    },
    cleanup(agentConversationId) {
        const requestIds = conversationIndex.get(agentConversationId);
        if (requestIds) {
            for (const rid of requestIds) {
                activeRequests.delete(rid);
            }
            conversationIndex.delete(agentConversationId);
        }
        conversationAccumulators.delete(agentConversationId);
    },
    hasActiveRequests(agentConversationId) {
        const requestIds = conversationIndex.get(agentConversationId);
        return !!(requestIds && requestIds.size > 0);
    },
    /** Total active requests across all conversations (for diagnostics). */
    get totalActiveRequests() {
        return activeRequests.size;
    },
};
export default ConversationGenerationTracker;
//# sourceMappingURL=ConversationGenerationTracker.js.map