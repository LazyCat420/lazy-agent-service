/**
 * Safely extract an error message from an unknown value.
 * Replaces the ubiquitous `getErrorMessage(error)` pattern.
 */
export function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    return String(error);
}
//# sourceMappingURL=ErrorHelpers.js.map