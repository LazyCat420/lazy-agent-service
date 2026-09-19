import express, { Request, Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { CapabilityRegistry } from "../services/CapabilityRegistry.ts";
import fs from "node:fs";
import path from "node:path";

const router = express.Router();

const CONTRACT_VERSION = "1.1.0";

/**
 * GET /v1/contracts/spec
 * Returns the current runtime specification metadata and supported version.
 */
router.get(
  "/spec",
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader("x-contract-version", CONTRACT_VERSION);
    res.json({
      title: "AgentRuntimeContractV1",
      version: CONTRACT_VERSION,
      status: "CANONICAL",
      owner: "lazy-agent-service",
      supported_major_versions: [1],
      supported_minor_versions: ["1.0.0", "1.1.0"],
      capabilities_count: CapabilityRegistry.listCapabilities().length,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /v1/contracts/capabilities
 * Returns the list of registered global capabilities and their schemas.
 */
router.get(
  "/capabilities",
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader("x-contract-version", CONTRACT_VERSION);
    res.json({
      version: CONTRACT_VERSION,
      capabilities: CapabilityRegistry.listCapabilities(),
    });
  }),
);

/**
 * GET /v1/contracts/bundle
 * Returns the self-contained contract bundle (schemas, capabilities, specification)
 * allowing consumer microservices to validate contracts without sibling filesystem checkouts.
 */
router.get(
  "/bundle",
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader("x-contract-version", CONTRACT_VERSION);

    const contractsDir = path.resolve(process.cwd(), "docs", "contracts");
    let runContractSchema: any = null;
    let profileSpecSchema: any = null;

    try {
      const runContractPath = path.join(contractsDir, "run-contract-v1.json");
      if (fs.existsSync(runContractPath)) {
        runContractSchema = JSON.parse(fs.readFileSync(runContractPath, "utf-8"));
      }
      const profileSpecPath = path.join(contractsDir, "agent-profile-spec-v1.json");
      if (fs.existsSync(profileSpecPath)) {
        profileSpecSchema = JSON.parse(fs.readFileSync(profileSpecPath, "utf-8"));
      }
    } catch {
      // Fallback if reading fails
    }

    res.json({
      bundle_version: CONTRACT_VERSION,
      generated_at: new Date().toISOString(),
      run_contract: runContractSchema,
      profile_spec: profileSpecSchema,
      global_capabilities: CapabilityRegistry.listCapabilities(),
    });
  }),
);

export default router;
