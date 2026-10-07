/** Format a total parameter count into a human-readable string. */
export function formatParams(totalParams) {
    if (!totalParams)
        return null;
    if (totalParams >= 1_000_000_000) {
        const billions = totalParams / 1_000_000_000;
        return billions % 1 === 0 ? `${billions}B` : `${billions.toFixed(1)}B`;
    }
    if (totalParams >= 1_000_000) {
        return `${(totalParams / 1_000_000).toFixed(0)}M`;
    }
    return `${totalParams}`;
}
/** Extract parameter count from model name (e.g. "qwen3-8b" → "8B"). */
export function parseParamsFromName(name) {
    const match = name.match(/[-_](\d+(?:\.\d+)?[bB])\b/);
    if (match)
        return match[1].toUpperCase();
    const moeMatch = name.match(/[-_](\d+x\d+(?:\.\d+)?[bB])\b/);
    if (moeMatch)
        return moeMatch[1].toUpperCase();
    return null;
}
/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
export function parseQuantFromName(name) {
    const quantPatterns = [
        /[-_](AWQ)\b/i,
        /[-_](GPTQ)\b/i,
        /[-_](GGUF)\b/i,
        /[-_](EXL2)\b/i,
        /[-_](FP8)\b/i,
        /[-_](FP16)\b/i,
        /[-_](BF16)\b/i,
        /[-_](INT8)\b/i,
        /[-_](INT4)\b/i,
        /[@](q\d+_k(?:_[sml])?)\b/i,
    ];
    for (const pattern of quantPatterns) {
        const match = name.match(pattern);
        if (match)
            return match[1].toUpperCase();
    }
    return null;
}
/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
export function parsePublisherFromName(name) {
    if (name.includes("/"))
        return name.split("/")[0];
    return null;
}
//# sourceMappingURL=nameParsers.js.map