export function getGlobalToolOrchestratorService() {
    const service = globalThis.__ToolOrchestratorService;
    if (!service) {
        throw new Error("ToolOrchestratorService not registered on globalThis");
    }
    return service;
}
export function registerGlobalToolOrchestratorService(service) {
    globalThis.__ToolOrchestratorService = service;
}
//# sourceMappingURL=GlobalToolOrchestratorRegistry.js.map