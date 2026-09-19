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
  static async loadProfile(profileId: string): Promise<AgentProfile | null> {
    // Mock implementation for the contract
    return MOCK_PROFILES[profileId] || null;
  }
}
