import logger from "../../utils/logger.js";
/**
 * Synchronous per-instance reservation counter.
 * Prevents race conditions when multiple team_create calls fire concurrently
 * via Promise.all — each spawn increments the counter immediately at selection
 * time, so the next spawn sees the correct active count.
 * Keyed by instance id (provider name).
 */
const instanceReservations = new Map();
export class InstanceLoadBalancer {
    static getActiveOn(instanceId, activeSubAgents) {
        const reserved = instanceReservations.get(instanceId) || 0;
        const running = [...activeSubAgents.values()].filter((subAgent) => subAgent.providerName === instanceId && subAgent.status === "running").length;
        return reserved + running;
    }
    static selectAndReserveInstance(siblings, orchestratorInstanceId, instanceModelOverrides, defaultModel, activeSubAgents) {
        // Debug: log the full instance state for tracing assignment decisions
        const stateSnapshot = siblings
            .map((sibling) => {
            const active = InstanceLoadBalancer.getActiveOn(sibling.id, activeSubAgents);
            return `${sibling.id}(concurrency=${sibling.concurrency}, active=${active}, free=${sibling.concurrency - active})`;
        })
            .join(", ");
        logger.info(`[Orchestrator] selectAndReserveInstance: siblings=[${stateSnapshot}], orchestrator=${orchestratorInstanceId}`);
        // Least-connections strategy: always pick the instance with the lowest load
        // normalized by capacity (active / concurrency). This distributes work
        // evenly across heterogeneous hardware instead of saturating one
        // device before touching the next.
        //
        // Tie-breaking: when multiple instances have equal load:
        // 1. Prefer the orchestrator's own instance (its inference is IDLE
        //    while sub-agents run, so its slots are effectively free).
        // 2. Prefer the instance with higher concurrency limit.
        let bestInstance = null;
        let lowestLoad = Infinity;
        for (const instance of siblings) {
            const active = InstanceLoadBalancer.getActiveOn(instance.id, activeSubAgents);
            const load = active / instance.concurrency;
            const isOrchestrator = instance.id === orchestratorInstanceId;
            const isBestOrchestrator = bestInstance?.id === orchestratorInstanceId;
            if (load < lowestLoad ||
                (load === lowestLoad && ((isOrchestrator && !isBestOrchestrator) ||
                    (isOrchestrator === isBestOrchestrator && instance.concurrency > (bestInstance?.concurrency || 0))))) {
                lowestLoad = load;
                bestInstance = instance;
            }
        }
        const bestAvailable = bestInstance
            ? bestInstance.concurrency - InstanceLoadBalancer.getActiveOn(bestInstance.id, activeSubAgents)
            : -Infinity;
        if (bestInstance && bestAvailable <= 0) {
            logger.info(`[Orchestrator] selectAndReserveInstance: all at capacity — overflow to ${bestInstance.id} (active=${bestInstance.concurrency - bestAvailable}, overload=+${-bestAvailable + 1})`);
        }
        if (!bestInstance) {
            logger.info(`[Orchestrator] selectAndReserveInstance: no instances available`);
            return null;
        }
        const activeCountForSelected = InstanceLoadBalancer.getActiveOn(bestInstance.id, activeSubAgents);
        const available = bestInstance.concurrency - activeCountForSelected;
        // Increment reservation synchronously so the next call sees it
        instanceReservations.set(bestInstance.id, (instanceReservations.get(bestInstance.id) || 0) + 1);
        // Apply quant fallback model if the selected instance has an override
        const model = instanceModelOverrides.get(bestInstance.id) || defaultModel;
        return { provider: bestInstance.id, model, slotsAvailable: available };
    }
    static releaseReservation(instanceId) {
        const currentReservations = instanceReservations.get(instanceId) || 0;
        if (currentReservations > 0) {
            instanceReservations.set(instanceId, currentReservations - 1);
        }
    }
    static getReservations() {
        return instanceReservations;
    }
}
//# sourceMappingURL=InstanceLoadBalancer.js.map