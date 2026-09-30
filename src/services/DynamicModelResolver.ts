import logger from "../utils/logger.ts";
import { getInstancesByType } from "../providers/instance-registry.ts";
import { getProvider } from "../providers/index.ts";

export interface HostModelStatus {
  instanceId: string;
  baseUrl: string;
  nickname: string;
  models: string[];
  online: boolean;
}

export class DynamicModelResolver {
  private static cachedStatuses: HostModelStatus[] = [];
  private static lastProbeTime = 0;
  private static readonly PROBE_CACHE_TTL_MS = 5000; // 5 seconds cache
  private static mockStatuses: HostModelStatus[] | null = null;

  /**
   * For testing: stub host model statuses
   */
  public static setMockStatuses(statuses: HostModelStatus[] | null) {
    this.mockStatuses = statuses;
    if (statuses) {
      this.cachedStatuses = statuses;
      this.lastProbeTime = Date.now();
    }
  }

  /**
   * Query all online local instances (Jetson, Gold Spark) in real time
   */
  public static async queryLiveHosts(force = false): Promise<HostModelStatus[]> {
    if (this.mockStatuses) return this.mockStatuses;

    const now = Date.now();
    if (!force && this.cachedStatuses.length > 0 && now - this.lastProbeTime < this.PROBE_CACHE_TTL_MS) {
      return this.cachedStatuses;
    }

    const instances = getInstancesByType("vllm");
    const results = await Promise.allSettled(
      instances.map(async (inst) => {
        try {
          const provider = getProvider(inst.id);
          if (!provider?.listModels) {
            return {
              instanceId: inst.id,
              baseUrl: inst.baseUrl,
              nickname: inst.nickname || inst.id,
              models: [],
              online: false,
            };
          }

          const res = await Promise.race([
            provider.listModels(),
            new Promise<any>((_, reject) =>
              setTimeout(() => reject(new Error("Probe timeout")), 2500),
            ),
          ]);

          const rawModels = res?.models || res?.data || [];
          const models: string[] = rawModels
            .map((m: any) => m.key || m.id || "")
            .filter(Boolean);
          return {
            instanceId: inst.id,
            baseUrl: inst.baseUrl,
            nickname: inst.nickname || inst.id,
            models,
            online: models.length > 0,
          };
        } catch {
          return {
            instanceId: inst.id,
            baseUrl: inst.baseUrl,
            nickname: inst.nickname || inst.id,
            models: [],
            online: false,
          };
        }
      }),
    );

    this.cachedStatuses = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            instanceId: instances[i].id,
            baseUrl: instances[i].baseUrl,
            nickname: instances[i].nickname || instances[i].id,
            models: [],
            online: false,
          },
    );
    this.lastProbeTime = now;
    return this.cachedStatuses;
  }

  public static getCachedLiveHosts(): HostModelStatus[] {
    return this.mockStatuses || this.cachedStatuses;
  }

  /**
   * Check if a model is served on an allowed provider for a profile.
   * If only one box is online, that single online box absorbs all jobs!
   */
  public static isModelAllowedForProfile(
    modelName: string,
    allowedProviders: string[],
    role: string,
  ): { allowed: boolean; hostInstance?: string; reason?: string } {
    const statuses = this.getCachedLiveHosts();
    const onlineHosts = statuses.filter((h) => h.online);

    if (onlineHosts.length === 0) {
      return { allowed: false, reason: "No local model instances are online" };
    }

    // Single-box fallback: If only one box is online, it does all jobs
    if (onlineHosts.length === 1) {
      const singleHost = onlineHosts[0];
      if (singleHost.models.includes(modelName)) {
        return { allowed: true, hostInstance: singleHost.instanceId };
      }
      return {
        allowed: false,
        reason: `Model '${modelName}' not found on single online host (${singleHost.instanceId})`,
      };
    }

    // Both (or multiple) boxes online:
    // Check if the model is on any host matching allowedProviders
    for (const host of onlineHosts) {
      if (allowedProviders.includes(host.instanceId) && host.models.includes(modelName)) {
        return { allowed: true, hostInstance: host.instanceId };
      }
    }

    return {
      allowed: false,
      reason: `Model '${modelName}' not found on any allowed online host (${allowedProviders.join(", ")})`,
    };
  }

  /**
   * Resolve provider and model for a run based on user mapping rules:
   * - Gold Spark (vllm-2) = smart/large roles
   * - Jetson (vllm) = light/small roles
   * - Single-box fallback = whichever is online
   */
  public static resolveProviderAndModel(
    role: string,
    allowedProviders: string[],
    requestedModel?: string,
    requestedProvider?: string,
  ): { provider: string; model: string } {
    const statuses = this.getCachedLiveHosts();
    const onlineHosts = statuses.filter((h) => h.online);

    // If requestedProvider is explicitly supplied and online, use it
    if (requestedProvider) {
      const match = onlineHosts.find((h) => h.instanceId === requestedProvider);
      if (match) {
        if (requestedModel && match.models.includes(requestedModel)) {
          return { provider: requestedProvider, model: requestedModel };
        }
        if (match.models.length > 0) {
          return { provider: requestedProvider, model: requestedModel || match.models[0] };
        }
      }
    }

    // If requestedModel is supplied, find which online host serves it
    if (requestedModel) {
      const match = onlineHosts.find((h) => h.models.includes(requestedModel));
      if (match) {
        return { provider: match.instanceId, model: requestedModel };
      }
    }

    // Single-box fallback: If only 1 box is online, it does all jobs
    if (onlineHosts.length === 1) {
      const single = onlineHosts[0];
      return {
        provider: single.instanceId,
        model: requestedModel || single.models[0] || "default-model",
      };
    }

    // Role-based tiering when both are online:
    // Light/small roles prefer Jetson (vllm); smart/large roles prefer Gold Spark (vllm-2)
    const isLightRole = ["junior", "collector", "scout", "summarizer", "bull", "bear"].some((k) =>
      role.toLowerCase().includes(k),
    );
    const preferredInstanceId = isLightRole ? "vllm" : "vllm-2";
    const preferredHost = onlineHosts.find((h) => h.instanceId === preferredInstanceId);
    if (preferredHost && preferredHost.models.length > 0) {
      return {
        provider: preferredInstanceId,
        model: requestedModel || preferredHost.models[0],
      };
    }

    // Fallback to whichever allowed provider is online
    for (const provId of allowedProviders) {
      const host = onlineHosts.find((h) => h.instanceId === provId);
      if (host && host.models.length > 0) {
        return {
          provider: provId,
          model: requestedModel || host.models[0],
        };
      }
    }

    // Default fallback
    return {
      provider: allowedProviders[0] || "vllm-2",
      model: requestedModel || "default-model",
    };
  }
}
