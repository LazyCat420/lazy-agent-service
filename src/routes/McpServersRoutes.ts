// ported from prism-service src/routes/McpServersRoutes.ts (restored from lazy-agent-service 9113901^ and brought up to prism's id validation, scoping and name-clash rules; plus prism's /oauth, /prompts, /resources and /tools/approve endpoints, per server)
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId, type Db } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import MCPClientService, {
  McpStdioRefusedError,
  stdioRefusalReason,
} from "../services/MCPClientService.ts";
import type { MCPServerConfig } from "../services/MCPClientService.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import {
  ApproveMcpToolsSchema,
  GetMcpPromptSchema,
  PostMcpServerSchema,
  PutMcpServerSchema,
  ReadMcpResourceSchema,
} from "../types/index.ts";
import {
  McpAuthorizationRequiredError,
  forgetMcpOAuth,
  getMcpOAuthStatus,
} from "../services/mcp/McpOAuth.ts";
import { McpOAuthKeyMissingError } from "../services/mcp/McpSecretBox.ts";
import type { McpToolPins } from "../services/mcp/McpToolFingerprint.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.MCP_SERVERS;

interface McpServerDocument {
  _id: ObjectId;
  project: string;
  username: string;
  name: string;
  displayName: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  outputCapTokens?: number | null;
  toolOutputCapTokens?: Record<string, number>;
  auth?: { type: "oauth"; scope?: string | null } | null;
  toolPins?: McpToolPins;
  quarantinedTools?: Array<{ name: string; reason: string; hash: string; description: string }>;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether `id` parses as the ObjectId it spells (a bad id is a 404, not a 500). */
function isObjectId(id: string): boolean {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
}

/** The origin the request came in on — the OAuth redirect base when no public URL is configured. */
function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function scopeOf(req: Request) {
  return { project: req.project || "any", username: req.username || "any" };
}

/** A server name namespaces its tools, so it must be unique within a scope. */
async function findNameClash(
  db: Db,
  req: Request,
  name: string,
  excludeId?: ObjectId,
): Promise<McpServerDocument | null> {
  return db.collection<McpServerDocument>(COLLECTION).findOne({
    name,
    ...scopeOf(req),
    ...(excludeId && { _id: { $ne: excludeId } }),
  });
}

function nameClashResponse(res: Response, name: string) {
  return res.status(409).json({
    error: `An MCP server named "${name}" already exists. Server names namespace their tools, so they must be unique.`,
  });
}

const NOT_FOUND = { error: "MCP server not found" };

/** 403 for a row that would spawn a non-allowlisted local command (see MCPClientService). */
function stdioRefusedResponse(res: Response, name: string, reason: string) {
  logger.warn(`MCP server "${name}" refused: ${reason}`);
  return res.status(403).json({
    error: `MCP server "${name}": stdio refused — ${reason}. Use an "sse" or "streamable-http" server instead.`,
  });
}

interface ConnectedServerInfo {
  name: string;
  status: string;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  transport: string;
  connectedAt: Date;
}

/**
 * GET /mcp-servers
 * List all MCP server configs + live connection status.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project, username } = scopeOf(req);
      const { db } = req;

      const servers = await db
        .collection<McpServerDocument>(COLLECTION)
        .find({ project, username })
        .sort({ createdAt: -1 })
        .toArray();

      // Enrich with live connection status
      const connectedServers =
        MCPClientService.getConnectedServers() as ConnectedServerInfo[];
      const connectedMap = new Map<string, ConnectedServerInfo>(
        connectedServers.map((server) => [server.name, server]),
      );

      const enriched = servers.map((server) => {
        const conn = connectedMap.get(server.name);
        return {
          ...server,
          id: server._id.toString(),
          connected: !!conn,
          toolCount: conn?.toolCount || 0,
          tools: conn?.tools || [],
          connectedAt: conn?.connectedAt || null,
        };
      });

      res.json(enriched);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /mcp-servers
 * Add a new MCP server config.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project, username } = scopeOf(req);
      const { db } = req;

      const parsed = PostMcpServerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }
      const refusal = stdioRefusalReason(parsed.data);
      if (refusal) {
        return stdioRefusedResponse(res, parsed.data.name, refusal);
      }
      if (await findNameClash(db, req, parsed.data.name)) {
        return nameClashResponse(res, parsed.data.name);
      }

      const {
        name,
        displayName,
        transport,
        command,
        args,
        env,
        url,
        headers,
        enabled,
        outputCapTokens,
        toolOutputCapTokens,
        auth,
      } = parsed.data;

      const document = {
        project,
        username,
        name,
        displayName: displayName || name,
        transport: transport as "stdio" | "sse" | "streamable-http",
        command,
        args,
        env,
        url,
        headers,
        enabled,
        ...(outputCapTokens !== undefined && { outputCapTokens }),
        ...(toolOutputCapTokens !== undefined && { toolOutputCapTokens }),
        ...(auth !== undefined && { auth }),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db.collection(COLLECTION).insertOne(document);

      logger.info(`MCP server added: ${document.name} (${result.insertedId})`);
      res.status(201).json({ ...document, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /mcp-servers/:id
 * Update an MCP server config.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json(NOT_FOUND);
      }

      const parsed = PutMcpServerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      if (
        parsed.data.name &&
        (await findNameClash(db, req, parsed.data.name, new ObjectId(serverId)))
      ) {
        return nameClashResponse(res, parsed.data.name);
      }

      // PUT is partial: judge the row as it would be stored, so a command-only
      // edit, a switch to stdio, or re-enabling a stdio row is caught too.
      const existing = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({ _id: new ObjectId(serverId), ...scopeOf(req) });
      if (!existing) {
        return res.status(404).json(NOT_FOUND);
      }
      const effective = {
        transport: parsed.data.transport ?? existing.transport,
        command: parsed.data.command ?? existing.command,
        env: parsed.data.env ?? existing.env,
      };
      // Turning a refused row off (and nothing else that could launch it) stays allowed.
      const onlyDisables =
        parsed.data.enabled === false &&
        parsed.data.transport === undefined &&
        parsed.data.command === undefined &&
        parsed.data.args === undefined &&
        parsed.data.env === undefined;
      const refusal = stdioRefusalReason(effective);
      if (refusal && !onlyDisables) {
        return stdioRefusedResponse(res, parsed.data.name ?? existing.name, refusal);
      }

      const updates: Record<string, unknown> = {
        ...parsed.data,
        updatedAt: new Date(),
      };

      // Filter out undefined values from updates to only update provided fields
      Object.keys(updates).forEach((key) => {
        if (updates[key] === undefined) {
          delete updates[key];
        }
      });

      const result = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOneAndUpdate(
          { _id: new ObjectId(serverId), ...scopeOf(req) },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json(NOT_FOUND);
      }

      logger.info(`MCP server updated: ${result.name} (${serverId})`);
      res.json({ ...result, id: result._id.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /mcp-servers/:id
 * Delete an MCP server config (disconnects if connected).
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json(NOT_FOUND);
      }

      const result = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOneAndDelete({ _id: new ObjectId(serverId), ...scopeOf(req) });

      if (!result) {
        return res.status(404).json(NOT_FOUND);
      }

      // Disconnect if connected
      if (MCPClientService.isConnected(result.name)) {
        await MCPClientService.disconnect(result.name);
      }

      logger.info(`MCP server deleted: ${result.name} (${serverId})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /mcp-servers/:id/connect
 * Connect to an MCP server.
 */
router.post(
  "/:id/connect",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json(NOT_FOUND);
      }

