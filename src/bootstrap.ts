import fs from "node:fs";
import path from "node:path";

export function bootstrapLocalEnvironment() {
  const projectsPath = path.resolve(process.cwd(), "projects.json");
  if (!fs.existsSync(projectsPath)) {
    console.warn(`[Local-Vault] ⚠️ projects.json not found at ${projectsPath}, using raw process.env`);
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
    const host = data.defaultHost || "10.0.0.16";
    
    // 1. Hydrate root config
    if (data.config) {
      for (const [key, value] of Object.entries(data.config)) {
        if (process.env[key] === undefined) {
          process.env[key] = String(value);
        }
      }
    }
    
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
    // 3. Prism consumer scopes — the projects we register ourselves under as
    // an MCP server on boot. Serialized because env vars are strings; see
    // PrismRegistrationService.loadConsumers().
    if (Array.isArray(data.prismConsumers) && process.env.PRISM_CONSUMERS === undefined) {
      process.env.PRISM_CONSUMERS = JSON.stringify(data.prismConsumers);
    }
    if (process.env.DEFAULT_HOST === undefined) {
      process.env.DEFAULT_HOST = String(host);
    }

    console.log(`[Local-Vault] ✅ Successfully loaded secrets from local projects.json`);
  } catch (error: any) {
    console.error(`[Local-Vault] ❌ Failed to load local projects.json:`, error.message);
  }
}
