#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const contractsDir = path.resolve(rootDir, "docs", "contracts");
const targetContracts = path.resolve(rootDir, "dist", "contracts");
const targetSchemas = path.resolve(rootDir, "dist", "schemas");

fs.mkdirSync(targetContracts, { recursive: true });
fs.mkdirSync(targetSchemas, { recursive: true });

// Copy schema files
const filesToExport = [
  "run-contract-v1.json",
  "agent-profile-spec-v1.json",
  "agent-runtime-contract-v1.md",
  "agent-profile-spec-v1.md",
  "agent-plugin-spi-v1.md",
];

for (const file of filesToExport) {
  const srcPath = path.join(contractsDir, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(targetContracts, file));
    if (file.endsWith(".json")) {
      fs.copyFileSync(srcPath, path.join(targetSchemas, file));
    }
  }
}

// Copy fixtures
const fixturesSrc = path.join(contractsDir, "fixtures");
const fixturesDest = path.join(targetContracts, "fixtures");
if (fs.existsSync(fixturesSrc)) {
  fs.mkdirSync(fixturesDest, { recursive: true });
  for (const f of fs.readdirSync(fixturesSrc)) {
    fs.copyFileSync(path.join(fixturesSrc, f), path.join(fixturesDest, f));
  }
}

// Also generate tool-contract-v1.json if tool_schemas.json exists
const toolSchemas = path.resolve(rootDir, "tool_schemas.json");
if (fs.existsSync(toolSchemas)) {
  fs.copyFileSync(toolSchemas, path.join(targetSchemas, "tool-contract-v1.json"));
  fs.copyFileSync(toolSchemas, path.join(targetContracts, "tool-contract-v1.json"));
}

console.log("[export-contracts] Successfully exported contracts and schemas to dist/contracts and dist/schemas");
