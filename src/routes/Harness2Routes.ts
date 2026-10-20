import { Router } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { runHarness2, type Harness2Request } from "../services/harness2/Harness2Service.ts";
import { Library } from "../services/harness2/Library.ts";
import { validateTree } from "../services/harness2/HarnessTree.ts";

const router = Router();

/**
 * POST /harness2/run
 * One task through Harness² recursive harnessing: k base rollouts, Propose–Probe–Compose
 * (parallel or sequential), blind selection, experience reflection, library update.
 * Long-running; returns synchronously.
 */
router.post(
  "/run",
  asyncHandler(async (req, res) => {
    const body = (req.body || {}) as Partial<Harness2Request>;
    if (!body.taskId || !body.task || !body.domain) return res.status(400).json({ error: "taskId, task and domain are required" });
    if (!body.solver?.provider || !body.solver?.model) return res.status(400).json({ error: "solver.provider and solver.model are required" });
    if (!body.baseTree || typeof body.baseTree !== "object") return res.status(400).json({ error: "baseTree is required" });
    try {
      validateTree(body.baseTree);
    } catch (error) {
      return res.status(400).json({ error: `baseTree invalid: ${error instanceof Error ? error.message : String(error)}` });
    }
    const k = Number(body.k ?? 1);
    if (!Number.isInteger(k) || k < 1 || k > 4) return res.status(400).json({ error: "k must be an integer 1..4" });
    if (body.mode && body.mode !== "parallel" && body.mode !== "sequential") return res.status(400).json({ error: "mode must be parallel or sequential" });
    res.json(await runHarness2({ ...(body as Harness2Request), k, libraryRoot: undefined }));
  }),
);

/** GET /harness2/library/:domain — the domain's INDEX and entry ids. */
router.get(
  "/library/:domain",
  asyncHandler(async (req, res) => {
    const lib = new Library(String(req.params.domain));
    res.json({ domain: lib.domain, entries: lib.entries(), context: lib.contextText() });
  }),
);

export default router;
