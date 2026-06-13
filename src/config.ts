// ─── Configuration ──────────────────────────────────────────

import fs from "node:fs";

interface LazyToolServiceConfig {
  LAZY_TOOL_SERVICE_PORT: number;
  LAZY_TOOL_SERVICE_URL: string;
  MONGODB_URI: string | undefined;
  PYTHON_INTERPRETER: string;
  PYTHON_EXEC_SCRIPT: string;
  PYTHON_CWD: string;
  PYTHONPATH: string;
  LAZY_TOOL_SERVICE_API_KEY: string | undefined;
  EXECUTION_TIMEOUT_MS: number;
  CACHE_TTL_MS: number;
  TRADING_SERVICE_URL: string;
  TRADING_SERVICE_API_KEY: string | undefined;
}

// Detect if we are inside the Docker container
const isDocker = fs.existsSync("/.dockerenv") || fs.existsSync("/opt/venv/bin/python");

const defaultInterpreter = isDocker
  ? "/opt/venv/bin/python"
  : "/home/lazycat/github/projects/sun/trading-service/.venv/bin/python";

const defaultExecScript = isDocker
  ? "/app/python/scripts/execute_tool.py"
  : "/home/lazycat/github/projects/sun/trading-service/scripts/execute_tool.py";

const defaultCwd = isDocker
  ? "/app/python"
  : "/home/lazycat/github/projects/sun/trading-service";

const defaultPythonPath = isDocker
  ? "/app/python"
  : [
      "/home/lazycat/github/projects/sun/trading-service",
      "/home/lazycat/github/projects/sun/trading-client"
    ].join(process.platform === "win32" ? ";" : ":");

const CONFIG: LazyToolServiceConfig = {
  LAZY_TOOL_SERVICE_PORT: Number(process.env.LAZY_TOOL_SERVICE_PORT || "5591"),
  LAZY_TOOL_SERVICE_URL: process.env.LAZY_TOOL_SERVICE_URL || "http://localhost:5591",
  MONGODB_URI: process.env.MONGO_URI || process.env.MONGODB_URI,
  PYTHON_INTERPRETER: process.env.PYTHON_INTERPRETER || defaultInterpreter,
  PYTHON_EXEC_SCRIPT: process.env.PYTHON_EXEC_SCRIPT || defaultExecScript,
  PYTHON_CWD: process.env.PYTHON_CWD || defaultCwd,
  PYTHONPATH: process.env.PYTHONPATH || defaultPythonPath,
  LAZY_TOOL_SERVICE_API_KEY: process.env.LAZY_TOOL_SERVICE_API_KEY,
  EXECUTION_TIMEOUT_MS: Number(process.env.EXECUTION_TIMEOUT_MS || "30000"),
  CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS || "60000"),
  TRADING_SERVICE_URL: process.env.TRADING_SERVICE_URL || "http://10.0.0.16:3031",
  TRADING_SERVICE_API_KEY: process.env.TRADING_SERVICE_API_KEY,
};

export default CONFIG;
