import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import { getProvider } from "../providers/index.ts";
import { getModelByName } from "../config.ts";
import logger from "../utils/logger.ts";
import { SseEvent } from "../types/SseTypes.ts";
import { ConversationMessage } from "./harnesses/types.ts";
import {
  RecurrenceRule,
  matchRecurrenceRule,
} from "../utils/RecurrenceMatcher.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { isVllmProvider, isEmbeddingModel } from "./VllmModelSyncService.ts";

export interface ScheduledTask {
  id: string;
  name: string;
  project: string;
  username?: string;
  prompt: string;
  agent: string | null;
  provider: string;
  model: string;
  scheduleType:
    | "hourly"
    | "daily"
    | "weekly"
    | "cron"
    | "trigger"
    | "once"
    | "custom";
  scheduleTime?: string; // "HH:MM" e.g. "09:00"
  scheduleDay?: number; // 0-6 (Sunday to Saturday)
  scheduleDate?: string; // "YYYY-MM-DD" e.g. "2026-05-25"
  cronExpression?: string; // e.g. "0 9 * * *"
  recurrenceRule?: RecurrenceRule;
  toolConfig?: {
    enabledTools?: string[];
    disabledTools?: string[];
  };
  enabled: boolean;
  lastRunMinute?: string; // "YYYY-MM-DDTHH:mm"
  createdAt: string;
  updatedAt: string;
}

// ─── Simple Zero-Dependency Cron Matcher ───────────────────────────────────────

function matchCronField(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  if (pattern.includes(",")) {
    return pattern.split(",").some((pattern) => matchCronField(pattern, value));
  }
  if (pattern.includes("/")) {
    const [range, stepString] = pattern.split("/");
    const step = parseInt(stepString, 10);
    if (isNaN(step)) return false;
    if (range === "*") {
      return value % step === 0;
    }
    const [startString] = range.split("-");
    const start = parseInt(startString, 10);
    return !isNaN(start) && value >= start && (value - start) % step === 0;
  }
  if (pattern.includes("-")) {
    const [startString, endString] = pattern.split("-");
    const start = parseInt(startString, 10);
    const end = parseInt(endString, 10);
    return !isNaN(start) && !isNaN(end) && value >= start && value <= end;
  }
  return parseInt(pattern, 10) === value;
}

export function matchCron(
  expression: string,
  date: Date = new Date(),
): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;

  return (
    matchCronField(min, date.getMinutes()) &&
    matchCronField(hour, date.getHours()) &&
    matchCronField(dom, date.getDate()) &&
    matchCronField(month, date.getMonth() + 1) &&
    matchCronField(dow, date.getDay())
  );
}

// ─── Scheduler Daemon & CRUD Logic ─────────────────────────────────────────────

let tickingInterval: ReturnType<typeof setInterval> | null = null;

