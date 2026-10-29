import { describe, expect, it } from "vitest";
import SomaticStateService from "../../services/somatic/SomaticStateService.ts";

/**
 * Pins the keyword→stat table in SomaticStateService.adaptFromMessage:
 * each message is fed through the real service, and the exact physical
 * stat levels are compared before and after. Homeostatic drift runs first
 * inside adaptFromMessage (energy +2 when below 100), so the rest-case
 * expectation includes that drift on top of the keyword delta.
 */

type PhysicalLevels = {
  hunger: number;
  thirst: number;
  energy: number;
  sickness: number;
  alcohol: number;
  substance: number;
  bathroom: number;
};

async function levelsOf(agentId: string): Promise<PhysicalLevels> {
  const snapshot = await SomaticStateService.getSnapshot(agentId);
  return {
    hunger: snapshot.hunger.level,
    thirst: snapshot.thirst.level,
    energy: snapshot.energy.level,
    sickness: snapshot.sickness.level,
    alcohol: snapshot.alcohol.level,
    substance: snapshot.substance.level,
    bathroom: snapshot.bathroom.level,
  };
}

let agentSequence = 0;

/** Fresh agent id per case: agent states are cached process-wide by id. */
function freshAgentId(label: string): string {
  agentSequence += 1;
  return `somatic-keyword-test-${label}-${process.pid}-${agentSequence}`;
}

describe("SomaticStateService keyword effects", () => {
  it("food keyword: hunger -1 and bathroom +1", async () => {
    const agentId = freshAgentId("food");
    await SomaticStateService.setPhysicalStatLevel(agentId, "hunger", 50);
    const before = await levelsOf(agentId);

    await SomaticStateService.adaptFromMessage(agentId, "pizza for dinner");

    expect(before).toEqual({
      hunger: 50,
      thirst: 0,
      energy: 100,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 0,
    });
    expect(await levelsOf(agentId)).toEqual({
      hunger: 49,
      thirst: 0,
      energy: 100,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 1,
    });
  });

  it("drink keyword: thirst -1 and bathroom +1", async () => {
    const agentId = freshAgentId("drink");
    await SomaticStateService.setPhysicalStatLevel(agentId, "thirst", 50);
    const before = await levelsOf(agentId);

    await SomaticStateService.adaptFromMessage(agentId, "a glass of water");

    expect(before).toEqual({
      hunger: 0,
      thirst: 50,
      energy: 100,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 0,
    });
    expect(await levelsOf(agentId)).toEqual({
      hunger: 0,
      thirst: 49,
      energy: 100,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 1,
    });
  });

  it("rest keyword: energy +1 on top of the +2 homeostatic drift", async () => {
    const agentId = freshAgentId("rest");
    await SomaticStateService.setPhysicalStatLevel(agentId, "energy", 50);
    const before = await levelsOf(agentId);

    await SomaticStateService.adaptFromMessage(agentId, "time to sleep");

    expect(before).toEqual({
      hunger: 0,
      thirst: 0,
      energy: 50,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 0,
    });
    expect(await levelsOf(agentId)).toEqual({
      hunger: 0,
      thirst: 0,
      energy: 53,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 0,
    });
  });

  it("neutral message: only the +2 homeostatic energy drift, no keyword effect", async () => {
    const agentId = freshAgentId("neutral");
    await SomaticStateService.setPhysicalStatLevel(agentId, "hunger", 50);
    await SomaticStateService.setPhysicalStatLevel(agentId, "thirst", 50);
    await SomaticStateService.setPhysicalStatLevel(agentId, "energy", 50);
    const before = await levelsOf(agentId);

    await SomaticStateService.adaptFromMessage(agentId, "hello there, nice to meet you");

    expect(before).toEqual({
      hunger: 50,
      thirst: 50,
      energy: 50,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 0,
    });
    expect(await levelsOf(agentId)).toEqual({
      hunger: 50,
      thirst: 50,
      energy: 52,
      sickness: 0,
      alcohol: 0,
      substance: 0,
      bathroom: 0,
    });
  });
});
