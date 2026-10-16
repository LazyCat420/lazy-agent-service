// ported from prism-service src/routes/McpOAuthRoutes.ts (no client-metadata document, no `iss` binding: the 1.29 SDK has neither)
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import MCPClientService, { type MCPServerConfig } from "../services/MCPClientService.ts";
import { markOAuthFailed, resolveOAuthCallback } from "../services/mcp/McpOAuth.ts";
import logger from "../utils/logger.ts";

/**
 * /mcp/oauth — where an MCP authorization server sends the browser back.
 *
 * The callback is a plain browser navigation (no identity headers). The flow
 * is found by its `state` alone, which is unguessable, single-use and
 * short-lived. The page it returns tells the opener (the settings popup) how
 * it went, then closes.
 */
const router = express.Router();

interface CallbackOutcome {
  status: "connected" | "failed";
  serverId?: string;
  serverName?: string;
  message: string;
}

function callbackPage(res: Response, statusCode: number, outcome: CallbackOutcome) {
  const payload = JSON.stringify({ type: "lazy-agent-mcp-oauth", ...outcome }).replace(/</g, "\\u003c");
  const heading = outcome.status === "connected" ? "Connected" : "Authorization failed";
  const text = outcome.message.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  res
    .status(statusCode)
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>` +
        `<style>body{font:15px system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem}</style></head>` +
        `<body><h1>${heading}</h1><p>${text}</p><p>You can close this window.</p>` +
        `<script>try{window.opener&&window.opener.postMessage(${payload},"*")}catch(e){}setTimeout(function(){window.close()},1200)</script>` +
        `</body></html>`,
    );
}

router.get(
  "/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") params.set(key, value);
    }

    const flow = await resolveOAuthCallback(params.get("state"));
    if (!flow) {
      return callbackPage(res, 400, {
        status: "failed",
        message: "This authorization link is unknown or has expired. Start again from the MCP server's settings.",
      });
    }
    const { identity, provider } = flow;
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    const server = database && ObjectId.isValid(identity.serverId)
      ? await database
          .collection(COLLECTIONS.MCP_SERVERS)
          .findOne({ _id: new ObjectId(identity.serverId) })
      : null;
    if (!server) {
      await markOAuthFailed(identity, "The MCP server was deleted during authorization");
      return callbackPage(res, 404, { status: "failed", serverId: identity.serverId, message: "That MCP server no longer exists." });
    }
    const config = server as unknown as MCPServerConfig;

    // The user refused, or the server failed. Its `error_description` is
    // not shown: a callback is attacker-reachable.
    const code = params.get("code");
    if (params.get("error") || !code) {
      await markOAuthFailed(identity, `authorization server returned "${params.get("error") ?? "no code"}"`);
      return callbackPage(res, 400, {
        status: "failed",
        serverId: identity.serverId,
        serverName: config.name,
        message: "Access was not granted.",
      });
    }

    try {
      await MCPClientService.finishOAuth(config, provider, code);
      await MCPClientService.connect(config);
      logger.info(`[MCP OAuth] "${config.name}" authorized and connected`);
      return callbackPage(res, 200, {
        status: "connected",
        serverId: identity.serverId,
        serverName: config.name,
        message: `Connected to ${config.name}.`,
      });
    } catch (error: unknown) {
      await markOAuthFailed(identity, error);
      return callbackPage(res, 400, {
        status: "failed",
        serverId: identity.serverId,
        serverName: config.name,
        message: "The authorization could not be completed. Try connecting again.",
      });
    }
  }),
);

export default router;
