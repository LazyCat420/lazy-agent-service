/** Trusted server registrations only; requests cannot install or bypass a guard. */
export class RuntimeExtensions {
    static registered = new Map();
    static register(name, extension) { this.registered.set(name, extension); }
    static resolve(profile) {
        const groups = profile.plugins || {};
        for (const [kind, names] of Object.entries(groups)) {
            for (const name of names || []) {
                const extension = this.registered.get(name);
                const valid = extension && (kind === "context_contributors" ? extension.context : kind === "verifiers" ? extension.validate : kind === "worker_plugins" ? extension.worker : false);
                if (!valid)
                    throw Object.assign(new Error(`Required ${kind} extension '${name}' is unavailable`), { code: "PROFILE_NOT_READY" });
            }
        }
        return [...new Set(Object.values(groups).flat())].map(name => this.registered.get(name));
    }
    static workers(profile) {
        return (profile.plugins?.worker_plugins || []).map(name => this.registered.get(name).worker);
    }
}
//# sourceMappingURL=RuntimeExtensions.js.map