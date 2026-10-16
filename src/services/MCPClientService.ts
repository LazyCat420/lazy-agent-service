// ported from prism-service src/services/MCPClientService.ts (restored from lazy-agent-service 9113901^, trimmed of prism's OAuth/quarantine/profile layers)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import fs from "node:fs";
import logger from "../utils/logger.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import type { Db } from "mongodb";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { COLLECTIONS } from "../constants.ts";
import { ACCEPTED_MCP_PREFIXES } from "./McpPrefix.ts";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import {
  approveMcpTools,
  reviewMcpTools,
  type McpQuarantinedTool,
  type McpToolPins,
} from "./mcp/McpToolFingerprint.ts";
import { capMcpToolResult, resolveOutputCapTokens } from "./mcp/McpOutputCap.ts";
import {
  McpAuthorizationRequiredError,
  McpOAuthProvider,
  resolveProviderRedirectUrl,
} from "./mcp/McpOAuth.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MCPToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  _mcpServer: string;
  _mcpOriginalName: string;
  domain?: string;
  labels?: string[];
}

interface MCPRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  domain?: string;
  labels?: string[];
  /** MCP-standard extension point — survives Zod validation unlike top-level custom fields */
  _meta?: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** The stored document's id — keys OAuth credentials and the tool pins. */
  _id?: unknown;
  username?: string;
  /** Fingerprints of the tools the owner approved (see McpToolFingerprint). */
  toolPins?: McpToolPins | null;
  /** Cap, in estimated tokens, on one tool result (default MCP_OUTPUT_CAP_TOKENS). */
  outputCapTokens?: number | null;
  toolOutputCapTokens?: Record<string, number> | null;
  /** OAuth 2.1 (PKCE, dynamic registration) instead of static headers. */
  auth?: { type: "oauth"; scope?: string | null } | null;
  /** Origin of the request that started a connect — the OAuth redirect base. */
  _requestOrigin?: string | null;
  [key: string]: unknown;
}

interface MCPConnection {
  client: Client;
  transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport;
  /** Approved tools only — what the model sees. */
  tools: MCPToolSchema[];
  mcpTools: MCPRawTool[];
  /** Everything the server offers now, approved or not. */
  offeredTools: MCPRawTool[];
  /** Tools held back until the owner approves them (new or changed since approval). */
  quarantined: McpQuarantinedTool[];
  /** Approved fingerprints. Null: never approved (the first connect approves). */
  pins: McpToolPins | null;
  config: MCPServerConfig;
  status: string;
  connectedAt: Date;
}

