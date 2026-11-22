import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import logger from "../logger.js";
import { runtimeAuth } from "../middleware/RuntimeAuth.ts";
import {
  PipelineTimeoutError,
  PoolUnavailableError,
} from "../services/trading/LocalPoolClient.ts";
import {
  runLinearDeskPipeline,
  runLinearTraderReplay,
  StageParseError,
  type LinearDeskDeps,
} from "../services/trading/LinearDeskPipeline.ts";
import { QueueTimeoutError } from "../services/vllm/VllmShimService.ts";

const MAX_LEDGER_ENTRIES = 128;

const LedgerEntrySchema = z.object({
  fact_id: z.string().min(1),
  tool_name: z.string().min(1),
  ticker: z.string().optional(),
  as_of: z.string().optional(),
  summary: z.string().optional(),
  raw: z.unknown().optional(),
});

const PortfolioContextSchema = z.object({
  held: z.boolean(),
  shares_owned: z.number().default(0),
  avg_cost: z.number().nullable().default(null),
  cash_usd: z.number().default(0),
  max_position_pct: z.number().min(0).max(100).default(15),
  equity_usd: z.number().optional(),
});

const MacroSnapshotSchema = z
  .object({
    vix: z.number().nullable().optional(),
    spy_20d_return: z.number().nullable().optional(),
    yield_10y_2y: z.number().nullable().optional(),
    regime_note: z.string().optional(),
  })
  .optional();

const DirectivesSchema = z.array(z.string().min(1).max(400)).max(6).optional();

const PlaybookBulletsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(40),
      text: z.string().min(1).max(300),
      section: z.string().max(40).optional(),
    }),
  )
  .max(15)
  .optional();

const TickerHistoryCardSchema = z
  .array(
    z.object({
      date: z.string().min(1).max(32),
      action: z.enum(["BUY", "HOLD", "AVOID", "SELL"]),
      outcome: z.string().min(1).max(64),
      pnl_pct: z.number().nullable().default(null),
      regime: z.string().max(64).optional(),
    }),
  )
  .max(5)
  .optional();

const ReplayFactCategorySchema = z.enum([
  "price",
  "valuation",
  "fundamental",
  "technical",
  "news",
  "earnings",
  "macro",
  "risk",
]);

const ReplayDossierSchema = z.object({
  summary: z.string().default(""),
  facts: z
    .array(
      z.object({
        fact_id: z.string().min(1),
        category: ReplayFactCategorySchema.default("fundamental"),
        metric: z.string().min(1),
        value: z.string().min(1),
        raw_number: z.number().finite().nullable().optional(),
        ticker: z.string().optional(),
        as_of: z.string().optional(),
        summary: z.string().default(""),
        uncorroborated: z.boolean().optional(),
      }),
    )
    .default([]),
  catalysts: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  data_gaps: z.array(z.string()).default([]),
});

const LinearDeskRequestSchema = z
  .object({
    ticker: z.string().min(1).max(16),
    cycle_id: z.string().min(1).max(160),
    ledger_entries: z.record(z.string(), LedgerEntrySchema),
    portfolio_context: PortfolioContextSchema,
    macro_snapshot: MacroSnapshotSchema,
    followup_tools: z.array(z.string()).optional(),
    directives: DirectivesSchema,
    playbook_bullets: PlaybookBulletsSchema,
    ticker_history_card: TickerHistoryCardSchema,
  })
  .superRefine((data, ctx) => {
    const entryList = Object.entries(data.ledger_entries);
    if (entryList.length > MAX_LEDGER_ENTRIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ledger_entries"],
        message: `ledger_entries must have at most ${MAX_LEDGER_ENTRIES} entries`,
      });
      return;
    }
    for (const [key, entry] of entryList) {
      if (entry.fact_id !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ledger_entries", key, "fact_id"],
          message: `ledger_entries key '${key}' must equal entry.fact_id '${entry.fact_id}'`,
        });
      }
    }
  });

const ReplayTraderRequestSchema = z.object({
  ticker: z.string().min(1).max(16),
  cycle_id: z.string().min(1).max(160),
  portfolio_context: PortfolioContextSchema,
  macro_snapshot: MacroSnapshotSchema,
  dossier: ReplayDossierSchema,
  directives: DirectivesSchema,
  playbook_bullets: PlaybookBulletsSchema,
  ticker_history_card: TickerHistoryCardSchema,
});

function handleTradingDeskRouteError(ctx: {
  err: unknown;
  routeLabel: string;
  ticker: string;
  cycleId: string;
  startedAt: number;
  controller: AbortController;
  res: Response;
}): void {
  const { err, routeLabel, ticker, cycleId, startedAt, controller, res } = ctx;
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    `[TradingDeskRoutes] ${routeLabel} failed ticker=${ticker} cycle=${cycleId} elapsedMs=${Date.now() - startedAt} error=${message}`,
  );
  if (res.headersSent) return;
  if (controller.signal.aborted) {
    res.status(499).json({ error: { code: "CLIENT_ABORTED", message: "Client closed connection" } });
    return;
  }
  if (err instanceof StageParseError) {
    res.status(422).json({ error: { code: err.code, message } });
    return;
  }
  if (err instanceof PoolUnavailableError || err instanceof QueueTimeoutError) {
    res.status(503).json({ error: { code: "POOL_UNAVAILABLE", message } });
    return;
  }
  if (err instanceof PipelineTimeoutError || (err instanceof DOMException && err.name === "TimeoutError")) {
    res.status(504).json({ error: { code: "PIPELINE_TIMEOUT", message } });
    return;
  }
  res.status(500).json({ error: { code: "LINEAR_DESK_ERROR", message } });
}

export function createTradingDeskRouter(deps: LinearDeskDeps = {}): Router {
  const router = Router();
  router.use(runtimeAuth);

  router.post(
    "/linear-desk",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = LinearDeskRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "INVALID_LINEAR_DESK_REQUEST",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        });
        return;
      }
      const startedAt = Date.now();
      req.setTimeout(620_000);
      res.setTimeout(620_000);
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const result = await runLinearDeskPipeline(
          { ...parsed.data, signal: controller.signal },
          deps,
        );
        res.json(result);
      } catch (err) {
        handleTradingDeskRouteError({
          err,
          routeLabel: "linear-desk",
          ticker: parsed.data.ticker,
          cycleId: parsed.data.cycle_id,
          startedAt,
          controller,
          res,
        });
      }
    }),
  );

  router.post(
    "/linear-desk/replay-trader",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = ReplayTraderRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "INVALID_REPLAY_TRADER_REQUEST",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        });
        return;
      }
      const startedAt = Date.now();
      req.setTimeout(300_000);
      res.setTimeout(300_000);
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const result = await runLinearTraderReplay(
          { ...parsed.data, signal: controller.signal },
          deps,
        );
        res.json(result);
      } catch (err) {
        handleTradingDeskRouteError({
          err,
          routeLabel: "linear-desk/replay-trader",
          ticker: parsed.data.ticker,
          cycleId: parsed.data.cycle_id,
          startedAt,
          controller,
          res,
        });
      }
    }),
  );

  return router;
}

export default createTradingDeskRouter();
