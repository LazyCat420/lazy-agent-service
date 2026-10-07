import SettingsService from "../SettingsService.js";
export async function getSubAgentFallback() {
    try {
        const agents = await SettingsService.getSection("agents");
        if (agents) {
            const provider = agents.subAgentProvider || agents.subagentProvider;
            const model = agents.subAgentModel || agents.subagentModel;
            if (typeof provider === "string" && typeof model === "string") {
                return { provider, model };
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=SubAgentFallback.js.map