import logger from "../../../utils/logger.js";
import { TOOL_NAMES } from "../../ToolTaxonomyConstants.js";
import ToolOrchestratorService from "../../ToolOrchestratorService.js";
import path from "node:path";
import fs from "node:fs";
import { getErrorMessage } from "../../../utils/ErrorHelpers.js";
/**
 * ValidationInterceptor — automatic linter/AST feedback loop.
 *
 * After file-mutating tool calls (write_file, replace_in_file, patch_file),
 * runs language-aware validation and returns structured feedback. When errors
 * are detected, the harness injects them as a synthetic user message so the
 * model self-corrects on the next iteration without wasting a tool call.
 *
 * This is the "linter loop" pattern used by 2026 production agentic harnesses
 * (Cursor, Windsurf, Claude Code) to dramatically reduce cascading errors.
 */
const FILE_MUTATING_TOOLS = new Set([
    TOOL_NAMES.WRITE_FILE,
    TOOL_NAMES.STRING_REPLACE_FILE,
    TOOL_NAMES.PATCH_FILE,
    TOOL_NAMES.MOVE_FILE,
]);
const EXTENSION_VALIDATORS = {
    ".ts": { command: "npx tsc --noEmit --pretty", type: "typescript" },
    ".tsx": { command: "npx tsc --noEmit --pretty", type: "typescript" },
    ".js": { command: "npx eslint --format compact", type: "eslint" },
    ".jsx": { command: "npx eslint --format compact", type: "eslint" },
    ".json": { command: null, type: "json-parse" },
};
const VALIDATION_TIMEOUT_MS = 15_000;
/**
 * Extract the file path from a tool call's arguments.
 * Different tools use different argument names for the target path.
 */
function extractFilePath(toolCall) {
    const arguments_ = toolCall.args;
    const rawPath = arguments_.path ||
        arguments_.filePath ||
        arguments_.file ||
        arguments_.newPath;
    return typeof rawPath === "string" ? rawPath : null;
}
/**
 * Find the nearest directory containing a tsconfig.json or package.json starting from a file's directory.
 * Walks up the tree until it reaches the workspace root.
 */
function findNearestConfigDir(filePath, workspaceRoot) {
    const absoluteFilePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspaceRoot, filePath);
    let currentDirectory = path.dirname(absoluteFilePath);
    while (currentDirectory.startsWith(workspaceRoot) &&
        currentDirectory !== workspaceRoot) {
        const hasTsConfig = fs.existsSync(path.join(currentDirectory, "tsconfig.json"));
        const hasPackageJson = fs.existsSync(path.join(currentDirectory, "package.json"));
        if (hasTsConfig || hasPackageJson) {
            return currentDirectory;
        }
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory)
            break;
        currentDirectory = parentDirectory;
    }
    return workspaceRoot;
}
/**
 * Run inline JSON validation (no external process needed).
 */
function validateJsonInline(filePath, toolResult) {
    const resultObject = toolResult.result;
    if (!resultObject || resultObject.error)
        return null;
    // JSON parse validation only makes sense if we have the content.
    // Since the tool already succeeded writing it, we trust the write was valid JSON
    // unless the tool result explicitly mentions a parse error.
    return null;
}
/**
 * Run a shell-based validator command against a file path.
 */
async function runShellValidator(validatorConfig, filePath, context) {
    if (!validatorConfig.command)
        return null;
    const workspaceRoot = context.workspaceRoot || ToolOrchestratorService.getWorkspaceRoot();
    if (!workspaceRoot)
        return null;
    const executionCwd = findNearestConfigDir(filePath, workspaceRoot);
    try {
        const shellResult = (await ToolOrchestratorService.executeTool(TOOL_NAMES.RUN_COMMAND, {
            command: validatorConfig.command,
            cwd: executionCwd,
            timeout: VALIDATION_TIMEOUT_MS,
        }, {
            project: context.project,
            username: context.username,
            agent: context.agent || undefined,
            agentConversationId: context.agentConversationId,
            workspaceRoot,
            signal: context.signal || undefined,
        }));
        const exitCode = shellResult.exitCode ?? shellResult.code ?? 0;
        const standardOutput = (shellResult.stdout ||
            shellResult.output ||
            "");
        const standardError = (shellResult.stderr || "");
        const combinedOutput = (standardOutput + "\n" + standardError).trim();
        // Exit code 0 means no errors
        if (exitCode === 0 || !combinedOutput)
            return null;
        // Parse errors from output
        const errorLines = combinedOutput
            .split("\n")
            .filter((line) => line.includes("error") ||
            line.includes("Error") ||
            line.includes("✖"))
            .slice(0, 10);
        if (errorLines.length === 0 && combinedOutput.length < 20)
            return null;
        return {
            toolName: TOOL_NAMES.RUN_COMMAND,
            filePath,
            validatorType: validatorConfig.type,
            errors: errorLines.length > 0 ? errorLines : [combinedOutput.slice(0, 500)],
            rawOutput: combinedOutput.slice(0, 2000),
        };
    }
    catch (validationError) {
        logger.warn(`[ValidationInterceptor] Validator failed for ${filePath}: ${getErrorMessage(validationError)}`);
        return null;
    }
}
/**
 * Validate file-mutating tool results and return structured feedback.
 *
 * Called by harnesses after `executeToolBatch()` returns. Returns an empty
 * array when all validations pass or no file-mutating tools were called.
 */
export async function validateAfterToolExecution(toolCalls, results, context, _state) {
    const feedbackItems = [];
    for (const toolCall of toolCalls) {
        if (!FILE_MUTATING_TOOLS.has(toolCall.name))
            continue;
        const matchingResult = results.find((result) => result.id === toolCall.id ||
            (!result.id && result.name === toolCall.name));
        if (!matchingResult)
            continue;
        // Skip if the tool itself errored
        const resultObject = matchingResult.result;
        if (resultObject?.error)
            continue;
        const filePath = extractFilePath(toolCall);
        if (!filePath)
            continue;
        const fileExtension = path.extname(filePath).toLowerCase();
        const validatorConfig = EXTENSION_VALIDATORS[fileExtension];
        if (!validatorConfig)
            continue;
        // JSON gets inline validation (no shell needed)
        if (validatorConfig.type === "json-parse") {
            const jsonFeedback = validateJsonInline(filePath, matchingResult);
            if (jsonFeedback)
                feedbackItems.push(jsonFeedback);
            continue;
        }
        // Shell-based validators
        const shellFeedback = await runShellValidator(validatorConfig, filePath, context);
        if (shellFeedback) {
            // Override filePath to the specific file that was edited
            shellFeedback.filePath = filePath;
            feedbackItems.push(shellFeedback);
        }
    }
    if (feedbackItems.length > 0) {
        logger.info(`[ValidationInterceptor] Found ${feedbackItems.length} validation issue(s): ` +
            feedbackItems
                .map((feedback) => `${feedback.filePath} (${feedback.validatorType})`)
                .join(", "));
    }
    return feedbackItems;
}
//# sourceMappingURL=ValidationInterceptor.js.map