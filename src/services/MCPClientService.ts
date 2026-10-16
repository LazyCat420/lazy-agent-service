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
  [key: string]: unknown;
}

interface MCPConnection {
  client: Client;
  transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport;
  tools: MCPToolSchema[];
  mcpTools: MCPRawTool[];
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

/**
 * Create the appropriate transport based on server config.
 */
function createTransport(
  config: MCPServerConfig,
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
    });
  }

  if (config.transport === "sse") {
    const url = new URL(rawUrl);
    return new SSEClientTransport(url, {
      requestInit: {
        headers: config.headers || {},
      },
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

    const transport = createTransport(config);
    const client = new Client(
      { name: "lazy-agent-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (error: unknown) {
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

    // Convert to our schema format
    const schemas = mcpTools.map((tool) => mcpToolToSchema(serverName, tool));

    connections.set(serverName, {
      client,
      transport,
      tools: schemas,
      mcpTools,
      config,
      status: "connected",
      connectedAt: new Date(),
    });

    logger.info(
      `[MCP] Connected to "${serverName}" — ${schemas.length} tools: ${mcpTools.map((mCPRawTool) => mCPRawTool.name).join(", ")}`,
    );

    return { tools: schemas, serverName };
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
    return this.connect(conn.config);
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
      if (textParts.length === 1) {
        // Try to parse as JSON (many MCP tools return JSON as text)
        try {
          return JSON.parse(textParts[0]);
        } catch {
          return { result: textParts[0] };
        }
      }

      return { result: textParts.join("\n") };
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

    const updatedConfig: MCPServerConfig = { ...conn.config };

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
