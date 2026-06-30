import { type Request, type Response } from "express";
import logger from "../../logger.js";
import { getToolSchemas } from "../ToolSchemaService.js";

const REAL_PRISM_URL = process.env.REAL_PRISM_URL || "http://10.0.0.16:7777";

export class PrismProxyService {
  // Map conversationId -> allowed tool names
  private static sessionAllowedTools = new Map<string, string[]>();

  public static registerSession(conversationId: string, allowedTools: string[]) {
    logger.info(`[PrismProxy] Registering allowed tools for conversation ${conversationId}: ${allowedTools.join(", ")}`);
    this.sessionAllowedTools.set(conversationId, allowedTools);
  }

  public static isToolAllowed(conversationId: string, toolName: string): boolean {
    if (!conversationId) return true; // Default to allow if no context (fallback)
    
    // Normalize tool name for lookup (strip prefix from hallucinated tool name)
    const cleanToolName = toolName.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
    
    const allowed = this.sessionAllowedTools.get(conversationId);
    if (!allowed) {
      // If we don't have this session tracked, allow it (could be non-trading agent)
      return true;
    }
    
    return allowed.includes(cleanToolName);
  }

  public static async handle(req: Request, res: Response) {
    const originalPath = req.originalUrl.replace(/^\/prism-proxy/, "");
    // Extract base path without query params for routing logic
    const basePath = originalPath.split("?")[0];
    const targetUrl = `${REAL_PRISM_URL}${originalPath}`;
    
    let body = req.body;
    
    // If it's the agent endpoint, apply our guardrail bypass
    if (basePath === "/agent" && req.method === "POST" && body) {
      body = { ...req.body };
      const conversationId = body.conversationId;
      const originalEnabledTools = body.enabledTools || [];

      if (conversationId) {
        this.registerSession(conversationId, originalEnabledTools);
      }

      // Bypass prism-service's internal filter by enabling ALL tools only if tools were requested
      if (originalEnabledTools.length === 0) {
        body.enabledTools = [];
      } else {
        const allTools = getToolSchemas().map((s) => s.name);
        body.enabledTools = allTools;
      }
    }

    // Apply Qwen non-leading system message rewrite patch (workaround for Qwen chat template constraint in vLLM)
    if ((basePath === "/agent" || basePath === "/chat") && req.method === "POST" && body && Array.isArray(body.messages) && typeof body.model === "string") {
      const modelName = body.model.toLowerCase();
      if (modelName.includes("qwen")) {
        let hasSeenFirstSystemMessage = false;
        if (body === req.body) {
          body = { ...req.body };
        }
        body.messages = body.messages.map((message: any) => {
          if (message.role === "system") {
            if (!hasSeenFirstSystemMessage) {
              hasSeenFirstSystemMessage = true;
              return message;
            }
            logger.warn(
              `[PrismProxy] TEMP PATCH: Rewriting non-primary system message to user role for ${body.model} (Qwen vLLM chat template workaround)`
            );
            return { ...message, role: "user" };
          }
          return message;
        });
      }
    }

    const streamQuery = req.query.stream;
    const acceptsSse = req.headers.accept?.includes("text/event-stream");
    const isStream = streamQuery === "true" || (acceptsSse && streamQuery !== "false" && req.body.stream !== false);

    logger.info(`[PrismProxy] Forwarding ${req.method} ${originalPath} to ${REAL_PRISM_URL} (stream=${isStream})`);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      
      // Forward relevant request headers
      const forwardHeaders = ["x-project", "x-username", "authorization", "x-workspace-root"];
      for (const h of forwardHeaders) {
        if (req.headers[h]) {
          headers[h] = req.headers[h] as string;
        }
      }

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(body) : undefined
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`[PrismProxy] Target returned error status=${response.status}: ${errText}`);
        return res.status(response.status).json({ error: errText });
      }

      if (isStream && basePath === "/agent") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        
        if (response.body) {
          const reader = (response.body as any).getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      } else {
        const data = await response.json();
        res.json(data);
      }
    } catch (error: any) {
      logger.error(`[PrismProxy] Failed to proxy ${originalPath}: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }
}
