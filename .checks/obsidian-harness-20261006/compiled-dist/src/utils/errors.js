import logger from "./logger.js";
export class ProviderError extends Error {
    provider;
    statusCode;
    originalError;
    errorType;
    constructor(provider, message, statusCode = 500, originalError = null) {
        super(message);
        this.name = "ProviderError";
        this.provider = provider;
        this.statusCode = statusCode;
        this.originalError = originalError;
        // Structured error type from provider SDKs (e.g. Anthropic's "rate_limit_error")
        this.errorType =
            originalError?.type ?? null;
    }
    toJSON() {
        return {
            error: true,
            provider: this.provider,
            message: this.message,
            statusCode: this.statusCode,
            ...(this.errorType && { errorType: this.errorType }),
        };
    }
}
export function errorHandler(error, _req, res, _next) {
    const provider = error instanceof ProviderError ? error.provider : "Server";
    logger.error(`${provider}: ${error.message}`);
    if (error instanceof ProviderError) {
        return res.status(error.statusCode).json(error.toJSON());
    }
    return res.status(500).json({
        error: true,
        message: error.message || "Internal server error",
        statusCode: 500,
    });
}
//# sourceMappingURL=errors.js.map