interface MCPAuthOptions {
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface MCPContentBlock {
  type: string;
  text?: string;
  blob?: string;
  uri?: string;
  mimeType?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Tool name delimiter — MCP tools are namespaced as `mcp__{serverName}__{toolName}`.
 * Double underscore avoids collisions since neither server names nor tool names use it.
 */
const MCP_DELIMITER = "__";
const MCP_PREFIX = "mcp" + MCP_DELIMITER;

const RESERVED_SERVER_NAMES = new Set(
  ACCEPTED_MCP_PREFIXES.filter((prefix) => prefix.startsWith(MCP_PREFIX)).map((prefix) =>
    prefix.slice(MCP_PREFIX.length, -MCP_DELIMITER.length),
  ),
);

// ─── Connection Store ─────────────────────────────────────────────────────────

/**
 * Map of serverName → { client: Client, transport, tools: [], config, status }
 */
const connections = new Map<string, MCPConnection>();

/** Pins by server name, kept across disconnects (the stored document also carries them). */
const rememberedPins = new Map<string, McpToolPins>();

/** Persist fields on the server's stored document. Best-effort: a missing DB or id only costs durability. */
async function updateMcpServerRecord(
  config: MCPServerConfig,
  set: Record<string, unknown>,
): Promise<void> {
  const id = config._id ? String(config._id) : null;
  if (!id || !ObjectId.isValid(id)) return;
  try {
    await MongoWrapper.getDb(MONGO_DB_NAME)
      ?.collection(COLLECTIONS.MCP_SERVERS)
      .updateOne({ _id: new ObjectId(id) }, { $set: set });
  } catch (error: unknown) {
    logger.warn(`[MCP] Could not save ${Object.keys(set).join(", ")} for "${config.name}": ${getErrorMessage(error)}`);
  }
}

// Register shutdown cleanup — disconnect all MCP servers
registerCleanup(async () => {
  if (connections.size === 0) return;
  logger.info(`[MCP] Shutdown: disconnecting ${connections.size} server(s)…`);
  const names = [...connections.keys()];
  await Promise.allSettled(
    names.map(async (name) => {
      const conn = connections.get(name);
      if (!conn) return;
      try {
        await conn.client.close();
      } catch {
        /* best-effort */
      }
      if (conn.transport?.close) {
        try {
          await conn.transport.close();
        } catch {
          /* best-effort */
        }
      }
      connections.delete(name);
    }),
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert an MCP tool schema (JSON Schema) to OpenAI function-calling format.
 * Namespaces the tool name with the server prefix.
 */
function mcpToolToSchema(
  serverName: string,
  mcpTool: MCPRawTool,
): MCPToolSchema {
  // Extract domain/labels from _meta (MCP-standard extension point) as fallback.
  // Top-level custom fields get stripped by the MCP SDK's Zod validation,
  // but _meta is an official passthrough record that survives parsing.
  const meta = mcpTool._meta || {};
  const domain =
    mcpTool.domain ||
    (typeof meta.domain === "string" ? meta.domain : undefined);
  const labels =
    mcpTool.labels ||
    (Array.isArray(meta.labels) ? (meta.labels as string[]) : undefined);

  return {
    name: `${MCP_PREFIX}${serverName}${MCP_DELIMITER}${mcpTool.name}`,
    description: mcpTool.description || "",
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
    // Metadata for UI display
    _mcpServer: serverName,
    _mcpOriginalName: mcpTool.name,
    domain,
    labels,
  };
}

/**
 * Parse a namespaced MCP tool name back into { serverName, toolName }.
 * Returns null if the name doesn't match the MCP pattern.
 */
function parseMCPToolName(
  fullName: string,
): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith(MCP_PREFIX)) return null;
  const rest = fullName.slice(MCP_PREFIX.length);
  const delimiterIndex = rest.indexOf(MCP_DELIMITER);
  if (delimiterIndex === -1) return null;
  return {
    serverName: rest.slice(0, delimiterIndex),
    toolName: rest.slice(delimiterIndex + MCP_DELIMITER.length),
  };
}

function oauthIdentityOf(config: MCPServerConfig) {
  return { serverId: String(config._id ?? config.name), username: config.username ?? "any" };
}

/**
 * Sort the server's current tool list into approved and quarantined, and
 * publish the result.
 * ported from prism-service src/services/MCPClientService.ts (applyToolList)
 */
function applyToolList(conn: MCPConnection, offered: MCPRawTool[]): void {
  const review = reviewMcpTools(offered, conn.pins);
  const serverName = conn.config.name;
  if (review.pins) {
    conn.pins = review.pins;
    rememberedPins.set(serverName, review.pins);
    void updateMcpServerRecord(conn.config, { toolPins: review.pins });
  }
  const before = JSON.stringify(conn.quarantined);
  conn.offeredTools = offered;
  conn.mcpTools = review.approved;
  conn.tools = review.approved.map((tool) => mcpToolToSchema(serverName, tool));
  conn.quarantined = review.quarantined;
  if (before !== JSON.stringify(conn.quarantined)) {
    void updateMcpServerRecord(conn.config, { quarantinedTools: conn.quarantined });
  }
}

function describeQuarantine(conn: MCPConnection): string {
  if (conn.quarantined.length === 0) return "";
  return ` — QUARANTINED ${conn.quarantined.length}: ${conn.quarantined
    .map((entry) => `${entry.name} (${entry.reason})`)
    .join(", ")}`;
}

/**
 * Create the appropriate transport based on server config.
 */
function createTransport(
  config: MCPServerConfig,
  authProvider?: McpOAuthProvider,
): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
  let rawUrl = config.url || "";
  const isDocker = fs.existsSync("/.dockerenv") || fs.existsSync("/opt/venv/bin/python");
  if (!isDocker) {
    if (rawUrl.includes(":5591")) {
      rawUrl = rawUrl.replace(/:\/\/[^/]+:5591/, "://127.0.0.1:5591");
    }
    if (rawUrl.includes(":7778")) {
      rawUrl = rawUrl.replace(/:\/\/[^/]+:7778/, "://127.0.0.1:7778");
    }
  }

  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });
  }

  if (config.transport === "streamable-http") {
    const url = new URL(rawUrl);
    return new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: config.headers || {},
      },
      ...(authProvider && { authProvider }),
    });
  }

  if (config.transport === "sse") {
    const url = new URL(rawUrl);
    return new SSEClientTransport(url, {
      requestInit: {
        headers: config.headers || {},
      },
      ...(authProvider && { authProvider }),
    });
  }

  throw new Error(`Unsupported MCP transport: ${config.transport}`);
}

