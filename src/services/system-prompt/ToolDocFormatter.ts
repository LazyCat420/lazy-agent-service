import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import {
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

interface ToolParameterDescriptor {
  description?: string;
  type?: string;
  [key: string]: unknown;
}

interface ToolSchemaDescriptor {
  name: string;
  description?: string;
  domain?: string;
  parameters?: {
    type?: string;
    properties?: Record<string, ToolParameterDescriptor>;
    required?: string[];
  };
  [key: string]: unknown;
}

export class ToolDocFormatter {
  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Groups tools by their `domain` field, then for each tool shows:
   *   - Name + first sentence of description (capability summary)
   *   - Full parameter listing with required markers
   */
  buildToolDescriptions(
    enabledTools?: string[],
    agentId?: string | null,
    defaultTopology?: string,
    resolvedToolNames?: string[],
    lockedOffToolNames?: Set<string>,
    compact?: boolean,
    locale = "en",
    loadedTools?: Set<string>,
  ): string {
    const schemas = ToolOrchestratorService.getClientToolSchemas(
      defaultTopology,
      locale,
    ) as ToolSchemaDescriptor[];

    if (resolvedToolNames?.length) {
      const resolvedSet = new Set(resolvedToolNames);
      let filteredSchemas = schemas.filter((toolSchema) =>
        resolvedSet.has(toolSchema.name),
      );
      if (lockedOffToolNames?.size) {
        filteredSchemas = filteredSchemas.filter(
          (toolSchema) => !lockedOffToolNames.has(toolSchema.name),
        );
      }
      return this._formatToolDescriptions(filteredSchemas, compact, locale, loadedTools);
    }

    if (!enabledTools) {
      let allSchemas = schemas;
      if (lockedOffToolNames?.size) {
        allSchemas = allSchemas.filter(
          (toolSchema) => !lockedOffToolNames.has(toolSchema.name),
        );
      }
      return this._formatToolDescriptions(allSchemas, compact, locale, loadedTools);
    }

    const hasPrefixed = enabledTools.some(
      (enabledTool) =>
        enabledTool.startsWith("domain:") ||
        enabledTool.startsWith("domainKey:"),
    );

    const enabledSet = hasPrefixed
      ? resolveToolEntriesToSet(enabledTools, schemas)
      : new Set(enabledTools);

    const persona = agentId ? AgentPersonaRegistry.get(agentId) : null;
    const isCoreToolsLocked = persona?.coreToolsLocked ?? true;

    let filteredSchemas = schemas.filter(
      (toolSchema) =>
        enabledSet.has(toolSchema.name) ||
        (isCoreToolsLocked &&
          (isCoreDomain(toolSchema.domain || "") ||
            CORE_AGENTIC_TOOLS.has(toolSchema.name))),
    );

    if (persona?.blockedTools?.length) {
      const disabledSet = resolveToolEntriesToSet(
        persona.blockedTools,
        schemas,
      );
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) =>
          !disabledSet.has(toolSchema.name) || enabledSet.has(toolSchema.name),
      );
    }

    if (lockedOffToolNames?.size) {
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) => !lockedOffToolNames.has(toolSchema.name),
      );
    }

    return this._formatToolDescriptions(filteredSchemas, compact, locale, loadedTools);
  }

  private _formatToolDescriptions(
    filteredSchemas: ToolSchemaDescriptor[],
    compact?: boolean,
    locale = "en",
    loadedTools = new Set<string>(),
  ): string {
    if (filteredSchemas.length === 0) return "";

    // Group by domain
    const groups = new Map<string, ToolSchemaDescriptor[]>();
    for (const tool of filteredSchemas) {
      const domain = (tool.domain || "Other").replace(/^Agentic:\s*/i, "");
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(tool);
    }

    // Build categorised sections with parameter details
    const sections: string[] = [];
    for (const [domain, domainTools] of groups) {
      const entries = domainTools.map((tool) => {
        const fullDescription = tool.description || "";

        // In compact mode or meta list mode, truncate to first sentence only
        const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
        const isLoaded = tool.name === "describe_tools" || loadedTools.has(cleanName);
        const description = (compact || !isLoaded)
          ? fullDescription.split(/(?<=[.!?])\s/)[0] || fullDescription
          : fullDescription;

        if (!isLoaded) {
          return `### ${tool.name}\n${description}\n  - (Parameters: CALL describe_tools(["${tool.name}"]) first to retrieve parameter schema before invoking this tool.)`;
        }

        const parameters = tool.parameters?.properties || {};
        const parameterNames = Object.keys(parameters);
        const required = tool.parameters?.required || [];

        // In compact mode, only show required parameters
        const filteredParameterNames = compact
          ? parameterNames.filter((parameterName) =>
              required.includes(parameterName),
            )
          : parameterNames;

        const parameterString = filteredParameterNames
          .map((parameterName) => {
            const isRequired = required.includes(parameterName);
            const parameterDescription =
              parameters[parameterName].description || "";

            // In compact mode, truncate parameter descriptions to first sentence
            const truncatedDescription = compact
              ? parameterDescription.split(/(?<=[.!?])\s/)[0] ||
                parameterDescription
              : parameterDescription;

            const requiredSuffix = isRequired
              ? PromptLocaleService.get(locale, "system-prompt.requiredLabel")
              : "";
            return `  - ${parameterName}${requiredSuffix}: ${truncatedDescription}`;
          })
          .join("\n");

        return `### ${tool.name}\n${description}${parameterString ? "\n" + parameterString : ""}`;
      });

      sections.push(`**${domain}**\n${entries.join("\n\n")}`);
    }

    return sections.join("\n\n");
  }
}
