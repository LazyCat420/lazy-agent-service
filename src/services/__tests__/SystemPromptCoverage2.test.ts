/**
 * System-prompt assembly — directory tree formatting, platform/runtime context
 * collection inside assemble(), and skill relevance scoring. Mongo, the tools
 * service HTTP endpoint, tool orchestration, personas and embeddings are fakes;
 * locale lookups and formatting run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getDb: vi.fn(),
  getSection: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  ensureSchemas: vi.fn(),
  getClientToolSchemas: vi.fn(),
  resolveLockedOffToolNames: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: fakes.getDb, getCollection: () => null },
}));
vi.mock("../SettingsService.ts", () => ({
  default: { getSection: fakes.getSection },
}));
vi.mock("../ToolOrchestratorService.ts", () => ({
  default: {
    getWorkspaceRoot: fakes.getWorkspaceRoot,
    ensureSchemas: fakes.ensureSchemas,
    getClientToolSchemas: fakes.getClientToolSchemas,
  },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({ default: { get: () => null } }));
vi.mock("../../utils/resolveLockedOffToolNames.ts", () => ({
  resolveLockedOffToolNames: fakes.resolveLockedOffToolNames,
}));
vi.mock("../EmbeddingService.ts", () => ({ default: { generate: fakes.generate } }));

import { DirectoryTreeFormatter } from "../system-prompt/DirectoryTreeFormatter.ts";
import SystemPromptAssembler from "../system-prompt/index.ts";
import { SkillMemoryScorer } from "../system-prompt/SkillMemoryScorer.ts";
import type { AssemblerContext } from "../system-prompt/types.ts";

beforeEach(() => {
  vi.clearAllMocks();
  fakes.getSection.mockResolvedValue({ locale: "en", topology: "default" });
  fakes.getWorkspaceRoot.mockReturnValue("/workspace");
  fakes.ensureSchemas.mockResolvedValue(undefined);
  fakes.getClientToolSchemas.mockReturnValue([]);
  fakes.resolveLockedOffToolNames.mockResolvedValue(new Set());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DirectoryTreeFormatter.fetchDirectoryTree", () => {
  it("formats directories, files and their children", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          entries: [
            { type: "directory", name: "src", children: [{ type: "file", name: "a.ts" }] },
            { type: "file", name: "README.md" },
            { type: "file", path: "fallback/path.txt" },
            { type: "directory", path: "no-name-dir" },
          ],
        }),
      })),
    );

    const formatter = new DirectoryTreeFormatter("/workspace");
    const tree = await formatter.fetchDirectoryTree();

    expect(tree).toBe(
      [
        "📁 src",
        "  📄 a.ts",
        "📄 README.md",
        "📄 fallback/path.txt",
        "📁 no-name-dir",
      ].join("\n"),
    );
  });

  it("caps children at 20 and reports the remainder", async () => {
    const children = Array.from({ length: 25 }, (_, index) => ({
      type: "file",
      name: `file-${index}.ts`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ entries: [{ type: "directory", name: "many", children }] }),
      })),
    );

    const tree = await new DirectoryTreeFormatter("/workspace").fetchDirectoryTree();

    expect(tree.split("\n")).toHaveLength(22);
    expect(tree).toContain("  ... and 5 more");
  });

  it("returns an empty string for a payload without entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );

    expect(await new DirectoryTreeFormatter("/workspace").fetchDirectoryTree()).toBe("");
  });

  it("returns an empty string on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );

    expect(await new DirectoryTreeFormatter("/workspace").fetchDirectoryTree()).toBe("");
  });

  it("falls back to the cached tree when the fetch throws", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [{ type: "file", name: "kept.txt" }] }),
      })
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const formatter = new DirectoryTreeFormatter("/workspace");
    expect(await formatter.fetchDirectoryTree()).toBe("📄 kept.txt");

    // Expire the cache so the next call retries the failing fetch.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    expect(await formatter.fetchDirectoryTree()).toBe("📄 kept.txt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves repeated calls from the cache", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ entries: [{ type: "file", name: "cached.txt" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const formatter = new DirectoryTreeFormatter("/workspace");
    await formatter.fetchDirectoryTree();
    await formatter.fetchDirectoryTree();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SystemPromptAssembler.assemble platform context", () => {
  const assembler = new SystemPromptAssembler({ workspaceRoot: "/workspace" });

  it("collects platformContext parts and runtime sections", async () => {
    const context = {
      agentContext: {
        platformContext: {
          description: "discord platform",
          serverContext: "server ctx",
          imageContext: "image ctx",
          ids: "guild ids",
        },
        clockCrewContext: "clock crew",
        stickersContext: "stickers",
        emotionContext: "emotion",
        visualContext: "visual",
        lightsContext: "lights",
      },
      workspaceEnabled: false,
      messages: [],
    } as unknown as AssemblerContext;

    const result = await assembler.assemble(context);

    expect(result.platformContextMessage).toBe(
      "discord platform\n\nserver ctx\n\nimage ctx\n\nguild ids",
    );
    expect(result.prompt).toContain("clock crew");
    expect(result.prompt).toContain("stickers");
    expect(result.prompt).toContain("emotion");
    expect(result.prompt).toContain("visual");
    expect(result.prompt).toContain("lights");
  });

  it("falls back to Discord fields and builds the guild/channel ids block", async () => {
    const context = {
      agentContext: {
        discordContext: "discord ctx",
        serverContext: "server ctx",
        imageContext: "image ctx",
        guildId: "guild-1",
        channelId: "channel-1",
      },
      workspaceEnabled: false,
      messages: [],
    } as unknown as AssemblerContext;

    const result = await assembler.assemble(context);

    expect(result.platformContextMessage).toBe(
      [
        "discord ctx",
        "server ctx",
        "image ctx",
        "# Discord IDs\n- Guild ID: guild-1\n- Channel ID: channel-1",
      ].join("\n\n"),
    );
  });

  it("omits the channel id when only a guild id is known", async () => {
    const context = {
      agentContext: { guildId: "guild-2" },
      workspaceEnabled: false,
      messages: [],
    } as unknown as AssemblerContext;

    const result = await assembler.assemble(context);

    expect(result.platformContextMessage).toBe("# Discord IDs\n- Guild ID: guild-2");
  });

  it("returns a null platform message when nothing is provided", async () => {
    const context = {
      agentContext: {},
      workspaceEnabled: false,
      messages: [],
    } as unknown as AssemblerContext;

    const result = await assembler.assemble(context);

    expect(result.platformContextMessage).toBeNull();
    expect(result.prompt.length).toBeGreaterThan(0);
  });
});

describe("SkillMemoryScorer.fetchSkills", () => {
  const scorer = new SkillMemoryScorer();

  function mockSkillsCollection(skills: Record<string, unknown>[]) {
    const toArray = vi.fn(async () => skills);
    const project = vi.fn(() => ({ toArray }));
    const find = vi.fn(() => ({ project }));
    fakes.getDb.mockReturnValue({ collection: () => ({ find }) });
    return { find, project, toArray };
  }

  it("returns [] when Mongo is unavailable", async () => {
    fakes.getDb.mockReturnValue(null);
    expect(await scorer.fetchSkills("proj", "user", "query")).toEqual([]);
  });

  it("returns [] when no skills match", async () => {
    mockSkillsCollection([]);
    expect(await scorer.fetchSkills("proj", "user", "query")).toEqual([]);
  });

  it("returns every skill with a neutral score when there is no query", async () => {
    const { find } = mockSkillsCollection([
      { name: "a", content: "A", description: "desc-a", semanticEmbedding: { space: "x:4:float", vector: [1, 0, 0, 0] } },
    ]);

    const skills = await scorer.fetchSkills("proj", "user", "");

    expect(skills).toEqual([{ name: "a", content: "A", description: "desc-a", score: 1 }]);
    expect(find).toHaveBeenCalledWith({ project: "proj", username: "user", enabled: true });
    expect(fakes.generate).not.toHaveBeenCalled();
  });

  it("returns every skill when none has an embedding", async () => {
    mockSkillsCollection([
      { name: "legacy", content: "L", description: "d" },
    ]);

    const skills = await scorer.fetchSkills("proj", "user", "query text");
    expect(skills).toEqual([{ name: "legacy", content: "L", description: "d", score: 1 }]);
  });

  it("scores and orders skills by cosine similarity", async () => {
    const space = "emb:4:float";
    mockSkillsCollection([
      { name: "close", content: "C", description: "d", semanticEmbedding: { space, vector: [1, 0, 0, 0] } },
      { name: "far", content: "F", description: "d", semanticEmbedding: { space, vector: [0, 1, 0, 0] } },
    ]);
    fakes.generate.mockResolvedValue({ embedding: [1, 0, 0, 0], space });

    const skills = await scorer.fetchSkills("proj", "user", "find close skill");

    expect(fakes.generate).toHaveBeenCalledWith(
      "find close skill",
      expect.objectContaining({ taskType: "RETRIEVAL_QUERY", source: "skill-relevance" }),
    );
    // "far" scores 0 → below the 0.3 threshold.
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("close");
    expect(skills[0].score).toBeCloseTo(1, 5);
  });

  it("keeps legacy untagged skills at a neutral score during ranking", async () => {
    const space = "emb:4:float";
    mockSkillsCollection([
      { name: "tagged", content: "T", description: "d", semanticEmbedding: { space, vector: [0, 1, 0, 0] } },
      { name: "legacy", content: "L", description: "d" },
    ]);
    fakes.generate.mockResolvedValue({ embedding: [1, 0, 0, 0], space });

    const skills = await scorer.fetchSkills("proj", "user", "query");

    expect(skills.map((skill) => skill.name)).toEqual(["legacy"]);
    expect(skills[0].score).toBe(1);
  });

  it("returns all skills when the query embedding fails", async () => {
    mockSkillsCollection([
      { name: "one", content: "1", description: "d", semanticEmbedding: { space: "emb:4:float", vector: [1, 0, 0, 0] } },
    ]);
    fakes.generate.mockRejectedValue(new Error("embedding down"));

    const skills = await scorer.fetchSkills("proj", "user", "query");
    expect(skills).toEqual([{ name: "one", content: "1", description: "d", score: 1 }]);
  });

  it("returns [] when the query throws", async () => {
    fakes.getDb.mockImplementation(() => {
      throw new Error("mongo exploded");
    });
    expect(await scorer.fetchSkills("proj", "user", "query")).toEqual([]);
  });
});
