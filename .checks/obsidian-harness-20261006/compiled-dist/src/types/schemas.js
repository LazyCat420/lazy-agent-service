import { z } from "zod";
/**
 * Zod Schemas for Runtime Payload Validation
 *
 * Implements "Schema-driven Runtime Request Validation" (Declarative Payload Parsing).
 * This ensures strict typing and validation at the endpoint boundaries, replacing
 * unsafe manual assertions and explicit 'any' parsing.
 */
const DISALLOWED_IDENTIFIER_PATTERN = /[\x00]|\.\.\/|\.\.\\/;
const sanitizedString = () => z
    .string()
    .transform((value) => value.replace(/\x00/g, ""))
    .pipe(z.string().refine((value) => !DISALLOWED_IDENTIFIER_PATTERN.test(value), { message: "String contains disallowed characters (null bytes or path traversal)" }));
export const ToolSchemaSchema = z.object({
    name: z.string(),
    description: z.string(),
    _isCustom: z.boolean().optional(),
    parameters: z
        .object({
        type: z.string(),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).optional(),
    })
        .optional(),
});
export const ChatMessageContentSchema = z.object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string() }).optional(),
});
export const ChatMessageSchema = z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(ChatMessageContentSchema)]),
    name: z.string().optional(),
    images: z.array(z.string()).optional(),
    deleted: z.boolean().optional(),
    toolCalls: z
        .array(z.object({
        id: z.string().optional(),
        name: z.string(),
        args: z.record(z.string(), z.unknown()),
    }))
        .optional(),
    thinking: z.string().optional(),
    thinkingSignature: z.string().optional(),
});
export const ChatRequestSchema = z
    .object({
    provider: sanitizedString(),
    model: z.string().nullable().optional(),
    messages: z.array(ChatMessageSchema),
    conversationId: z.string().nullable().optional(),
    agentConversationId: sanitizedString().nullable().optional(),
    conversationMeta: z.record(z.string(), z.unknown()).nullable().optional(),
    traceId: z.string().nullable().optional(),
    project: z.string().default("any"),
    username: z.string().default("any"),
    clientIp: z.string().nullable().optional().default(null),
    agent: z.string().nullable().optional().default(null),
    harness: sanitizedString().nullable().optional(),
    topology: z.string().nullable().optional(),
    thoughtStructure: z.string().nullable().optional(),
    // Generation options — flat at top-level
    tools: z.array(ToolSchemaSchema).nullable().optional(),
    temperature: z.number().nullable().optional(),
    maxTokens: z.number().nullable().optional(),
    topP: z.number().nullable().optional(),
    topK: z.number().nullable().optional(),
    frequencyPenalty: z.number().nullable().optional(),
    presencePenalty: z.number().nullable().optional(),
    stopSequences: z.array(z.string()).nullable().optional(),
    seed: z.union([z.number(), z.string()]).nullable().optional(),
    minP: z.number().nullable().optional(),
    repeatPenalty: z.number().nullable().optional(),
    thinkingEnabled: z.boolean().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
    thinkingLevel: z.string().nullable().optional(),
    thinkingBudget: z.union([z.number(), z.string()]).nullable().optional(),
    webSearch: z.union([z.boolean(), z.string()]).nullable().optional(),
    webFetch: z.boolean().nullable().optional(),
    codeExecution: z.boolean().nullable().optional(),
    urlContext: z.boolean().nullable().optional(),
    verbosity: z.string().nullable().optional(),
    reasoningSummary: z.string().nullable().optional(),
    functionCallingEnabled: z.boolean().nullable().optional(),
    agenticLoopEnabled: z.boolean().nullable().optional(),
    enabledTools: z.array(z.string()).nullable().optional(),
    disabledTools: z.array(z.string()).nullable().optional(),
    minContextLength: z.number().nullable().optional(),
    evalBatchSize: z.number().nullable().optional(),
    forceImageGeneration: z.boolean().nullable().optional(),
    responseFormat: z.unknown().nullable().optional(),
    serviceTier: z.string().nullable().optional(),
    textOnly: z.boolean().nullable().optional(),
    skipConversation: z.boolean().nullable().optional(),
    autoApprove: z.boolean().nullable().optional(),
    planFirst: z.boolean().nullable().optional(),
    maxIterations: z.number().nullable().optional(),
    maxSubAgentIterations: z.number().nullable().optional(),
    maxRecursionDepth: z.number().int().min(0).max(3).nullable().optional(),
    agentContext: z.unknown().nullable().optional(),
    workspaceRoot: z.string().nullable().optional(),
    workspaceEnabled: z.boolean().nullable().optional(),
    enableCriticGate: z.boolean().nullable().optional(),
    criticModel: z.string().nullable().optional(),
    reminderModel: z.string().nullable().optional(),
    reminderProvider: z.string().nullable().optional(),
    parallelToolCalls: z.boolean().nullable().optional(),
    candidateCount: z.number().nullable().optional(),
    branchCount: z.number().nullable().optional(),
    responseMimeType: z.string().nullable().optional(),
    store: z.boolean().nullable().optional(),
    mediaResolution: z.string().nullable().optional(),
    topLogprobs: z.number().nullable().optional(),
    responseLogprobs: z.boolean().nullable().optional(),
    logprobs: z.number().nullable().optional(),
    locale: z.string().nullable().optional(),
})
    .passthrough(); // Support extra provider/custom parameters dynamically
