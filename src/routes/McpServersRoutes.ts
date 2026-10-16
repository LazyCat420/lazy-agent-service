// ported from prism-service src/routes/McpServersRoutes.ts (restored from lazy-agent-service 9113901^ and brought up to prism's id validation, scoping and name-clash rules; OAuth/prompts/resources/tool-approval endpoints not ported)
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId, type Db } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import MCPClientService from "../services/MCPClientService.ts";
import type { MCPServerConfig } from "../services/MCPClientService.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { PostMcpServerSchema, PutMcpServerSchema } from "../types/index.ts";

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
  createdAt: Date;
  updatedAt: Date;
}

/** Whether `id` parses as the ObjectId it spells (a bad id is a 404, not a 500). */
function isObjectId(id: string): boolean {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
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

      const result = await MCPClientService.connect(
        server as unknown as MCPServerConfig,
      );
      res.json({
        success: true,
        serverName: result.serverName,
        toolCount: result.tools.length,
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      });
    } catch (error: unknown) {
      const serverId = req.params.id as string;
      const errorText = errorMessage(error);
      logger.error(`MCP connect failed for ${serverId}: ${errorText}`);
      res
        .status(502)
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

export default router;