      const server = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({ _id: new ObjectId(serverId), ...scopeOf(req) });

      if (!server) {
        return res.status(404).json(NOT_FOUND);
      }

      const result = await MCPClientService.connect({
        ...(server as unknown as MCPServerConfig),
        _requestOrigin: requestOrigin(req),
      });
      res.json({
        success: true,
        serverName: result.serverName,
        toolCount: result.tools.length,
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        quarantinedTools: result.quarantinedTools,
      });
    } catch (error: unknown) {
      // An OAuth server without tokens: the client opens this URL in a
      // popup, and the callback finishes the connect.
      // ported from prism-service src/routes/McpServersRoutes.ts
      if (error instanceof McpAuthorizationRequiredError) {
        return res.json({
          success: false,
          authorizationRequired: true,
          authorizationUrl: error.authorizationUrl,
        });
      }
      if (error instanceof McpStdioRefusedError) {
        return res.status(403).json({ error: error.message });
      }
      const serverId = req.params.id as string;
      const errorText = errorMessage(error);
      logger.error(`MCP connect failed for ${serverId}: ${errorText}`);
      res
        .status(error instanceof McpOAuthKeyMissingError ? 503 : 502)
        .json({ error: `MCP server connection failed: ${errorText}` });
    }
  }),
);

/**
 * POST /mcp-servers/:id/disconnect
 * Disconnect from an MCP server.
 */