export const PutWorkspacesSchema = z.object({
    roots: z.array(z.string()),
});
export const ValidateWorkspaceSchema = z.object({
    path: z.string(),
});
export const PostCustomToolSchema = z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional().default(""),
    code: z.string().optional().default(""),
    endpoint: z.string().optional().default(""),
    method: z.string().optional().default("GET"),
    parameters: z
        .array(z.object({
        name: z.string(),
        type: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean().optional(),
    }))
        .optional()
        .default([]),
    execution: z
        .enum(["sandboxed", "privileged"])
        .optional()
        .default("sandboxed"),
    enabled: z.boolean().optional().default(true),
});
export const PutCustomToolSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    code: z.string().optional(),
    endpoint: z.string().optional(),
    method: z.string().optional(),
    parameters: z
        .array(z.object({
        name: z.string(),
        type: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean().optional(),
    }))
        .optional(),
    execution: z.enum(["sandboxed", "privileged"]).optional(),
    enabled: z.boolean().optional(),
});
export const GetTextQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    origin: z.enum(["user", "ai"]).optional(),
    search: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
});
export const GetMediaQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    type: z.enum(["image", "audio"]).optional(),
    origin: z.enum(["user", "ai"]).optional(),
    search: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
});
export const GetFavoritesQuerySchema = z.object({
    type: z.string().optional(),
});
export const PostFavoritesBodySchema = z.object({
    type: z.string().min(1, "type is required"),
    key: z.string().min(1, "key is required"),
    meta: z.record(z.string(), z.unknown()).optional(),
});
export const DeleteFavoritesQuerySchema = z.object({
    type: z.string().min(1, "type is required"),
    key: z.string().min(1, "key is required"),
});
export const PostMcpServerSchema = z.object({
    name: z.string().min(1, "name is required"),
    displayName: z.string().optional(),
    transport: z
        .enum(["stdio", "sse", "streamable-http"])
        .optional()
        .default("stdio"),
    command: z.string().optional().default(""),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional().default({}),
    url: z.string().optional().default(""),
    headers: z.record(z.string(), z.string()).optional().default({}),
    enabled: z.boolean().optional().default(true),
});
export const PutMcpServerSchema = z.object({
    name: z.string().min(1).optional(),
    displayName: z.string().optional(),
    transport: z.enum(["stdio", "sse", "streamable-http"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
});
export const GetConversationsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().nullable().optional(),
    agent: z.string().nullable().optional(),
    type: z.enum(["direct", "agent", "all"]).optional().default("all"),
    taskId: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
});
export const PostConversationMessagesBodySchema = z.object({
    messages: z
        .array(ChatMessageSchema)
        .nonempty("messages must be a non-empty array"),
    conversationMeta: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const PatchConversationBodySchema = z.object({
    title: z.string().optional(),
    messages: z.array(ChatMessageSchema).optional(),
    systemPrompt: z.string().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
});
export const PostSynthesisBodySchema = z.object({
    id: z.string().min(1, "id is required"),
    title: z.string().optional().default("Untitled Synthesis"),
    systemPrompt: z.string().optional().default(""),
    userPersona: z.string().optional().default(""),
    category: z.string().optional().default("Chat"),
    targetTurns: z.number().int().optional().default(4),
    seedMessages: z.array(ChatMessageSchema).optional().default([]),
    settings: z.record(z.string(), z.unknown()).optional().default({}),
    conversationId: z.string().nullable().optional().default(null),
});
export const PatchSynthesisBodySchema = z.object({
    title: z.string().optional(),
    systemPrompt: z.string().optional(),
    assistantPersona: z.string().optional(),
    userPersona: z.string().optional(),
    category: z.string().optional(),
    targetTurns: z.number().int().optional(),
    seedMessages: z.array(ChatMessageSchema).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    conversationId: z.string().nullable().optional(),
});
export const PostSkillSchema = z.object({
    name: z.string().min(1, "name is required"),
    description: z.string().optional().default(""),
    content: z.string().optional().default(""),
    enabled: z.boolean().optional().default(true),
});
export const PutSkillSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    content: z.string().optional(),
    enabled: z.boolean().optional(),
});
export const PostRuleSchema = z.object({
    name: z.string().min(1, "name is required"),
    description: z.string().optional().default(""),
    content: z.string().optional().default(""),
    agent: z.string().min(1, "agent is required"),
    enabled: z.boolean().optional().default(true),
});
export const PutRuleSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    content: z.string().optional(),
    enabled: z.boolean().optional(),
});
export const GetAgentConversationsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().nullable().optional(),
    agent: z.string().nullable().optional(),
});
export const GetVramBenchmarksQuerySchema = z.object({
    settings: z.string().optional(),
    hostname: z.string().optional(),
    context: z.coerce.number().int().optional(),
    provider: z.string().optional(),
    limit: z.coerce.number().int().min(1).default(2000),
});
export const PostPromptSchema = z.object({
    title: z.string().min(1, "title is required").max(500),
    content: z.string().min(1, "content is required").max(50000),
    tags: z.array(z.string().max(100)).max(20).optional().default([]),
    color: z.string().max(100).optional(),
});
export const PatchPromptSchema = z.object({
    title: z.string().min(1).max(500).optional(),
    content: z.string().min(1).max(50000).optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
    color: z.string().max(100).optional(),
});
export const GetPromptsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    search: z.string().optional(),
});
//# sourceMappingURL=schemas.js.map