/**
 * SomaticStateService — emotion classification from model output, message
 * extraction, keyword stat effects and the rendered mood block. Mongo, the
 * emotion model provider and the request logger are fakes; the somatic state
 * engine, stat factory and prompt locale service are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getSomaticModelConfig: vi.fn(),
  getCached: vi.fn(),
  getProvider: vi.fn(),
  logBackgroundLlmCall: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../SettingsService.ts", () => ({
  default: {
    getSomaticModelConfig: fakes.getSomaticModelConfig,
    getCached: fakes.getCached,
  },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getCollection: () => null },
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: fakes.logBackgroundLlmCall },
}));

import SomaticStateService from "../somatic/SomaticStateService.ts";
import type { PrimaryEmotion } from "../somatic/SomaticConstants.ts";

let agentCounter = 0;
const nextAgentId = () => `somatic-agent-${++agentCounter}`;

beforeEach(() => {
  vi.clearAllMocks();
  fakes.getSomaticModelConfig.mockResolvedValue({
    provider: "vllm",
    model: "emotion-model",
  });
  fakes.getCached.mockReturnValue({ agents: { locale: "en" } });
  fakes.getProvider.mockReturnValue({ generateText: fakes.generateText });
  fakes.generateText.mockResolvedValue({ text: "neutral" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("adaptFromMessage — emotion classification", () => {
  it("ignores empty text without creating agent state", async () => {
    const agentId = nextAgentId();
    await SomaticStateService.adaptFromMessage(agentId, "");
    expect(SomaticStateService.hasAgent(agentId)).toBe(false);
  });

  it("stays neutral when no emotion model is configured", async () => {
    fakes.getSomaticModelConfig.mockResolvedValue(null);
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "I am furious about this");

    expect(fakes.generateText).not.toHaveBeenCalled();
    expect((await SomaticStateService.getDominantEmotion(agentId)).emotion).toBe(
      "neutral",
    );
  });

  it("applies an exact emotion word returned by the model", async () => {
    fakes.generateText.mockResolvedValue({ text: "  JOY  " });
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "great news");

    const dominant = await SomaticStateService.getDominantEmotion(agentId);
    expect(dominant.emotion).toBe("joy");
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "somatic:emotion-analysis",
        agent: agentId,
        success: true,
        extraResponsePayload: { detectedEmotion: "joy" },
      }),
    );
  });

  it("strips punctuation from short responses", async () => {
    fakes.generateText.mockResolvedValue({ text: "**sadness**" });
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "bad news");
    expect((await SomaticStateService.getDominantEmotion(agentId)).emotion).toBe(
      "sadness",
    );
  });

  it("scans longer sentences for a boundary emotion word", async () => {
    fakes.generateText.mockResolvedValue({
      text: "The writer sounds full of surprise in this passage.",
    });
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "what happened?");
    expect((await SomaticStateService.getDominantEmotion(agentId)).emotion).toBe(
      "surprise",
    );
  });

  it("defaults to neutral for an unrecognized classification", async () => {
    fakes.generateText.mockResolvedValue({ text: "unclear mumble" });
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "hello");
    expect((await SomaticStateService.getDominantEmotion(agentId)).emotion).toBe(
      "neutral",
    );
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("stays neutral when the model call fails", async () => {
    fakes.generateText.mockRejectedValue(new Error("model offline"));
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "hello there");

    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: "model offline",
      }),
    );
    expect((await SomaticStateService.getDominantEmotion(agentId)).emotion).toBe(
      "neutral",
    );
  });

  it("stays neutral when the model returns no text", async () => {
    fakes.generateText.mockResolvedValue({ text: "" });
    const agentId = nextAgentId();

    await SomaticStateService.adaptFromMessage(agentId, "hello");
    expect((await SomaticStateService.getDominantEmotion(agentId)).emotion).toBe(
      "neutral",
    );
  });

  it("extracts the last message_content block from Discord text", async () => {
    fakes.generateText.mockResolvedValue({ text: "joy" });
    const agentId = nextAgentId();
    await SomaticStateService.setPhysicalStatLevel(agentId, "energy", 50);

    await SomaticStateService.adaptFromMessage(
      agentId,
      "<message_content>ignore this</message_content>\n<message_content>  time to sleep <@12345>  </message_content>",
    );

    // Homeostatic drift adds 2 energy, then the "sleep" keyword adds 1 more.
    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "energy")).toBe(
      53,
    );
  });
});

describe("adaptFromMessage — keyword stat effects", () => {
  it("lowers energy for work keywords", async () => {
    const agentId = nextAgentId();
    await SomaticStateService.setPhysicalStatLevel(agentId, "energy", 100);

    await SomaticStateService.adaptFromMessage(agentId, "back to coding now");

    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "energy")).toBe(
      99,
    );
  });

  it("applies the extra bathroom effect for drinks", async () => {
    const agentId = nextAgentId();
    await SomaticStateService.setPhysicalStatLevel(agentId, "thirst", 50);
    await SomaticStateService.setPhysicalStatLevel(agentId, "bathroom", 0);

    await SomaticStateService.adaptFromMessage(agentId, "time for a big glass of water");

    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "thirst")).toBe(
      49,
    );
    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "bathroom")).toBe(
      1,
    );
  });

  it("raises sickness for illness keywords", async () => {
    const agentId = nextAgentId();
    await SomaticStateService.setPhysicalStatLevel(agentId, "sickness", 0);

    await SomaticStateService.adaptFromMessage(agentId, "I feel sick and nauseous");

    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "sickness")).toBe(
      10,
    );
  });
});

describe("renderSystemMessage", () => {
  const render = async (emotion: PrimaryEmotion, intensity: number) => {
    const agentId = nextAgentId();
    await SomaticStateService.addEmotion(agentId, emotion, intensity);
    const block = await SomaticStateService.renderSystemMessage(agentId);
    return { agentId, block };
  };

  it("renders every physical stat with its label and max", async () => {
    const { block } = await render("joy", 10);

    expect(block).not.toBeNull();
    expect(block).toContain("- Hunger: Satisfied (0/100)");
    expect(block).toContain("- Thirst: Quenched (0/100)");
    expect(block).toContain("- Energy: Energized (100/100)");
    expect(block).toContain("- Sickness: Healthy (0/100)");
    expect(block).toContain("- Alcohol: Sober (0/10)");
    expect(block).toContain("- Substance: Sober (0/10)");
    expect(block).toContain("- Bathroom: Fine (0/100)");
    expect(block).toContain("- Joy:");
  });

  it("brackets the intensity into MILD, MODERATE, STRONG and OVERWHELMING", async () => {
    const mild = await render("joy", 10);
    expect(mild.block).toContain("MILD");
    expect(mild.block).toContain("JOY");

    const moderate = await render("joy", 30);
    expect(moderate.block).toContain("MODERATE");

    const strong = await render("joy", 60);
    expect(strong.block).toContain("STRONG");

    const overwhelming = await render("joy", 95);
    expect(overwhelming.block).toContain("OVERWHELMING");
  });

  it("honours an explicit locale", async () => {
    const agentId = nextAgentId();
    await SomaticStateService.addEmotion(agentId, "fear", 40);

    const block = await SomaticStateService.renderSystemMessage(agentId, "en");
    expect(block).toContain("FEAR");
    expect(block).toContain("MODERATE");
  });
});

describe("snapshot and stat helpers", () => {
  it("reports all physical levels and a zeroed emotion for a fresh agent", async () => {
    const agentId = nextAgentId();
    const snapshot = await SomaticStateService.getSnapshot(agentId);

    expect(snapshot.emotion.dominant).toBe("neutral");
    expect(snapshot.energy.level).toBe(100);
    expect(snapshot.hunger.level).toBe(0);
    expect(snapshot.alcohol.level).toBe(0);
  });

  it("clamps stat levels to their configured bounds", async () => {
    const agentId = nextAgentId();

    await SomaticStateService.setPhysicalStatLevel(agentId, "hunger", 500);
    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "hunger")).toBe(
      100,
    );

    await SomaticStateService.setPhysicalStatLevel(agentId, "alcohol", 50);
    expect(await SomaticStateService.getPhysicalStatLevel(agentId, "alcohol")).toBe(
      10,
    );
  });

  it("exposes mood aliases and removes agents on destroy", async () => {
    const agentId = nextAgentId();
    await SomaticStateService.addEmotion(agentId, "anger", 50);

    expect(
      await SomaticStateService.getStatLevel(agentId, "emotion"),
    ).toBeGreaterThanOrEqual(50);
    expect(await SomaticStateService.setStatLevel(agentId, "mood", 7)).toBe(7);

    expect(SomaticStateService.getLoadedAgentIds()).toContain(agentId);
    await SomaticStateService.destroyAgent(agentId);
    expect(SomaticStateService.hasAgent(agentId)).toBe(false);
  });
});
