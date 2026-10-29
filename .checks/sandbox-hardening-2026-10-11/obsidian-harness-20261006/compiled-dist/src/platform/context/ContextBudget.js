export const DEFAULT_CONTEXT_BUDGET = {
    totalMaxChars: 64_000, // ~16k tokens estimate at 4 chars/token
    prefixRatio: 0.20,
    projectScopeRatio: 0.30,
    evidenceRatio: 0.25,
    dynamicTailRatio: 0.25,
};
export class ContextBudget {
    totalMaxChars;
    prefixBudgetChars;
    projectScopeBudgetChars;
    evidenceBudgetChars;
    dynamicTailBudgetChars;
    constructor(config = {}) {
        const merged = { ...DEFAULT_CONTEXT_BUDGET, ...config };
        this.totalMaxChars = merged.totalMaxChars;
        this.prefixBudgetChars = Math.floor(this.totalMaxChars * merged.prefixRatio);
        this.projectScopeBudgetChars = Math.floor(this.totalMaxChars * merged.projectScopeRatio);
        this.evidenceBudgetChars = Math.floor(this.totalMaxChars * merged.evidenceRatio);
        this.dynamicTailBudgetChars = Math.floor(this.totalMaxChars * merged.dynamicTailRatio);
    }
    /**
     * Enforces budget limits on a specific layer, returning the bounded text and summary metrics.
     */
    clampLayer(text, budgetChars, itemCount = 1) {
        const originalLen = text.length;
        if (originalLen <= budgetChars) {
            return {
                text,
                summary: {
                    allocated_chars: budgetChars,
                    used_chars: originalLen,
                    truncated: false,
                    item_count: itemCount,
                },
            };
        }
        const truncatedText = text.slice(0, budgetChars);
        return {
            text: truncatedText,
            summary: {
                allocated_chars: budgetChars,
                used_chars: budgetChars,
                truncated: true,
                item_count: itemCount,
            },
        };
    }
}
//# sourceMappingURL=ContextBudget.js.map