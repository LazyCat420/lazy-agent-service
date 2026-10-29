import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import ScheduledTaskService from "../services/ScheduledTaskService.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { PROVIDERS } from "../constants.js";
import { MODELS } from "../config.js";
const router = express.Router();
/**
 * GET /scheduled-tasks
 * Returns the list of configured scheduled tasks for the current project & user.
 */
router.get("/", asyncHandler(async (req, res) => {
    const project = typeof req.project === "string" ? req.project : "direct";
    const username = typeof req.username === "string" ? req.username : "system";
    try {
        const tasks = await ScheduledTaskService.listTasks(project, username);
        res.json(tasks);
    }
    catch (error) {
        logger.error(`[ScheduledTasks][GET] Error listing tasks: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to list scheduled tasks" });
    }
}));
/**
 * GET /scheduled-tasks/all
 * Returns ALL scheduled tasks across every project and user (admin use).
 */
router.get("/all", asyncHandler(async (_req, res) => {
    try {
        const tasks = await ScheduledTaskService.listAllTasks();
        res.json(tasks);
    }
    catch (error) {
        logger.error(`[ScheduledTasks][GET /all] Error listing all tasks: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to list all scheduled tasks" });
    }
}));
/**
 * POST /scheduled-tasks
 * Creates a new scheduled task.
 */
router.post("/", asyncHandler(async (req, res) => {
    const project = typeof req.project === "string" ? req.project : "direct";
    const username = typeof req.username === "string" ? req.username : "system";
    let { name, prompt, agent, provider, model, scheduleType, scheduleTime, scheduleDay, scheduleDate, cronExpression, recurrenceRule, toolConfig, } = req.body;
    provider = provider || PROVIDERS.ANTHROPIC;
    model = model || MODELS.SONNET_45.name;
    if (!name || !prompt || !provider || !model || !scheduleType) {
        return res.status(400).json({
            error: "Missing required fields: name, prompt, provider, model, scheduleType",
        });
    }
    try {
        const task = await ScheduledTaskService.createTask({
            name,
            prompt,
            agent: agent || null,
            provider,
            model,
            scheduleType,
            scheduleTime,
            scheduleDay,
            scheduleDate,
            cronExpression,
            recurrenceRule,
            toolConfig,
            enabled: true,
            project: project,
            username: username,
        });
        res.status(201).json(task);
    }
    catch (error) {
        logger.error(`[ScheduledTasks][POST] Error creating task: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to create scheduled task" });
    }
}));
/**
 * PATCH /scheduled-tasks/:id
 * Updates an existing scheduled task (e.g. changing fields or toggling enablement).
 */
router.patch("/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const project = typeof req.project === "string" ? req.project : "direct";
    const username = typeof req.username === "string" ? req.username : "system";
    const updates = req.body;
    try {
        const updatedTask = await ScheduledTaskService.updateTask(id, project, username, updates);
        res.json(updatedTask);
    }
    catch (error) {
        logger.error(`[ScheduledTasks][PATCH] Error updating task ${id}: ${getErrorMessage(error)}`);
        res.status(500).json({
            error: getErrorMessage(error) || "Failed to update scheduled task",
        });
    }
}));
/**
 * DELETE /scheduled-tasks/:id
 * Deletes a scheduled task.
 */
router.delete("/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const project = typeof req.project === "string" ? req.project : "direct";
    const username = typeof req.username === "string" ? req.username : "system";
    try {
        const success = await ScheduledTaskService.deleteTask(id, project, username);
        res.json({ success });
    }
    catch (error) {
        logger.error(`[ScheduledTasks][DELETE] Error deleting task ${id}: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to delete scheduled task" });
    }
}));
/**
 * POST /scheduled-tasks/:id/trigger
 * Triggers a scheduled task manually in the background immediately.
 */
router.post("/:id/trigger", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const project = typeof req.project === "string" ? req.project : "direct";
    const username = typeof req.username === "string" ? req.username : "system";
    const { payload } = req.body;
    try {
        const result = await ScheduledTaskService.triggerTask(id, project, username, payload);
        res.json(result);
    }
    catch (error) {
        logger.error(`[ScheduledTasks][TRIGGER] Error triggering task ${id}: ${getErrorMessage(error)}`);
        res.status(500).json({
            error: getErrorMessage(error) || "Failed to trigger scheduled task",
        });
    }
}));
export default router;
//# sourceMappingURL=ScheduledTasksRoutes.js.map