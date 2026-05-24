import { Router, Request, Response, RequestHandler } from "express";
import { spawn } from "node:child_process";
import CONFIG from "../config.js";
import logger from "../logger.js";

const router = Router();

export const executeTool = async (toolName: string, args: Record<string, any>): Promise<any> => {
  return new Promise((resolve, reject) => {
    const argsJson = JSON.stringify(args);
    logger.info(`Spawning Python execution for tool: ${toolName}`);
    
    // Set up environment. Ensure PYTHONPATH is configured so python app can resolve imports.
    const env = {
      ...process.env,
      PYTHONPATH: CONFIG.PYTHONPATH,
      SKIP_TOOL_USAGE_LOG: "true",
      USE_LAZY_TOOL_SERVICE: "false"
    };

    const child = spawn(
      CONFIG.PYTHON_INTERPRETER,
      [CONFIG.PYTHON_EXEC_SCRIPT, toolName, argsJson],
      {
        cwd: CONFIG.PYTHON_CWD,
        env
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        logger.error(`Python tool execute failed with exit code ${code}. Stderr: ${stderr}`);
        reject(new Error(`Tool execution failed (exit code ${code}): ${stderr || stdout}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (err: any) {
        logger.error(`Failed to parse Python tool output JSON: ${(err as Error).message}. Raw output: ${stdout}`);
        reject(new Error(`Invalid JSON output from tool: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      logger.error(`Failed to spawn Python process: ${err.message}`);
      reject(err);
    });
  });
};

const handleExecuteRoute: RequestHandler = async (req, res) => {
  const { toolName } = req.params;
  const args = req.body || {};

  try {
    const result = await executeTool(toolName as string, args);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: (error as Error).message });
  }
};

router.post("/:toolName", handleExecuteRoute);

export default router;
export { handleExecuteRoute };