router.post(
  "/:id/disconnect",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json(NOT_FOUND);
      }

      const server = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({ _id: new ObjectId(serverId), ...scopeOf(req) });

      if (!server) {
        return res.status(404).json(NOT_FOUND);
      }

      await MCPClientService.disconnect(server.name);
      res.json({ success: true });
    } catch (error: unknown) {
      _next(error);
    }
  }),
);

/**
 * Look up the scoped server a `/:id/...` route addresses; answers 404 itself
 * (bad id, another scope's id) and returns null.
 */
async function findServer(req: Request, res: Response): Promise<McpServerDocument | null> {
  const serverId = req.params.id as string;
  const server = isObjectId(serverId)
    ? await req.db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({ _id: new ObjectId(serverId), ...scopeOf(req) })
    : null;
  if (!server) res.status(404).json(NOT_FOUND);
  return server;
}

const oauthIdentity = (server: McpServerDocument) => ({
  serverId: String(server._id),
  username: server.username,
});

/**
 * GET /mcp-servers/:id/oauth — the server's authorization state (never a token).
 * DELETE /mcp-servers/:id/oauth — forget its tokens and registration, and disconnect.
 * ported from prism-service src/routes/McpServersRoutes.ts
 */
router.get(
  "/:id/oauth",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      res.json({
        ...(await getMcpOAuthStatus(oauthIdentity(server))),
        connected: MCPClientService.isConnected(server.name),
      });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.delete(
  "/:id/oauth",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      await MCPClientService.disconnect(server.name);
      await forgetMcpOAuth(oauthIdentity(server));
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * GET /mcp-servers/:id/prompts — the connected server's prompts.
 * POST /mcp-servers/:id/prompts/get { name, arguments } — fill one.
 * A server that is not connected is a 409; an MCP-side failure is a 502.
 */
router.get(
  "/:id/prompts",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      const result = await MCPClientService.listPrompts(server.name);
      if ("error" in result) {
        return res.status(MCPClientService.isConnected(server.name) ? 502 : 409).json(result);
      }
      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.post(
  "/:id/prompts/get",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      const parsed = GetMcpPromptSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
      const result = await MCPClientService.getPrompt(server.name, parsed.data.name, parsed.data.arguments);
      if ("error" in result) {
        return res.status(MCPClientService.isConnected(server.name) ? 502 : 409).json(result);
      }
      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * GET /mcp-servers/:id/resources — the connected server's resources.
 * POST /mcp-servers/:id/resources/read { uri } — read one.
 */
router.get(
  "/:id/resources",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      const result = await MCPClientService.listResources(server.name);
      if ("error" in result) {
        return res.status(MCPClientService.isConnected(server.name) ? 502 : 409).json(result);
      }
      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.post(
  "/:id/resources/read",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      const parsed = ReadMcpResourceSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
      const result = await MCPClientService.readResource(server.name, parsed.data.uri);
      if ("error" in result) {
        return res.status(MCPClientService.isConnected(server.name) ? 502 : 409).json(result);
      }
      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /mcp-servers/:id/tools/approve   { tools?: string[] }
 * Re-approve quarantined tools at their current definitions (all of them
 * when `tools` is omitted). A tool that is new or changed since the server
 * was approved is hidden from the model and refused if called until then.
 * ported from prism-service src/routes/McpServersRoutes.ts (tools/approve)
 */
router.post(
  "/:id/tools/approve",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = await findServer(req, res);
      if (!server) return;
      const parsed = ApproveMcpToolsSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
      const names = parsed.data.tools ?? null;

      const live = await MCPClientService.approveTools(server.name, names);
      if (live) {
        return res.json({ success: true, connected: true, ...live });
      }

      // Not connected: approve what the last connection recorded. The pin is
      // the fingerprint the owner was shown, so a server that has changed
      // again since is quarantined again on its next connect.
      const stored = server.quarantinedTools ?? [];
      const wanted = new Set(names ?? stored.map((entry) => entry.name));
      const pins: McpToolPins = { ...(server.toolPins ?? {}) };
      const approved: string[] = [];
      const approvedAt = new Date().toISOString();
      for (const entry of stored) {
        if (!wanted.has(entry.name) || entry.reason === "duplicate") continue;
        pins[entry.name] = { hash: entry.hash, approvedAt };
        approved.push(entry.name);
      }
      const remaining = stored.filter((entry) => !approved.includes(entry.name));
      await req.db
        .collection<McpServerDocument>(COLLECTION)
        .updateOne({ _id: server._id }, { $set: { toolPins: pins, quarantinedTools: remaining } });
      res.json({
        success: true,
        connected: false,
        approved,
        skipped: [...wanted].filter((name) => !approved.includes(name)),
        quarantinedTools: remaining,
      });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
