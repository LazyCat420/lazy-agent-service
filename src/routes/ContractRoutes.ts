import express, { Request, Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { CapabilityRegistry } from "../services/CapabilityRegistry.ts";
import { ProfileRegistry } from "../services/ProfileRegistry.ts";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";
import { RunRequestSchema } from "../services/RunAdmission.ts";

const router = express.Router();
router.get("/request-schema", (_req, res) => res.json(z.toJSONSchema(RunRequestSchema)));

const CONTRACT_VERSION = "1.2.0";

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
      supported_minor_versions: ["1.0.0", "1.1.0", "1.2.0"],
      capabilities_count: CapabilityRegistry.listCapabilities().length,
      registered_profiles: ProfileRegistry.getRegisteredProfileIds(),
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

    const rootDir = process.cwd();
    let contractsDir = path.resolve(rootDir, "contracts");
    if (!fs.existsSync(contractsDir)) {
      contractsDir = path.resolve(rootDir, "docs", "contracts");
    }

    let runContractSchema: any = null;
    let profileSpecSchema: any = null;
    let toolContractSchema: any = null;
    let errorCodesSchema: any = null;

    try {
      const runContractPath = path.join(contractsDir, "run-contract-v1.2.json");
      if (fs.existsSync(runContractPath)) {
        runContractSchema = JSON.parse(fs.readFileSync(runContractPath, "utf-8"));
      } else {
        const legacyRun = path.join(contractsDir, "run-contract-v1.json");
        if (fs.existsSync(legacyRun)) runContractSchema = JSON.parse(fs.readFileSync(legacyRun, "utf-8"));
      }

      const profileSpecPath = path.join(contractsDir, "profile-contract-v1.2.json");
      if (fs.existsSync(profileSpecPath)) {
        profileSpecSchema = JSON.parse(fs.readFileSync(profileSpecPath, "utf-8"));
      } else {
        const legacyProfile = path.join(contractsDir, "agent-profile-spec-v1.json");
        if (fs.existsSync(legacyProfile)) profileSpecSchema = JSON.parse(fs.readFileSync(legacyProfile, "utf-8"));
      }

      const toolContractPath = path.join(contractsDir, "tool-contract-v1.2.json");
      if (fs.existsSync(toolContractPath)) {
        toolContractSchema = JSON.parse(fs.readFileSync(toolContractPath, "utf-8"));
      }

      const errorCodesPath = path.join(contractsDir, "error-codes-v1.2.json");
      if (fs.existsSync(errorCodesPath)) {
        errorCodesSchema = JSON.parse(fs.readFileSync(errorCodesPath, "utf-8"));
      }
    } catch {
      // Fallback if reading fails
    }

    res.json({
      bundle_version: CONTRACT_VERSION,
      generated_at: new Date().toISOString(),
      run_contract: runContractSchema,
      profile_spec: profileSpecSchema,
      tool_contract: toolContractSchema,
      error_codes: errorCodesSchema,
      global_capabilities: CapabilityRegistry.listCapabilities(),
    });
  }),
);

export default router;
