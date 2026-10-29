import fs from "node:fs";
import path from "node:path";
import logger from "../logger.js";
const schemasPath = path.resolve(process.cwd(), "tool_schemas.json");
let schemas = [];
try {
    if (fs.existsSync(schemasPath)) {
        const rawData = fs.readFileSync(schemasPath, "utf-8");
        const list = JSON.parse(rawData);
        schemas = list.map((item) => {
            const itemRecord = item;
            const tool = (itemRecord.function || itemRecord);
            return {
                ...tool,
                domain: (itemRecord.domain || tool.domain || "General"),
                labels: (itemRecord.labels || tool.labels || ["tool"]),
                emoji: (itemRecord.emoji || tool.emoji || null),
                endpoint: (itemRecord.endpoint || tool.endpoint || {
                    path: `/execute/${tool.name}`,
                    method: "POST"
                })
            };
        });
        logger.success(`Loaded ${schemas.length} tool schemas from tool_schemas.json`);
    }
    else {
        logger.warn(`tool_schemas.json not found at ${schemasPath}. Run export_tool_schemas.py first.`);
    }
}
catch (error) {
    logger.error(`Error loading tool schemas: ${error.message}`);
}
export function getToolSchemas() {
    return schemas;
}
export function getToolSchemasForAI() {
    return schemas.map((s) => ({
        name: s.name,
        description: s.description,
        parameters: s.parameters,
    }));
}
//# sourceMappingURL=ToolSchemaService.js.map