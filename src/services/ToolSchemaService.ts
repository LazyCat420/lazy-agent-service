import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasPath = path.resolve(__dirname, "../../tool_schemas.json");

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolParameters {
  type: string;
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolConditionalPath {
  param: string;
  template: string;
}

export interface ToolEndpoint {
  path: string;
  method?: "GET" | "POST";
  queryParams?: string[];
  pathParams?: string[];
  bodyParams?: string[];
  conditionalPath?: ToolConditionalPath;
}

export interface CachedDataSource {
  type: "cached";
  provider: string;
  intervalSeconds: number;
}

export interface OnDemandDataSource {
  type: "onDemand";
  provider: string;
}

export interface StaticDataSource {
  type: "static";
  provider: string;
  dataset: string;
}

export interface ComputeDataSource {
  type: "compute";
  provider: string;
  runtime: string;
}

export type ToolDataSource = CachedDataSource | OnDemandDataSource | StaticDataSource | ComputeDataSource;

export interface ToolDefinition {
  name: string;
  description: string;
  dataSource?: ToolDataSource;
  endpoint?: ToolEndpoint;
  parameters?: ToolParameters;
}

export interface ToolSchema extends ToolDefinition {
  domain: string;
  labels: string[];
  emoji: string | null;
  // Python metadata fields
  tier?: number;
  source?: string;
  permission?: string;
  fallback_only?: boolean;
  concurrency_safe?: boolean;
  max_result_chars?: number;
  tags?: string[];
}

let schemas: ToolSchema[] = [];

try {
  if (fs.existsSync(schemasPath)) {
    const rawData = fs.readFileSync(schemasPath, "utf-8");
    const list = JSON.parse(rawData);
    schemas = list.map((item: any) => {
      const tool = item.function || item;
      return {
        ...tool,
        domain: item.domain || tool.domain || "General",
        labels: item.labels || tool.labels || ["tool"],
        emoji: item.emoji || tool.emoji || null,
        // Map every tool to a post execution endpoint in lazy-tool-service
        endpoint: item.endpoint || tool.endpoint || {
          path: `/execute/${tool.name}`,
          method: "POST"
        }
      };
    });
    logger.success(`Loaded ${schemas.length} tool schemas from tool_schemas.json`);
  } else {
    logger.warn(`tool_schemas.json not found at ${schemasPath}. Run export_tool_schemas.py first.`);
  }
} catch (error: any) {
  logger.error(`Error loading tool schemas: ${(error as Error).message}`);
}

export function getToolSchemas(): ToolSchema[] {
  return schemas;
}

export function getToolSchemasForAI() {
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
  }));
}
