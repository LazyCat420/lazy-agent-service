import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────
//  GoalStore — persistent per-conversation goals (prism pattern)
//
//  A conversation can carry goals: what "done" means, plus an
//  optional budget and a list of required criteria (keywords that
//  must show up in verifier evidence / tool observations).
//  Pure filesystem, no DB: one JSON file under
//  `<repoRoot>/data/goal_store/goals.json`, written atomically
//  via temp file + rename.
// ─────────────────────────────────────────────────────────────

export type GoalStatus = "active" | "paused" | "achieved" | "abandoned";

export interface GoalBudget {
  /** Units already spent (dollars, turns — caller decides). */
  spent: number;
  /** Cap after which the gate must stop the run. */
  cap: number;
}

export interface Goal {
  goal_id: string;
  conversation_id: string;
  text: string;
  /** Simple required-keyword criteria; each must be matched for `achieved`. */
  criteria: string[];
  status: GoalStatus;
  budget: GoalBudget;
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  conversation_id: string;
  text: string;
  criteria?: string[];
  budget?: Partial<GoalBudget>;
}

/** Thrown when an id would escape the goals directory. */
export class InvalidGoalIdError extends Error {}

function assertSafeId(id: string, field: string): string {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    id !== id.trim() ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    id.startsWith(".")
  ) {
    throw new InvalidGoalIdError(`Invalid ${field}: ${JSON.stringify(id)}`);
  }
  return id;
}

export interface GoalStoreOptions {
  /** Goals directory override (default: `<repoRoot>/data/goal_store`). */
  goalsDir?: string;
  /** Workspace root used to derive the default goals directory (default: cwd). */
  repoRoot?: string;
}

export class GoalStore {
  private readonly goalsDir: string;
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: GoalStoreOptions = {}) {
    this.goalsDir =
      options.goalsDir ?? path.join(options.repoRoot ?? process.cwd(), "data", "goal_store");
    this.file = path.join(this.goalsDir, "goals.json");
  }

  private async readAll(): Promise<Goal[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Serialize mutations and write atomically: write to a temp file in
   * the same directory, then rename over the target. A crash mid-write
   * leaves the previous state intact.
   */
  private async mutate(fn: (goals: Goal[]) => Goal[]): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const goals = fn(await this.readAll());
      await fsp.mkdir(this.goalsDir, { recursive: true });
      const tmp = `${this.file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(goals, null, 2), "utf8");
      await fsp.rename(tmp, this.file);
    });
    await this.writeQueue;
  }

  async create(input: CreateGoalInput): Promise<Goal> {
    const conversationId = assertSafeId(input.conversation_id, "conversation_id");
    const text = String(input.text ?? "").trim();
    if (!text) throw new InvalidGoalIdError("goal text must be non-empty");
    const now = new Date().toISOString();
    const goal: Goal = {
      goal_id: crypto.randomUUID(),
      conversation_id: conversationId,
      text,
      criteria: (input.criteria ?? []).map((c) => String(c)),
      status: "active",
      budget: { spent: 0, cap: input.budget?.cap ?? 0 },
      created_at: now,
      updated_at: now,
    };
    if (typeof input.budget?.spent === "number") goal.budget.spent = input.budget.spent;
    await this.mutate((goals) => [...goals, goal]);
    return goal;
  }

  async get(goalId: string): Promise<Goal | null> {
    const goals = await this.readAll();
    return goals.find((g) => g.goal_id === goalId) ?? null;
  }

  async listByConversation(conversationId: string): Promise<Goal[]> {
    assertSafeId(conversationId, "conversation_id");
    const goals = await this.readAll();
    return goals.filter((g) => g.conversation_id === conversationId);
  }

  private async update(goalId: string, fn: (goal: Goal) => Goal): Promise<Goal> {
    let updated: Goal | null = null;
    await this.mutate((goals) =>
      goals.map((g) => {
        if (g.goal_id !== goalId) return g;
        updated = fn({ ...g });
        updated.updated_at = new Date().toISOString();
        return updated;
      }),
    );
    if (!updated) throw new Error(`goal not found: ${goalId}`);
    return updated;
  }

  async updateStatus(goalId: string, status: GoalStatus): Promise<Goal> {
    return this.update(goalId, (g) => ({ ...g, status }));
  }

  async addBudgetSpend(goalId: string, amount: number): Promise<Goal> {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("spend must be a non-negative number");
    return this.update(goalId, (g) => ({
      ...g,
      budget: { ...g.budget, spent: g.budget.spent + amount },
    }));
  }

  async achieve(goalId: string): Promise<Goal> {
    return this.updateStatus(goalId, "achieved");
  }

  async abandon(goalId: string): Promise<Goal> {
    return this.updateStatus(goalId, "abandoned");
  }
}
