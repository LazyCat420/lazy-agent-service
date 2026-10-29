import { createLogger } from "@rodrigo-barraza/utilities-library/node";
import { getRequestContext } from "./RequestContext.js";
const base = createLogger("lazy-agent");
function buildContextTags(project, username, clientIp) {
    const hasProject = project && project !== "any";
    const hasUser = username && username !== "any";
    let identityTag = "";
    if (hasProject && hasUser) {
        identityTag = ` [${project}/${username}]`;
    }
    else if (hasProject) {
        identityTag = ` [${project}]`;
    }
    else if (hasUser) {
        identityTag = ` [${username}]`;
    }
    const ipTag = clientIp ? ` (${clientIp})` : "";
    return `${identityTag}${ipTag}`;
}
const logger = {
    ...base,
    provider(provider, action, ...args) {
        const context = getRequestContext();
        const tags = buildContextTags(context.project, context.username, context.clientIp);
        base.info(`[${provider}] ${action}${tags}`, ...args);
    },
    request(project, username, clientIp, message, ...args) {
        const tags = buildContextTags(project, username, clientIp);
        base.info(`${message}${tags}`, ...args);
    },
};
export default logger;
//# sourceMappingURL=logger.js.map