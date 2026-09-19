import fs from "node:fs";
import path from "node:path";
import logger from "../utils/logger.ts";
import type { ToolEffect, ToolExecution } from "../types/run.ts";

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
  execution: ToolExecution;
  effect: ToolEffect;
  timeout_ms: number;
  retryable: boolean;
  rate_limit_class: string;
  supports_evidence: boolean;
  requires_confirmation: boolean;
  requires_user_scope: boolean;
  requires_audit: boolean;
  description: string;
  input_schema_ref?: string;
  output_schema_ref?: string;
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
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 60000,
      retryable: true,
      rate_limit_class: "standard_search",
      supports_evidence: true,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "App-neutral web retrieval capability returning relevant search results with citations and source metadata.",
      input_schema_ref: "schemas/global.web.search.input.json",
      output_schema_ref: "schemas/global.web.search.output.json",
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
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 30000,
      retryable: true,
      rate_limit_class: "web_scrape",
      supports_evidence: true,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "App-neutral page extraction capability converting public webpage HTML into clean, bounded markdown text.",
      input_schema_ref: "schemas/global.web.read_page.input.json",
      output_schema_ref: "schemas/global.web.read_page.output.json",
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
      id: "global.web.fetch_metadata",
      name: "global.web.fetch_metadata",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 15000,
      retryable: true,
      rate_limit_class: "web_scrape",
      supports_evidence: true,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Extract title, description, canonical URL, favicon, and image metadata from a webpage.",
      input_schema_ref: "schemas/global.web.fetch_metadata.input.json",
      output_schema_ref: "schemas/global.web.fetch_metadata.output.json",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
        },
      },
    },
    {
      id: "global.data.transform",
      name: "global.data.transform",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 5000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Pure side-effect-free in-memory JSON data structure remapping, field picking, and numeric aggregations.",
      input_schema_ref: "schemas/global.data.transform.input.json",
      output_schema_ref: "schemas/global.data.transform.output.json",
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
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 5000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Pure side-effect-free in-memory sorting of object arrays by key and direction.",
      input_schema_ref: "schemas/global.data.sort.input.json",
      output_schema_ref: "schemas/global.data.sort.output.json",
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
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 5000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Pure side-effect-free in-memory filtering of object arrays against comparison criteria.",
      input_schema_ref: "schemas/global.data.filter.input.json",
      output_schema_ref: "schemas/global.data.filter.output.json",
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
      id: "global.data.group",
      name: "global.data.group",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 5000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Pure side-effect-free in-memory grouping and aggregation of object arrays by key.",
      input_schema_ref: "schemas/global.data.group.input.json",
      output_schema_ref: "schemas/global.data.group.output.json",
      parameters: {
        type: "object",
        required: ["items", "group_by"],
        properties: {
          items: { type: "array", items: { type: "object" } },
          group_by: { type: "string" },
        },
      },
    },
    {
      id: "global.data.extract",
      name: "global.data.extract",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 5000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Pure side-effect-free regex or keyword structured entity extraction from text.",
      input_schema_ref: "schemas/global.data.extract.input.json",
      output_schema_ref: "schemas/global.data.extract.output.json",
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
    {
      id: "global.data.classify",
      name: "global.data.classify",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 5000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Pure deterministic classification, tagging, and rule-based categorization.",
      input_schema_ref: "schemas/global.data.classify.input.json",
      output_schema_ref: "schemas/global.data.classify.output.json",
      parameters: {
        type: "object",
        required: ["item", "rules"],
        properties: {
          item: { type: "object" },
          rules: {
            type: "array",
            items: {
              type: "object",
              required: ["field", "match", "category"],
              properties: {
                field: { type: "string" },
                match: { type: "string" },
                category: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      id: "global.document.chunk",
      name: "global.document.chunk",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 10000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "App-neutral text segmentation and chunking with configurable overlap.",
      input_schema_ref: "schemas/global.document.chunk.input.json",
      output_schema_ref: "schemas/global.document.chunk.output.json",
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          chunk_size: { type: "integer", default: 1000 },
          overlap: { type: "integer", default: 100 },
        },
      },
    },
    {
      id: "global.document.summarize",
      name: "global.document.summarize",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 30000,
      retryable: true,
      rate_limit_class: "llm_inference",
      supports_evidence: true,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Document summarization adhering to bounded input and verifiable evidence policy.",
      input_schema_ref: "schemas/global.document.summarize.input.json",
      output_schema_ref: "schemas/global.document.summarize.output.json",
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          max_length: { "type": "integer", default: 500 },
        },
      },
    },
    {
      id: "global.time.now",
      name: "global.time.now",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 2000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Canonical UTC and localized timestamp retrieval and timezone conversion.",
      input_schema_ref: "schemas/global.time.now.input.json",
      output_schema_ref: "schemas/global.time.now.output.json",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", default: "UTC" },
        },
      },
    },
    {
      id: "global.math.calculate",
      name: "global.math.calculate",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 2000,
      retryable: false,
      rate_limit_class: "cpu_in_memory",
      supports_evidence: false,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Deterministic calculation and unit conversion.",
      input_schema_ref: "schemas/global.math.calculate.input.json",
      output_schema_ref: "schemas/global.math.calculate.output.json",
      parameters: {
        type: "object",
        required: ["expression"],
        properties: {
          expression: { type: "string" },
        },
      },
    },
    {
      id: "global.media.transcribe",
      name: "global.media.transcribe",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 60000,
      retryable: true,
      rate_limit_class: "media_processing",
      supports_evidence: true,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Speech-to-text audio transcription capability.",
      input_schema_ref: "schemas/global.media.transcribe.input.json",
      output_schema_ref: "schemas/global.media.transcribe.output.json",
      parameters: {
        type: "object",
        required: ["audio_url"],
        properties: {
          audio_url: { type: "string" },
        },
      },
    },
    {
      id: "global.media.describe_image",
      name: "global.media.describe_image",
      owner: "lazy-agent-service",
      version: "1.2.0",
      execution: "shared",
      effect: "read",
      timeout_ms: 30000,
      retryable: true,
      rate_limit_class: "vision_inference",
      supports_evidence: true,
      requires_confirmation: false,
      requires_user_scope: false,
      requires_audit: false,
      description: "Visual feature extraction and natural language image description.",
      input_schema_ref: "schemas/global.media.describe_image.input.json",
      output_schema_ref: "schemas/global.media.describe_image.output.json",
      parameters: {
        type: "object",
        required: ["image_url"],
        properties: {
          image_url: { type: "string" },
          prompt: { type: "string" },
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
    if (
      !def.id ||
      !def.name ||
      !def.version ||
      !def.owner ||
      !def.execution ||
      !def.effect ||
      typeof def.timeout_ms !== "number" ||
      typeof def.supports_evidence !== "boolean" ||
      typeof def.requires_confirmation !== "boolean"
    ) {
      throw new Error(
        "Capability definition must define id, name, version, owner, execution, effect, timeout_ms, supports_evidence, and requires_confirmation",
      );
    }
    this.capabilities.set(def.id, def);
  }

  static getCapability(id: string): CapabilityDefinition | undefined {
    this.init();
    // Support versioned id lookups like global.web.search@1.2 or unversioned
    const cleanId = id.includes("@") ? id.split("@")[0] : id;
    return this.capabilities.get(cleanId);
  }

  static hasCapability(id: string): boolean {
    this.init();
    const cleanId = id.includes("@") ? id.split("@")[0] : id;
    return this.capabilities.has(cleanId);
  }

  static listCapabilities(): CapabilityDefinition[] {
    this.init();
    return Array.from(this.capabilities.values());
  }

  /**
   * Validate that all tools whitelisted in a profile are either:
   * 1. A registered global capability (starts with 'global.') with compatible version
   * 2. A valid namespaced application tool (e.g. 'html_notes.notes.create', 'trading.positions.list')
   * 3. A legacy MCP prefix tool (e.g. 'mcp__lazy-tool-service__news_search')
   */
  static validateProfileCapabilities(
    whitelist: string[],
  ): {
    valid: boolean;
    unauthorized: string[];
    reasons?: Record<string, string>;
  } {
    this.init();
    const unauthorized: string[] = [];
    const reasons: Record<string, string> = {};

    for (const rawToolId of whitelist) {
      const parts = rawToolId.split("@");
      const toolId = parts[0];
      const versionConstraint = parts[1];

      if (toolId.startsWith("global.")) {
        const cap = this.capabilities.get(toolId);
        if (!cap) {
          unauthorized.push(rawToolId);
          reasons[rawToolId] = `Unknown capability '${toolId}'`;
        } else if (versionConstraint) {
          // Check major/minor version compatibility
          const [reqMajor, reqMinor] = versionConstraint.split(".").map(Number);
          const [capMajor, capMinor] = cap.version.split(".").map(Number);
          if (reqMajor !== capMajor || (reqMinor !== undefined && reqMinor > capMinor)) {
            unauthorized.push(rawToolId);
            reasons[rawToolId] = `Unsupported capability version '${versionConstraint}' for '${toolId}' (runtime offers '${cap.version}')`;
          }
        }
      } else if (
        // Allow app-namespaced identifiers like 'html_notes.canvas.upsert_widget' or with version tag 'html_notes.canvas.upsert_widget@1.0'
        /^[a-z0-9_-]+\.[a-z0-9_.]+(@\d+(\.\d+)?)?$/.test(rawToolId) ||
        // Allow legacy MCP identifiers
        /^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(rawToolId)
      ) {
        // Valid application or legacy tool identifier
      } else {
        // Malformed or unknown tool identifier pattern
        unauthorized.push(rawToolId);
        reasons[rawToolId] = `Malformed tool identifier pattern '${rawToolId}'`;
      }
    }

    return {
      valid: unauthorized.length === 0,
      unauthorized,
      reasons,
    };
  }

  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
    this.init();
  }
}

CapabilityRegistry.init();
