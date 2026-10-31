import fs from "node:fs";
import path from "node:path";

/** Locate projects.json in cwd or the repo root; throw when absent and not opted out. */
function _resolveProjectsPath(): string | null {
  let projectsPath = path.resolve(process.cwd(), "projects.json");
  if (!fs.existsSync(projectsPath)) {
    const parentCandidate = path.resolve(process.cwd(), "../..", "projects.json");
    if (fs.existsSync(parentCandidate)) {
      projectsPath = parentCandidate;
    }
  }
  if (!fs.existsSync(projectsPath)) {
    // Fail loudly: a missing projects.json silently degrades provider/instance
    // resolution to raw process.env and produces WRONG model choices (this
    // cost an hour of wrong vllm/vllm-2 resolution in a fresh worktree on
    // 2026-10-10). Set ALLOW_MISSING_PROJECTS_JSON=1 to opt out in tests and
    // sandboxes that genuinely have no instance registry.
    if (process.env.ALLOW_MISSING_PROJECTS_JSON === "1") {
      console.warn(`[Local-Vault] ⚠️ projects.json not found at ${projectsPath}, using raw process.env (ALLOW_MISSING_PROJECTS_JSON=1)`);
      return null;
    }
    throw new Error(
      `[Local-Vault] projects.json not found at ${projectsPath}. ` +
      `Provider/instance resolution would silently use raw process.env. ` +
      `Copy it from vault-service or the deploy dir, or set ALLOW_MISSING_PROJECTS_JSON=1.`,
    );
  }
  return projectsPath;
}

/** Set every root config key from projects.json when not already in process.env. */
function _hydrateRootConfig(data: { config?: Record<string, unknown> }): void {
  // 1. Hydrate root config
  if (data.config) {
    for (const [key, value] of Object.entries(data.config)) {
      if (process.env[key] === undefined) {
        process.env[key] = String(value);
      }
    }
  }
}

/** Shape of one entry in projects.json `projects`. */
interface ProjectEntry {
  id: string;
  port?: number | string;
  wsPort?: number | string;
  db?: string;
  minioBucket?: string;
  config?: Record<string, unknown>;
}

/** Derive per-project env vars (ports, URLs, db, bucket, config) from projects.json. */
function _deriveProjectVariables(
  data: { projects?: ProjectEntry[] },
  host: string,
): void {
  // 2. Derive project variables
  if (data.projects) {
    for (const project of data.projects) {
      const prefix = project.id.toUpperCase().replace(/-/g, "_");
      if (project.port) {
        if (process.env[`${prefix}_PORT`] === undefined) {
          process.env[`${prefix}_PORT`] = String(project.port);
        }
        if (process.env[`${prefix}_URL`] === undefined) {
          process.env[`${prefix}_URL`] = `http://${host}:${project.port}`;
        }
      }
      if (project.wsPort) {
        if (process.env[`${prefix}_WS_URL`] === undefined) {
          process.env[`${prefix}_WS_URL`] = `ws://${host}:${project.wsPort}`;
        }
      }
      if (project.db) {
        if (process.env[`${prefix}_MONGO_DB_NAME`] === undefined) {
          process.env[`${prefix}_MONGO_DB_NAME`] = project.db;
        }
      }
      if (project.minioBucket) {
        if (process.env[`${prefix}_MINIO_BUCKET_NAME`] === undefined) {
          process.env[`${prefix}_MINIO_BUCKET_NAME`] = project.minioBucket;
        }
      }
      if (project.config) {
        for (const [key, value] of Object.entries(project.config)) {
          if (process.env[key] === undefined) {
            process.env[key] = String(value);
          }
        }
      }
    }
  }
}

export function bootstrapLocalEnvironment() {
  const projectsPath = _resolveProjectsPath();
  if (!projectsPath) return;
  try {
    const data = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
    const host = data.defaultHost || "10.0.0.16";

    _hydrateRootConfig(data);
    _deriveProjectVariables(data, host);

    if (process.env.DEFAULT_HOST === undefined) {
      process.env.DEFAULT_HOST = String(host);
    }

    console.log(`[Local-Vault] ✅ Successfully loaded secrets from local projects.json`);
  } catch (error: any) {
    console.error(`[Local-Vault] ❌ Failed to load local projects.json:`, error.message);
  }
}
