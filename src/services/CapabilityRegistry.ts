import fs from "node:fs";
import path from "node:path";
import logger from "../utils/logger.ts";
import type { ToolEffect } from "../types/run.ts";

export interface CapabilityParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface CapabilityDefinition {
  id: string;
  name: string;
  owner: string;
  version: string;
  effect: ToolEffect;
  timeout_ms: number;
  requires_audit: boolean;
  description: string;
  parameters: CapabilityParameterSchema;
  returns?: Record<string, unknown>;
}

export class CapabilityRegistry {
  private static capabilities: Map<string, CapabilityDefinition> = new Map();
  private static initialized = false;

  private static readonly BUILTIN_CAPABILITIES: CapabilityDefinition[] = [
    {
      id: "global.web.search",
      name: "global.web.search",
      owner: "lazy-agent-service",
      version: "1.1.0",
      effect: "read",
      timeout_ms: 15000,
      requires_audit: false,
      description: "App-neutral web retrieval capability returning relevant search results with citations and source metadata.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "The search query string." },
          max_results: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
      },
    },
    {
      id: "global.web.read_page",
      name: "global.web.read_page",
      owner: "lazy-agent-service",
      version: "1.1.0",
      effect: "read",
      timeout_ms: 20000,
      requires_audit: false,
      description: "App-neutral page extraction capability converting public webpage HTML into clean, bounded markdown text.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri", description: "The public HTTP/HTTPS URL to retrieve." },
          max_chars: { type: "integer", minimum: 500, maximum: 50000, default: 8000 },
        },
      },
    },
    {
      id: "global.data.transform",
      name: "global.data.transform",
      owner: "lazy-agent-service",
      version: "1.1.0",
      effect: "read",
      timeout_ms: 5000,
      requires_audit: false,
      description: "Pure side-effect-free in-memory JSON data structure remapping, field picking, and numeric aggregations.",
      parameters: {
        type: "object",
        required: ["input", "operations"],
        properties: {
          input: { description: "Source JSON object or array to transform." },
          operations: {
            type: "array",
            items: {
              type: "object",
              required: ["op"],
              properties: {
                op: { type: "string", enum: ["pick", "omit", "rename", "aggregate"] },
                fields: { type: "array", items: { type: "string" } },
                mapping: { type: "object" },
                aggregate_key: { type: "string" },
                aggregate_type: { type: "string", enum: ["sum", "avg", "min", "max", "count"] },
              },
            },
          },
        },
      },
    },
    {
      id: "global.data.sort",
      name: "global.data.sort",
      owner: "lazy-agent-service",
      version: "1.1.0",
      effect: "read",
      timeout_ms: 5000,
      requires_audit: false,
      description: "Pure side-effect-free in-memory sorting of object arrays by key and direction.",
      parameters: {
        type: "object",
        required: ["items", "key"],
        properties: {
          items: { type: "array", items: { type: "object" } },
          key: { type: "string", description: "Field key on objects to sort by." },
          direction: { type: "string", enum: ["asc", "desc"], default: "asc" },
        },
      },
    },
    {
      id: "global.data.filter",
      name: "global.data.filter",
      owner: "lazy-agent-service",
      version: "1.1.0",
      effect: "read",
      timeout_ms: 5000,
      requires_audit: false,
      description: "Pure side-effect-free in-memory filtering of object arrays against comparison criteria.",
      parameters: {
        type: "object",
        required: ["items", "predicate"],
        properties: {
          items: { type: "array", items: { type: "object" } },
          predicate: {
            type: "object",
            required: ["field", "op", "value"],
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"] },
              value: {},
            },
          },
        },
      },
    },
    {
      id: "global.data.extract",
      name: "global.data.extract",
      owner: "lazy-agent-service",
      version: "1.1.0",
      effect: "read",
      timeout_ms: 5000,
      requires_audit: false,
      description: "Pure side-effect-free regex or keyword structured entity extraction from text.",
      parameters: {
        type: "object",
        required: ["text", "patterns"],
        properties: {
          text: { type: "string" },
          patterns: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Map of entity name to regular expression pattern.",
          },
        },
      },
    },
  ];

  static init(): void {
    if (this.initialized) return;
    for (const cap of this.BUILTIN_CAPABILITIES) {
      this.capabilities.set(cap.id, cap);
    }
    this.initialized = true;
  }

  static registerCapability(def: CapabilityDefinition): void {
    this.init();
    if (!def.id || !def.name || !def.effect) {
      throw new Error("Capability definition must have id, name, and effect");
    }
    this.capabilities.set(def.id, def);
  }

  static getCapability(id: string): CapabilityDefinition | undefined {
    this.init();
    return this.capabilities.get(id);
  }

  static hasCapability(id: string): boolean {
    this.init();
    return this.capabilities.has(id);
  }

  static listCapabilities(): CapabilityDefinition[] {
    this.init();
    return Array.from(this.capabilities.values());
  }

  /**
   * Validate that all tools whitelisted in a profile are either:
   * 1. A registered global capability (starts with 'global.')
   * 2. A valid namespaced application tool (e.g. 'html_notes.notes.create', 'trading.positions.list')
   * 3. A legacy MCP prefix tool (e.g. 'mcp__lazy-tool-service__news_search') for transitional compatibility
   */
  static validateProfileCapabilities(whitelist: string[]): {
    valid: boolean;
    unauthorized: string[];
  } {
    this.init();
    const unauthorized: string[] = [];

    for (const toolId of whitelist) {
      if (toolId.startsWith("global.")) {
        if (!this.capabilities.has(toolId)) {
          unauthorized.push(toolId);
        }
      } else if (
        // Allow app-namespaced identifiers like 'html_notes.canvas.upsert_widget'
        /^[a-z0-9_-]+\.[a-z0-9_.]+$/.test(toolId) ||
        // Allow legacy MCP identifiers
        /^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(toolId)
      ) {
        // Valid application or legacy tool identifier
      } else {
        // Malformed or unknown tool identifier pattern
        unauthorized.push(toolId);
      }
    }

    return {
      valid: unauthorized.length === 0,
      unauthorized,
    };
  }

  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
    this.init();
  }
}

CapabilityRegistry.init();
