#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const contractsDir = path.resolve(rootDir, "docs", "contracts");
const rootContractsDir = path.resolve(rootDir, "contracts");
const targetContracts = path.resolve(rootDir, "dist", "contracts");
const targetSchemas = path.resolve(rootDir, "dist", "schemas");

fs.mkdirSync(targetContracts, { recursive: true });
fs.mkdirSync(targetSchemas, { recursive: true });

// Copy schema files from contracts/ and docs/contracts/
const filesToExport = [
  "run-contract-v1.2.json",
  "capability-registry-v1.2.json",
  "profile-contract-v1.2.json",
  "tool-contract-v1.2.json",
  "error-codes-v1.2.json",
  // Legacy / v1.1.0 compatibility
  "run-contract-v1.json",
  "global-capabilities-v1.json",
  "agent-profile-spec-v1.json",
  "agent-runtime-contract-v1.md",
  "agent-profile-spec-v1.md",
  "agent-plugin-spi-v1.md",
];

for (const file of filesToExport) {
  let srcPath = path.join(rootContractsDir, file);
  if (!fs.existsSync(srcPath)) {
    srcPath = path.join(contractsDir, file);
  }
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(targetContracts, file));
    if (file.endsWith(".json")) {
      fs.copyFileSync(srcPath, path.join(targetSchemas, file));
    }
  }
}

// Copy fixtures
const fixturesSrc = fs.existsSync(path.join(rootContractsDir, "fixtures"))
  ? path.join(rootContractsDir, "fixtures")
  : path.join(contractsDir, "fixtures");
const fixturesDest = path.join(targetContracts, "fixtures");

if (fs.existsSync(fixturesSrc)) {
  fs.mkdirSync(fixturesDest, { recursive: true });
  for (const f of fs.readdirSync(fixturesSrc)) {
    fs.copyFileSync(path.join(fixturesSrc, f), path.join(fixturesDest, f));
  }
}

// Generate self-contained contracts-bundle-v1.2.0.json
const bundleV12Path = path.join(targetContracts, "contracts-bundle-v1.2.0.json");
const runContractV12 = path.join(rootContractsDir, "run-contract-v1.2.json");
const capRegistryV12 = path.join(rootContractsDir, "capability-registry-v1.2.json");
const profileSpecV12 = path.join(rootContractsDir, "profile-contract-v1.2.json");
const errorCodesV12 = path.join(rootContractsDir, "error-codes-v1.2.json");
const toolContractV12 = path.join(rootContractsDir, "tool-contract-v1.2.json");

const bundleV12 = {
  contract_version: "1.2.0",
  generated_at: new Date().toISOString(),
  run_contract: fs.existsSync(runContractV12) ? JSON.parse(fs.readFileSync(runContractV12, "utf-8")) : null,
  capability_registry: fs.existsSync(capRegistryV12) ? JSON.parse(fs.readFileSync(capRegistryV12, "utf-8")) : null,
  profile_contract: fs.existsSync(profileSpecV12) ? JSON.parse(fs.readFileSync(profileSpecV12, "utf-8")) : null,
  tool_contract: fs.existsSync(toolContractV12) ? JSON.parse(fs.readFileSync(toolContractV12, "utf-8")) : null,
  error_codes: fs.existsSync(errorCodesV12) ? JSON.parse(fs.readFileSync(errorCodesV12, "utf-8")) : null,
};

fs.writeFileSync(bundleV12Path, JSON.stringify(bundleV12, null, 2), "utf-8");
fs.copyFileSync(bundleV12Path, path.join(targetSchemas, "contracts-bundle-v1.2.0.json"));

// Generate backward-compatible bundle v1.1.0
const bundleV11Path = path.join(targetContracts, "contracts-bundle-v1.1.0.json");
const runContractV11 = path.join(contractsDir, "run-contract-v1.json");
const globalCapsV11 = path.join(contractsDir, "global-capabilities-v1.json");
const profileSpecV11 = path.join(contractsDir, "agent-profile-spec-v1.json");

const bundleV11 = {
  contract_version: "1.1.0",
  generated_at: new Date().toISOString(),
  run_contract: fs.existsSync(runContractV11) ? JSON.parse(fs.readFileSync(runContractV11, "utf-8")) : null,
  global_capabilities: fs.existsSync(globalCapsV11) ? JSON.parse(fs.readFileSync(globalCapsV11, "utf-8")) : null,
  agent_profile_spec: fs.existsSync(profileSpecV11) ? JSON.parse(fs.readFileSync(profileSpecV11, "utf-8")) : null,
};

fs.writeFileSync(bundleV11Path, JSON.stringify(bundleV11, null, 2), "utf-8");
fs.copyFileSync(bundleV11Path, path.join(targetSchemas, "contracts-bundle-v1.1.0.json"));

// Also generate tool-contract-v1.json if tool_schemas.json exists
const toolSchemas = path.resolve(rootDir, "tool_schemas.json");
if (fs.existsSync(toolSchemas)) {
  fs.copyFileSync(toolSchemas, path.join(targetSchemas, "tool-contract-v1.json"));
  fs.copyFileSync(toolSchemas, path.join(targetContracts, "tool-contract-v1.json"));
}

console.log("[export-contracts] Successfully exported contracts and schemas to dist/contracts and dist/schemas");