// ─── Service ──────────────────────────────────────────────────────────────────

const MCPClientService = {
  /**
   * Connect to an MCP server and discover its tools.
   */
  async connect(config: MCPServerConfig) {
    const { name: serverName } = config;

    // Every `mcp__<name>__` spelling this service's own catalog answers to is
    // taken; a remote server under such a name would shadow it.
    if (RESERVED_SERVER_NAMES.has(serverName)) {
      throw new Error(`"${serverName}" is reserved for this service's own tool catalog`);
    }

    // Disconnect existing connection if any
    if (connections.has(serverName)) {
      await this.disconnect(serverName);
    }

    logger.info(`[MCP] Connecting to "${serverName}" (${config.transport})...`);

    let authProvider: McpOAuthProvider | undefined;
    if (config.auth?.type === "oauth") {
      if (config.transport === "stdio") {
        throw new Error(`MCP server "${serverName}": OAuth needs an HTTP transport`);
      }
      const identity = oauthIdentityOf(config);
      authProvider = new McpOAuthProvider(
        identity,
        await resolveProviderRedirectUrl(identity, config._requestOrigin),
        config.auth.scope ?? null,
      );
    }

    const transport = createTransport(config, authProvider);
    const client: Client = new Client(
      { name: "lazy-agent-mcp-client", version: "1.0.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error, tools) =>
              MCPClientService.handleToolListChanged(serverName, client, error, tools),
          },
        },
      },
    );

    try {
      await client.connect(transport);
    } catch (error: unknown) {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
      // An OAuth server without tokens: the caller opens this URL in a
      // popup, and the callback finishes the connect.
      if (authProvider?.authorizationUrl && error instanceof UnauthorizedError) {
        logger.info(`[MCP] "${serverName}" needs OAuth authorization`);
        throw new McpAuthorizationRequiredError(serverName, authProvider.authorizationUrl);
      }
      logger.error(
        `[MCP] Failed to connect to "${serverName}": ${getErrorMessage(error)}`,
      );
      throw error;
    }

    // Discover tools
    let mcpTools: MCPRawTool[] = [];
    try {
      const result = await client.listTools();
      mcpTools = (result.tools || []) as MCPRawTool[];
    } catch (error: unknown) {
      logger.warn(
        `[MCP] Failed to list tools for "${serverName}": ${getErrorMessage(error)}`,
      );
    }

    // The first connect approves what the server offers (trust on first use);
    // after that a new or changed tool is quarantined until approved.
    const conn: MCPConnection = {
      client,
      transport,
      tools: [],
      mcpTools: [],
      offeredTools: [],
      quarantined: [],
      pins:
        config.toolPins && typeof config.toolPins === "object"
          ? { ...config.toolPins }
          : (rememberedPins.get(serverName) ?? null),
      config,
      status: "connected",
      connectedAt: new Date(),
    };
    connections.set(serverName, conn);
    applyToolList(conn, mcpTools);

    logger.info(
      `[MCP] Connected to "${serverName}" — ${conn.tools.length} tools: ${conn.mcpTools.map((mCPRawTool) => mCPRawTool.name).join(", ")}${describeQuarantine(conn)}`,
    );

    return { tools: conn.tools, serverName, quarantinedTools: conn.quarantined };
  },

  /**
   * Disconnect from an MCP server.

   */
  async disconnect(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch (error: unknown) {
      logger.warn(
        `[MCP] Error closing "${serverName}": ${getErrorMessage(error)}`,
      );
    }

    // For stdio, ensure child process is killed
    if (conn.transport?.close) {
      try {
        await conn.transport.close();
      } catch {
        // Best-effort cleanup
      }
    }

    connections.delete(serverName);
    logger.info(`[MCP] Disconnected from "${serverName}"`);
  },

  /**
   * Reconnect to an MCP server (disconnect then connect).

   */
  async reconnect(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) throw new Error(`Server "${serverName}" is not connected`);
    return this.connect({ ...conn.config, toolPins: conn.pins });
  },

  /**
   * `notifications/tools/list_changed`: the SDK has re-fetched the list.
   * Re-review it against the pins — a new or changed tool is quarantined
   * right here, before the next call can reach it.
   */
  handleToolListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    tools: unknown[] | null,
  ): void {
    const conn = connections.get(serverName);
    // A late notification from a connection that has since been replaced.
    if (!conn || conn.client !== client) return;
    if (error || !tools) {
      logger.warn(
        `[MCP] "${serverName}" announced a tool list change but the refresh failed: ${error ? getErrorMessage(error) : "no tools returned"}`,
      );
      return;
    }
    applyToolList(conn, tools as MCPRawTool[]);
    logger.info(
      `[MCP] "${serverName}" tool list changed — ${conn.tools.length} approved${describeQuarantine(conn)}`,
    );
  },

  /**
   * Approve quarantined tools: pin them at their current definitions. With
   * no names, every quarantined tool the server offers is approved.
   * Null when the server is not connected.
   */
  async approveTools(serverName: string, names: string[] | null) {
    const conn = connections.get(serverName);
    if (!conn) return null;
    const wanted = names ?? conn.quarantined.map((entry) => entry.name);
    const result = approveMcpTools(conn.offeredTools, conn.pins, wanted);
    conn.pins = result.pins;
    rememberedPins.set(serverName, result.pins);
    await updateMcpServerRecord(conn.config, { toolPins: result.pins });
    applyToolList(conn, conn.offeredTools);
    await updateMcpServerRecord(conn.config, { quarantinedTools: conn.quarantined });
    logger.info(
      `[MCP] "${serverName}" tools approved: ${result.approved.join(", ") || "none"}${result.skipped.length ? ` (skipped: ${result.skipped.join(", ")})` : ""}`,
    );
    return {
      approved: result.approved,
      skipped: result.skipped,
      quarantinedTools: conn.quarantined,
      toolCount: conn.tools.length,
    };
  },

  /**
   * Finish an OAuth authorization at the callback: the SDK exchanges the code
   * (with the stored PKCE verifier) and saves the tokens through the
   * provider. The caller then connects as usual.
   */
  async finishOAuth(
    config: MCPServerConfig,
    provider: McpOAuthProvider,
    authorizationCode: string,
  ): Promise<void> {
    const transport = createTransport(config, provider);
    if (!("finishAuth" in transport)) {
      throw new Error(`MCP server "${config.name}": OAuth needs an HTTP transport`);
    }
    try {
      await transport.finishAuth(authorizationCode);
    } finally {
      try {
        await transport.close();
      } catch {
        /* never started */
      }
    }
  },

  /**
   * Call a tool on a connected MCP server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    // Only an approved tool is called; a quarantined one is refused with the
    // reason, so a model holding a stale tool list can't reach a changed tool.
    if (!conn.mcpTools.some((tool) => tool.name === toolName)) {
      const held = conn.quarantined.find((entry) => entry.name === toolName);
      if (held) {
        return {
          error: `MCP tool "${held.name}" on "${serverName}" is quarantined: its definition ${held.reason === "new" ? "appeared" : "changed"} after the server was approved. The owner has to re-approve it before it can run.`,
        };
      }
      return { error: `MCP server "${serverName}" does not offer a tool named "${toolName}"` };
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });

      // MCP returns { content: [{ type: "text", text: "..." }, ...], isError? }
      const content = (result.content || []) as MCPContentBlock[];
      if (result.isError) {
        const errorText =
          content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n") || "MCP tool returned an error";
        return { error: errorText };
      }

      // Flatten content to a usable format
      const textParts = content
        .filter((item) => item.type === "text")
        .map((item) => item.text || "");

      // If there's only one text part, return it directly for cleaner output
      // (many MCP tools return JSON as text). The size cap applies to the
      // result as the model will see it.
      const capTokens = resolveOutputCapTokens(conn.config, toolName);
      if (textParts.length === 1) {
        try {
          const parsed: unknown = JSON.parse(textParts[0]);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return capMcpToolResult(parsed as Record<string, unknown>, capTokens);
          }
          // An array or scalar is returned as it is, unless it is over the cap.
          const capped = capMcpToolResult({ result: textParts[0] }, capTokens);
          return "outputCapped" in capped ? capped : (parsed as Record<string, unknown>);
        } catch {
          /* plain text */
        }
        return capMcpToolResult({ result: textParts[0] }, capTokens);
      }

      return capMcpToolResult({ result: textParts.join("\n") }, capTokens);
    } catch (error: unknown) {
      // Attempt reconnect once on connection errors
      if (
        getErrorMessage(error)?.includes("closed") ||
        getErrorMessage(error)?.includes("transport")
      ) {
        logger.warn(
          `[MCP] Connection lost to "${serverName}", attempting reconnect...`,
        );
        try {
          await this.reconnect(serverName);
          return this.callTool(serverName, toolName, args);
        } catch (reconnectError: unknown) {
          return {
            error: `MCP server "${serverName}" connection lost and reconnect failed: ${getErrorMessage(reconnectError)}`,
          };
        }
      }
      return { error: `MCP tool call failed: ${getErrorMessage(error)}` };
    }
  },

  /**
   * Get all tool schemas from all connected MCP servers.
   */
  getToolSchemas(): MCPToolSchema[] {
    const allSchemas: MCPToolSchema[] = [];
    for (const conn of connections.values()) {
      allSchemas.push(...conn.tools);
    }
    return allSchemas;
  },

  /**
   * Get connection info for all servers.
   */
  getConnectedServers() {
    const servers: {
      name: string;
      status: string;
      toolCount: number;
      tools: { name: string; description?: string }[];
      quarantinedTools: McpQuarantinedTool[];
      transport: string;
      connectedAt: Date;
    }[] = [];
    for (const [name, conn] of connections) {
      servers.push({
        name,
        status: conn.status,
        toolCount: conn.tools.length,
        tools: conn.mcpTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        quarantinedTools: conn.quarantined,
        transport: conn.config.transport,
        connectedAt: conn.connectedAt,
      });
    }
    return servers;
  },

  /**
   * Check if a specific server is connected.


   */
  isConnected(serverName: string): boolean {
    return connections.has(serverName);
  },

  /**
   * Check if a tool name is an MCP tool.


   */
  isMCPTool(toolName: string): boolean {
    return toolName.startsWith(MCP_PREFIX);
  },

  /**
   * Parse an MCP-namespaced tool name.

   */
  parseMCPToolName(fullName: string) {
    return parseMCPToolName(fullName);
  },

  /**
   * List available resources from a connected MCP server.
   * MCP Resources are read-only data sources (files, DB rows, API data)
   * that can be fetched by URI.
   */
  async listResources(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.listResources();
      const resources = (result.resources || []).map((resource) => ({
        uri: resource.uri,
        name: resource.name || resource.uri,
        description: resource.description || null,
        mimeType: resource.mimeType || null,
      }));
      return { resources, serverName, count: resources.length };
    } catch (error: unknown) {
      const extractedErrorMessage = getErrorMessage(error);
      const errorCode =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "number"
          ? error.code
          : undefined;
      // Some servers don't implement resources — that's fine
      if (
        extractedErrorMessage.includes("not supported") ||
        extractedErrorMessage.includes("not implemented") ||
        errorCode === -32601
      ) {
        return {
          resources: [],
          serverName,
          count: 0,
          note: "Server does not support resources",
        };
      }
      return {
        error: `Failed to list resources from "${serverName}": ${extractedErrorMessage}`,
      };
    }
  },

  /**
   * Read a specific resource from a connected MCP server by URI.
   */
  async readResource(serverName: string, uri: string) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.readResource({ uri });
      // MCP returns { contents: [{ uri, mimeType?, text?, blob? }] }
      const contents = (result.contents || []).map((content) => {
        const hasText = "text" in content && typeof content.text === "string";
        return {
          uri: content.uri,
          mimeType: content.mimeType || null,
          text: hasText ? (content as { text: string }).text : null,
          // Don't return raw blob data — too large for LLM context
          hasBlob: "blob" in content && !!content.blob,
        };
      });

      if (contents.length === 1 && contents[0].text) {
        // Single text resource — return directly for cleaner LLM consumption
        return {
          uri: contents[0].uri,
          mimeType: contents[0].mimeType,
          content: contents[0].text,
          serverName,
        };
      }

      return { contents, serverName };
    } catch (error: unknown) {
      return {
        error: `Failed to read resource "${uri}" from "${serverName}": ${getErrorMessage(error)}`,
      };
    }
  },

  /**
   * List a connected server's prompts.
   * ported from prism-service src/services/MCPClientService.ts (listPrompts, per server)
   */
  async listPrompts(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }
    if (!conn.client.getServerCapabilities()?.prompts) {
      return { prompts: [], serverName, count: 0, note: "Server does not support prompts" };
    }
    try {
      const result = await conn.client.listPrompts();
      const prompts = (result.prompts ?? []).map((prompt) => ({
        name: prompt.name,
        title: prompt.title ?? null,
        description: prompt.description ?? null,
        arguments: (prompt.arguments ?? []).map((argument) => ({
          name: argument.name,
          description: argument.description ?? null,
          required: argument.required === true,
        })),
      }));
      return { prompts, serverName, count: prompts.length };
    } catch (error: unknown) {
      return { error: `Failed to list prompts of "${serverName}": ${getErrorMessage(error)}` };
    }
  },

  /**
   * Fill a prompt. Its messages are flattened to text.
   * ported from prism-service src/services/MCPClientService.ts (getPrompt)
   */
  async getPrompt(serverName: string, name: string, args: Record<string, string> = {}) {
    const conn = connections.get(serverName);
    if (!conn) return { error: `MCP server "${serverName}" is not connected` };
    try {
      const result = await conn.client.getPrompt({ name, arguments: args });
      const messages = (result.messages ?? []).map((message) => {
        const content = message.content as {
          type: string;
          text?: string;
          resource?: { uri?: string; text?: string };
          uri?: string;
        };
        const text =
          content.type === "text"
            ? (content.text ?? "")
            : content.type === "resource"
              ? (content.resource?.text ?? `[resource ${content.resource?.uri ?? ""}]`)
              : content.type === "resource_link"
                ? `[resource ${content.uri ?? ""}]`
                : `[${content.type}]`;
        return { role: message.role, text };
      });
      return {
        server: serverName,
        name,
        description: result.description ?? null,
        messages,
        text: messages.map((message) => message.text).join("\n\n"),
      };
    } catch (error: unknown) {
      return { error: `Failed to get prompt "${name}" from "${serverName}": ${getErrorMessage(error)}` };
    }
  },

  /**
   * Authenticate with an MCP server by updating its connection headers/env.
   * Reconnects the server with the new credentials.
   *
   * Supports:
   * - Bearer token auth (most common for HTTP MCP servers)
   * - API key header auth
   * - Environment variable injection (for stdio servers)
   */
  async authenticate(serverName: string, auth: MCPAuthOptions = {}) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    const updatedConfig: MCPServerConfig = { ...conn.config, toolPins: conn.pins };

    // Apply auth to config based on transport type
    if (updatedConfig.transport === "streamable-http") {
      const headers: Record<string, string> = {
        ...(updatedConfig.headers || {}),
      };

      if (auth.token) {
        headers["Authorization"] = `Bearer ${auth.token}`;
      }
      if (auth.apiKey) {
        const headerName = auth.apiKeyHeader || "X-API-Key";
        headers[headerName] = auth.apiKey;
      }
      if (auth.headers) {
        Object.assign(headers, auth.headers);
      }

      updatedConfig.headers = headers;
    } else if (updatedConfig.transport === "stdio") {
      // For stdio, inject auth as env vars
      const env: Record<string, string> = { ...(updatedConfig.env || {}) };

      if (auth.token) {
        env.MCP_AUTH_TOKEN = auth.token;
      }
      if (auth.apiKey) {
        env.MCP_API_KEY = auth.apiKey;
      }
      if (auth.env) {
        Object.assign(env, auth.env);
      }

      updatedConfig.env = env;
    }

    // Reconnect with updated config
    try {
      const result = await this.connect(updatedConfig);
      logger.info(
        `[MCP] Authenticated and reconnected to "${serverName}" — ${result.tools.length} tools`,
      );
      return {
        acknowledged: true,
        serverName,
        toolCount: result.tools.length,
        message: `Successfully authenticated with "${serverName}". ${result.tools.length} tools available.`,
      };
    } catch (error: unknown) {
      return {
        error: `Authentication failed for "${serverName}": ${getErrorMessage(error)}`,
      };
    }
  },

  /**
   * Auto-connect every enabled MCP server in the database (all projects and
   * users: connections are keyed by server name, not by caller).
   */
  async connectAllFromDB(db: Db | null) {
    if (!db) return;

    try {
      const servers = (await db
        .collection(COLLECTIONS.MCP_SERVERS)
        .find({ enabled: true })
        .toArray()) as unknown as MCPServerConfig[];

      if (servers.length === 0) return;

      logger.info(
        `[MCP] Auto-connecting ${servers.length} enabled server(s)...`,
      );

      const results = await Promise.allSettled(
        servers.map((server) => this.connect(server)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "rejected") {
          logger.warn(
            `[MCP] Auto-connect failed for "${servers[i].name}": ${result.reason?.message}`,
          );
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[MCP] Auto-connect DB query failed: ${getErrorMessage(error)}`,
      );
    }
  },

  /**
   * Disconnect all connected servers. Called on shutdown.
   */
  async disconnectAll() {
    const names = [...connections.keys()];
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  },
};

export default MCPClientService;