const ScheduledTaskService = {
  /**
   * Initializes the scheduler. Runs a tick loop every 60 seconds.
   */
  async init(): Promise<void> {
    if (tickingInterval) {
      clearInterval(tickingInterval);
    }

    logger.info("[ScheduledTasks] Initializing Background Scheduler Daemon…");

    // Align tick to the next local minute boundary for timing precision
    const secondsToNextMinute = 60 - new Date().getSeconds();
    setTimeout(() => {
      this.tick().catch((error: unknown) =>
        logger.error(
          `[ScheduledTasks] Initial tick error: ${getErrorMessage(error)}`,
        ),
      );

      tickingInterval = setInterval(() => {
        this.tick().catch((error: unknown) =>
          logger.error(
            `[ScheduledTasks] Tick error: ${getErrorMessage(error)}`,
          ),
        );
      }, 60000);
    }, secondsToNextMinute * 1000);

    logger.success(
      "[ScheduledTasks] Background Scheduler Daemon started successfully.",
    );
  },

  /**
   * Clears the scheduler tick loop.
   */
  destroy(): void {
    if (tickingInterval) {
      clearInterval(tickingInterval);
      tickingInterval = null;
      logger.info("[ScheduledTasks] Background Scheduler Daemon stopped.");
    }
  },

  /**
   * Core tick logic: scans MongoDB for enabled tasks and triggers any that are due.
   */
  async tick(): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;

    const now = new Date();
    const currentMin = now.getMinutes();
    const currentHour = now.getHours();
    const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday

    const minuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(currentHour).padStart(2, "0")}:${String(currentMin).padStart(2, "0")}`;

    // Fetch enabled tasks that have not run yet in this exact minute
    const tasks = (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find({ enabled: true, lastRunMinute: { $ne: minuteKey } })
      .toArray()) as unknown as ScheduledTask[];

    if (tasks.length === 0) return;

    for (const task of tasks) {
      let isDue = false;

      try {
        if (task.scheduleType === "cron" && task.cronExpression) {
          isDue = matchCron(task.cronExpression, now);
        } else if (task.scheduleType === "hourly") {
          // Default to run at minute 0 of every hour
          isDue = currentMin === 0;
        } else if (task.scheduleType === "daily" && task.scheduleTime) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          isDue = currentHour === sh && currentMin === sm;
        } else if (
          task.scheduleType === "weekly" &&
          task.scheduleTime &&
          task.scheduleDay != null
        ) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          isDue =
            currentDay === task.scheduleDay &&
            currentHour === sh &&
            currentMin === sm;
        } else if (
          task.scheduleType === "once" &&
          task.scheduleTime &&
          task.scheduleDate
        ) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          const [yr, mn, dy] = task.scheduleDate.split("-").map(Number);
          isDue =
            now.getFullYear() === yr &&
            now.getMonth() + 1 === mn &&
            now.getDate() === dy &&
            currentHour === sh &&
            currentMin === sm;
        } else if (
          task.scheduleType === "custom" &&
          task.recurrenceRule &&
          task.scheduleTime
        ) {
          const [sh, sm] = task.scheduleTime.split(":").map(Number);
          const isTimeMatch = currentHour === sh && currentMin === sm;
          if (isTimeMatch) {
            const startDate = task.recurrenceRule.startDate
              ? new Date(task.recurrenceRule.startDate)
              : new Date(task.createdAt);
            isDue = matchRecurrenceRule(task.recurrenceRule, startDate, now);
          }
        }

        if (isDue) {
          logger.info(
            `[ScheduledTasks] Task "${task.name}" (${task.id}) is due to run.`,
          );

          const updateFields: Record<string, unknown> = {
            lastRunMinute: minuteKey,
            updatedAt: new Date().toISOString(),
          };
          if (task.scheduleType === "once") {
            updateFields.enabled = false;
          }

          // Atomically claim this task for this minute — prevents double execution
          // in multi-instance cluster setups. Only the first instance to update
          // will get a non-null result; subsequent instances skip.
          const claimResult = await db
            .collection(COLLECTIONS.SCHEDULED_TASKS)
            .findOneAndUpdate(
              { id: task.id, lastRunMinute: { $ne: minuteKey } },
              { $set: updateFields },
            );

          if (!claimResult) {
            logger.info(
              `[ScheduledTasks] Task "${task.name}" already claimed by another instance.`,
            );
            continue;
          }

          // Trigger execution in the background asynchronously
          this.executeTask(task, undefined, {
            username: task.username || "system",
          }).catch((error: unknown) =>
            logger.error(
              `[ScheduledTasks] Execution failed for task "${task.name}": ${getErrorMessage(error)}`,
            ),
          );
        }
      } catch (error: unknown) {
        logger.error(
          `[ScheduledTasks] Failed to parse/check task "${task.name}": ${getErrorMessage(error)}`,
        );
      }
    }
  },

  /**
   * Programmatically executes a scheduled task in the background.
   * Decoupled completely from live WebSockets/browser clients.
   */
  async executeTask(
    task: ScheduledTask,
    payload?: Record<string, unknown>,
    {
      username = "system",
      agentConversationId,
    }: { username?: string; agentConversationId?: string } = {},
  ): Promise<{ agentConversationId: string }> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const resolvedConversationId = agentConversationId || crypto.randomUUID();
    if (!task.agent) {
      throw new Error(
        `Scheduled task "${task.name}" is missing a required agent identifier`,
      );
    }
    const traceId = crypto.randomUUID();
    const nowISO = new Date().toISOString();

    logger.info(
      `[ScheduledTasks] Executing task "${task.name}" under Conversation ID: ${resolvedConversationId} (user: ${username})`,
    );

    // Determine default workspace root path if available
    let workspacePath: string | null = null;
    try {
      const workspaceDoc = await db.collection(COLLECTIONS.WORKSPACES).findOne({
        name: task.project,
      });
      if (workspaceDoc?.path) {
        workspacePath = workspaceDoc.path as string;
      }
    } catch {
      // Best-effort
    }

    // Build the final prompt with optional payload context
    let finalPrompt = task.prompt;
    if (payload && Object.keys(payload).length > 0) {
      finalPrompt += `\n\nTrigger payload: ${JSON.stringify(payload)}`;
    }

    const userTriggerMessage = {
      role: "user" as const,
      content: finalPrompt,
      timestamp: nowISO,
      _alreadyPersisted: true,
    };

    // 1. Resolve provider and model dynamically for vLLM providers to prevent 404s
    let effectiveProvider = task.provider;
    let effectiveModel = task.model;

    if (isVllmProvider(task.provider)) {
      try {
        const prov = getProvider(task.provider);
        if (prov?.listModels) {
          const result = await Promise.race([
            prov.listModels(),
            new Promise<any>((_, rej) =>
              setTimeout(() => rej(new Error("timeout")), 2500),
            ),
          ]);
          const models: Array<{ key?: string; id?: string }> =
            result?.models || result?.data || [];
          const modelKeys = models
            .map((m) => m.key || m.id || "")
            .filter(Boolean);
          const generationModels = modelKeys.filter((m) => !isEmbeddingModel(m, ""));

          if (generationModels.length > 0 && !generationModels.includes(task.model)) {
            const liveModel = generationModels[0];
            logger.warn(
              `[ScheduledTasks] Task "${task.name}" requested model "${task.model}" which is not loaded on ${task.provider}. Dynamically auto-healing to live model "${liveModel}".`,
            );
            effectiveModel = liveModel;

            // Persist healed model to MongoDB asynchronously
            db.collection(COLLECTIONS.SCHEDULED_TASKS)
              .updateOne(
                { id: task.id },
                {
                  $set: {
                    model: effectiveModel,
                    updatedAt: new Date().toISOString(),
                  },
                },
              )
              .catch((err: unknown) =>
                logger.warn(
                  `[ScheduledTasks] Failed to update task ${task.id} with healed model: ${getErrorMessage(err)}`,
                ),
              );
          }
        }
      } catch (probeError) {
        logger.warn(
          `[ScheduledTasks] Failed to probe models on provider ${task.provider} for task "${task.name}": ${getErrorMessage(probeError)}`,
        );
      }
    }

    // 2. Create agent session stub document
    const settings = {
      provider: effectiveProvider,
      model: effectiveModel,
      agent: task.agent,
      workspaceRoot: workspacePath,
      toolConfig: task.toolConfig,
    };

    // Top-level `agent` is required for per-agent filtering in GET /conversations
    // (the user sidebar queries with ?agent=OMNI etc.). Without it, the
    // conversation only appears in the admin view which doesn't filter by agent.
    await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).insertOne({
      id: resolvedConversationId,
      project: task.project,
      username,
      title: task.name,
      agent: task.agent,
      taskId: task.id,
      messages: [userTriggerMessage],
      systemPrompt: "",
      settings,
      modalities: { textIn: true, textOut: false },
      providers: [effectiveProvider.toLowerCase()],
      totalCost: 0,
      isGenerating: true,
      createdAt: nowISO,
      updatedAt: nowISO,
    });

    const mockEmit = (event: SseEvent) => {
      logger.debug(`[ScheduledTasks][${task.name}][Event] type=${event.type}`);
    };

    // 3. Resolve provider and model definitions
    const provider = getProvider(effectiveProvider);
    const modelDefinition = getModelByName(effectiveModel);

    if (!provider) {
      throw new Error(`Provider not found: ${effectiveProvider}`);
    }

    // 4. Trigger AgenticLoopService
    try {
      await AgenticLoopService.runAgenticLoop({
        provider:
          provider as unknown as import("./harnesses/types.ts").LLMProvider,
        providerName: effectiveProvider,
        resolvedModel: effectiveModel,
        modelDefinition,
        messages: [userTriggerMessage as ConversationMessage],
        originalMessages: [userTriggerMessage as ConversationMessage],
        options: {
          agenticLoopEnabled: true,
          functionCallingEnabled: true,
          planFirst: false,
          autoApprove: true,
          ...(task.toolConfig?.enabledTools && {
            enabledTools: task.toolConfig.enabledTools,
          }),
          ...(task.toolConfig?.disabledTools && {
            disabledTools: task.toolConfig.disabledTools,
          }),
        },
        agentConversationId: resolvedConversationId,
        conversationId: resolvedConversationId,
        userMessage: userTriggerMessage as ConversationMessage,
        conversationMeta: {
          title: task.name,
          agent: task.agent,
          workspaceRoot: workspacePath,
          settings,
        },
        traceId,
        project: task.project,
        username,
        clientIp: "127.0.0.1",
        agent: task.agent,
        workspaceRoot: workspacePath,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: mockEmit,
      });

      logger.success(
        `[ScheduledTasks] Task "${task.name}" completed execution successfully.`,
      );
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks] Agent loop error for task "${task.name}": ${getErrorMessage(error)}`,
      );

      // Ensure the generated session is not stuck as "generating"
      await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateOne(
          { id: resolvedConversationId },
          {
            $set: { isGenerating: false, updatedAt: new Date().toISOString() },
          },
        )
        .catch((cleanupError: unknown) =>
          logger.warn(
            `[ScheduledTasks] Failed to reset isGenerating for conversation ${resolvedConversationId}: ${getErrorMessage(cleanupError)}`,
          ),
        );

      throw error;
    }

    return { agentConversationId: resolvedConversationId };
  },

  /**
   * Determine if a project name is a client UI project (vs a registered workspace
   * or agent project). Client projects skip project/username scoping in queries.
   */
  async _isClientProject(project: string): Promise<boolean> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!project || !db) return true;

    const workspaceExists = await db
      .collection(COLLECTIONS.WORKSPACES)
      .findOne({ name: project });
    if (workspaceExists) return false;

    const { default: AgentPersonaRegistry } =
      await import("./AgentPersonaRegistry.ts");
    const agentProjects = AgentPersonaRegistry.list()
      .map((entry) => {
        const persona = AgentPersonaRegistry.get(entry.id);
        return persona?.project;
      })
      .filter(Boolean);

    return !agentProjects.includes(project);
  },

  async _getQueryFilter(
    id: string,
    project: string,
    username: string,
  ): Promise<Record<string, unknown>> {
    const isClientProject = await this._isClientProject(project);

    const filter: Record<string, unknown> = { id };
    if (!isClientProject) {
      filter.project = project;
    }
    if (
      username &&
      username !== "any" &&
      username !== "all" &&
      !isClientProject
    ) {
      filter.username = username;
    }
    return filter;
  },

  async listTasks(project: string, username: string): Promise<ScheduledTask[]> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return [];

    const isClientProject = await this._isClientProject(project);

    const query: Record<string, unknown> = {};
    if (!isClientProject) {
      query.project = project;
    }
    if (
      username &&
      username !== "any" &&
      username !== "all" &&
      !isClientProject
    ) {
      query.username = username;
    }

    return (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray()) as unknown as ScheduledTask[];
  },

  async listAllTasks(): Promise<ScheduledTask[]> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return [];

    return (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .find({})
      .sort({ createdAt: -1 })
      .toArray()) as unknown as ScheduledTask[];
  },

  async createTask(
    data: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt"> & {
      username: string;
    },
  ): Promise<ScheduledTask> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const nowISO = new Date().toISOString();
    const task: ScheduledTask = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: nowISO,
      updatedAt: nowISO,
    };

    await db.collection(COLLECTIONS.SCHEDULED_TASKS).insertOne(task);
    return task;
  },

  async updateTask(
    id: string,
    project: string,
    username: string,
    updates: Partial<ScheduledTask>,
  ): Promise<ScheduledTask> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const nowISO = new Date().toISOString();
    const cleanUpdates: Record<string, unknown> = {
      ...updates,
      updatedAt: nowISO,
    };
    delete cleanUpdates.id;
    delete cleanUpdates.createdAt;

    const filter = await this._getQueryFilter(id, project, username);
    const result = await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .findOneAndUpdate(
        filter,
        { $set: cleanUpdates },
        { returnDocument: "after" },
      );

    if (!result) {
      throw new Error(`Scheduled Task not found: ${id}`);
    }

    return result as unknown as ScheduledTask;
  },

  async deleteTask(
    id: string,
    project: string,
    username: string,
  ): Promise<boolean> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const filter = await this._getQueryFilter(id, project, username);
    let result = await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .deleteOne(filter);
    if ((result.deletedCount ?? 0) === 0) {
      const nameFilter = { ...filter };
      delete nameFilter.id;
      nameFilter.name = id;
      result = await db
        .collection(COLLECTIONS.SCHEDULED_TASKS)
        .deleteOne(nameFilter);
    }
    return (result.deletedCount ?? 0) > 0;
  },

  async triggerTask(
    id: string,
    project: string,
    username: string,
    payload?: Record<string, unknown>,
  ): Promise<{ success: boolean; agentConversationId: string }> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not connected");

    const filter = await this._getQueryFilter(id, project, username);
    let task = (await db
      .collection(COLLECTIONS.SCHEDULED_TASKS)
      .findOne(filter)) as unknown as ScheduledTask;
    if (!task) {
      // Fallback: look up by name
      const nameFilter = { ...filter };
      delete nameFilter.id;
      nameFilter.name = id;
      task = (await db
        .collection(COLLECTIONS.SCHEDULED_TASKS)
        .findOne(nameFilter)) as unknown as ScheduledTask;
    }
    if (!task) {
      throw new Error(`Scheduled Task not found: ${id}`);
    }

    const agentConversationId = crypto.randomUUID();

    // Fire-and-forget background execution with the pre-generated conversation ID
    this.executeTask({ ...task, id: task.id }, payload, {
      username,
      agentConversationId,
    }).catch((error: unknown) => {
      logger.error(
        `[ScheduledTasks] Manual trigger failed for task "${task.name}": ${getErrorMessage(error)}`,
      );
    });

    return { success: true, agentConversationId };
  },
};

export default ScheduledTaskService;
