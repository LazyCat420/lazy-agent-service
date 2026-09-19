export interface AgentProfile {
  id: string;
  systemPrompt: string;
  defaultModel: string;
  baseTools: string[];
}

const MOCK_PROFILES: Record<string, AgentProfile> = {
  "trading-analyst": {
    id: "trading-analyst",
    systemPrompt: "You are a financial analyst...",
    defaultModel: "qwen-coder-32b",
    baseTools: ["mcp__lazy-tool-service__get_price"]
  },
  "html-notes-writer": {
    id: "html-notes-writer",
    systemPrompt: "You write HTML notes...",
    defaultModel: "llama-3-8b",
    baseTools: ["mcp__lazy-tool-service__write_note"]
  }
};

export class ProfileRegistry {
  private static dynamicProfiles: Map<string, AgentProfile> = new Map();

  static async loadProfile(profileId: string): Promise<AgentProfile | null> {
    if (this.dynamicProfiles.has(profileId)) {
      return this.dynamicProfiles.get(profileId)!;
    }
    return MOCK_PROFILES[profileId] || null;
  }

  static registerProfile(profile: AgentProfile): void {
    this.dynamicProfiles.set(profile.id, profile);
  }

  static clear(): void {
    this.dynamicProfiles.clear();
  }
}
