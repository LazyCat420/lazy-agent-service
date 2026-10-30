import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Db, Document } from "mongodb";
import { COLLECTIONS, SSE_KEEPALIVE_INTERVAL_MS } from "../../constants.ts";
import ChangeStreamService from "../../services/ChangeStreamService.ts";
import BenchmarkService from "../../services/BenchmarkService.ts";
import ActiveGenerationTracker from "../../services/ActiveGenerationTracker.ts";
import AgentPersonaRegistry from "../../services/AgentPersonaRegistry.ts";
import ToolOrchestratorService from "../../services/ToolOrchestratorService.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  applyDateRangeFilter,
  parsePaginationParams,
  CONVERSATION_LIST_BASE_PROJECTION,
} from "../../utils/QueryBuilders.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";
import {
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_HOUR,
  minutes,
} from "@rodrigo-barraza/utilities-library";

const router = express.Router();
const {
  REQUESTS: REQUESTS_COLLECTION,
  MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION,
} = COLLECTIONS;

router.use(requireDb);

// ─── GET /conversations helpers ───────────────────────────────

type ConversationQuery = Request["query"];

const CONVERSATION_LIST_PROJECTION = {
  ...CONVERSATION_LIST_BASE_PROJECTION,
  messageCount: { $size: { $ifNull: ["$messages", []] } },
  totalCost: { $ifNull: ["$totalCost", 0] },
};

interface ConversationListScope {
  shouldFetchDirectConversations: boolean;
  shouldFetchAgentConversations: boolean;
  agentFilter: Record<string, unknown>;
  sortKey: string;
  sortDirection: 1 | -1;
}

interface ConversationPage {
  directConversations: Document[];
  agentConversations: Document[];
}

interface ConversationTotals {
  direct: number;
  agent: number;
}

interface RequestMetrics {
  inputTokens: number;
  outputTokens: number;
  totalLatency: number;
  avgTokensPerSec: number | null;
  aggregatedCost: number;
  models: unknown[];
  toolDisplayNames: unknown[];
  toolApiNames: unknown[];
}

/** Search clauses: title/project/username, plus conversation ids when the term looks like an IP/trace. */
async function buildSearchClauses(
  search: unknown,
  db: Db,
): Promise<Record<string, unknown>[]> {
  const regex = { $regex: search, $options: "i" };
  const orClauses: Record<string, unknown>[] = [
    { title: regex },
    { project: regex },
    { username: regex },
  ];

  const searchString = typeof search === "string" ? search.trim() : "";
  if (/^[\d.:a-f]+$/i.test(searchString)) {
    const matchingConversationIds = await db
      .collection(REQUESTS_COLLECTION)
      .distinct("conversationId", { clientIp: regex });
    if (matchingConversationIds.length > 0) {
      orClauses.push({ id: { $in: matchingConversationIds } });
    }
  }
  return orClauses;
}

async function buildConversationListFilter(
  query: ConversationQuery,
  db: Db,
): Promise<Record<string, unknown>> {
  const { trace, project, username, workspace, search, provider, model, from, to } = query;
  const filter: Record<string, unknown> = {};
  if (trace) filter.traceId = trace;
  if (project) filter.project = project;
  if (username) filter.username = username;
  if (workspace) filter.workspaceRoot = workspace;
  if (search) filter.$or = await buildSearchClauses(search, db);
  if (provider) filter.providers = provider;
  if (model) filter["messages.model"] = model;

  applyDateRangeFilter(
    filter,
    typeof from === "string" ? from : undefined,
    typeof to === "string" ? to : undefined,
    "updatedAt",
  );
  return filter;
}

/** Which collections this request reads, the agent filter, and the sort key. */
export function resolveListScope(
  query: ConversationQuery,
  filter: Record<string, unknown>,
  sortDirection: 1 | -1,
): ConversationListScope {
  const { agent, type, sort } = query;
  const isDirectOnly = type === "direct" || agent === AGENT_IDS.NONE;
  const isAgentOnly =
    agent && agent !== AGENT_IDS.NONE && agent !== AGENT_IDS.ALL;

  const agentFilter = { ...filter };
  if (isAgentOnly) {
    agentFilter.agent = agent;
  }

  return {
    shouldFetchDirectConversations: !isAgentOnly,
    shouldFetchAgentConversations: !isDirectOnly,
    agentFilter,
    sortKey: typeof sort === "string" ? sort : "updatedAt",
    sortDirection,
  };
}

async function fetchConversationPage(
  db: Db,
  filter: Record<string, unknown>,
  scope: ConversationListScope,
  skip: number,
  limit: number,
): Promise<ConversationPage> {
  let directConversations: Document[] = [];
  let agentConversations: Document[] = [];
  const queryPromises: Promise<void>[] = [];

  if (scope.shouldFetchDirectConversations) {
    queryPromises.push(
      db
        .collection(CONVERSATIONS_COLLECTION)
        .find(filter)
        .project(CONVERSATION_LIST_PROJECTION)
        .sort({ [scope.sortKey]: scope.sortDirection })
        .limit(skip + limit)
        .toArray()
        .then((result) => {
          directConversations = result;
        }),
    );
  }

  if (scope.shouldFetchAgentConversations) {
    queryPromises.push(
      db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .find(scope.agentFilter)
        .project(CONVERSATION_LIST_PROJECTION)
        .sort({ [scope.sortKey]: scope.sortDirection })
        .limit(skip + limit)
        .toArray()
        .then((result) => {
          agentConversations = result;
        }),
    );
  }

  await Promise.all(queryPromises);
  return { directConversations, agentConversations };
}

async function countConversationTotals(
  db: Db,
  filter: Record<string, unknown>,
  scope: ConversationListScope,
): Promise<ConversationTotals> {
  let direct = 0;
  let agent = 0;
  const countPromises: Promise<void>[] = [];

  if (scope.shouldFetchDirectConversations) {
    countPromises.push(
      db
        .collection(CONVERSATIONS_COLLECTION)
        .countDocuments(filter)
        .then((result) => {
          direct = result;
        }),
    );
  }

  if (scope.shouldFetchAgentConversations) {
    countPromises.push(
      db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .countDocuments(scope.agentFilter)
        .then((result) => {
          agent = result;
        }),
    );
  }

  await Promise.all(countPromises);
  return { direct, agent };
}

export function mergeConversationLists(
  page: ConversationPage,
  scope: ConversationListScope,
): Array<Record<string, unknown>> {
  const getSortValue = (item: Record<string, unknown>): string => {
    const value = item[scope.sortKey];
    return value !== undefined ? String(value) : "";
  };

  return [
    ...page.directConversations.map((item) => ({ ...item, type: "direct" as const })),
    ...page.agentConversations.map((session) => ({ ...session, type: "agent" as const })),
  ].sort((firstItem, secondItem) => {
    const valueA = getSortValue(firstItem as Record<string, unknown>);
    const valueB = getSortValue(secondItem as Record<string, unknown>);
    if (valueA < valueB) return -scope.sortDirection;
    if (valueA > valueB) return scope.sortDirection;
    return 0;
  });
}

function collectAgentConversationIds(
  documents: Array<Record<string, unknown>>,
): string[] {
  return documents
    .filter((document) => document.type === "agent")
    .map((document) => {
      const id = document.id;
      return typeof id === "string" ? id : "";
    })
    .filter(Boolean);
}

async function fetchConversationRequests(
  db: Db,
  documentIds: unknown[],
  agentConversationIds: string[],
): Promise<Document[]> {
  return db
    .collection(REQUESTS_COLLECTION)
    .find({
      $or: [
        { conversationId: { $in: documentIds } },
        { agentConversationId: { $in: agentConversationIds } },
        { parentAgentConversationId: { $in: agentConversationIds } },
      ],
    })
    .project({
      conversationId: 1,
      agentConversationId: 1,
      parentAgentConversationId: 1,
      inputTokens: 1,
      outputTokens: 1,
      model: 1,
      tokensPerSec: 1,
      totalTime: 1,
      toolDisplayNames: 1,
      toolApiNames: 1,
      estimatedCost: 1,
    })
    .toArray();
}

/** Which conversation a request row belongs to (parent agent > agent > direct). */
function resolveRequestTargetId(
  requestItem: Document,
  agentConversationIds: Set<string>,
): string {
  if (
    requestItem.parentAgentConversationId &&
    agentConversationIds.has(requestItem.parentAgentConversationId)
  ) {
    return requestItem.parentAgentConversationId;
  }
  if (
    requestItem.agentConversationId &&
    agentConversationIds.has(requestItem.agentConversationId)
  ) {
    return requestItem.agentConversationId;
  }
  if (requestItem.conversationId) {
    return requestItem.conversationId;
  }
  return "";
}

function buildRequestLogMap(
  requests: Document[],
  agentConversationIds: string[],
): Map<string, Document[]> {
  const requestLogMap = new Map<string, Document[]>();
  const agentIdSet = new Set(agentConversationIds);

  for (const requestItem of requests) {
    const targetId = resolveRequestTargetId(requestItem, agentIdSet);
    if (!targetId) continue;
    const bucket = requestLogMap.get(targetId);
    if (bucket) {
      bucket.push(requestItem);
    } else {
      requestLogMap.set(targetId, [requestItem]);
    }
  }
  return requestLogMap;
}

function collectDistinctScalarValues(
  requests: Document[],
  field: string,
): unknown[] {
  return Array.from(new Set(requests.map((requestItem) => requestItem[field]).filter(Boolean)));
}

function collectDistinctListValues(
  requests: Document[],
  field: string,
): unknown[] {
  return Array.from(
    new Set(
      requests
        .flatMap((requestItem) =>
          Array.isArray(requestItem[field]) ? requestItem[field] : [],
        )
        .filter(Boolean),
    ),
  );
}

function aggregateRequestMetrics(requests: Document[]): RequestMetrics {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalLatency = 0;
  let tokensPerSecondSum = 0;
  let tokensPerSecondCount = 0;
  let aggregatedCost = 0;

  for (const requestItem of requests) {
    inputTokens += requestItem.inputTokens || 0;
    outputTokens += requestItem.outputTokens || 0;
    totalLatency += requestItem.totalTime || 0;
    aggregatedCost += requestItem.estimatedCost || 0;
    if (requestItem.tokensPerSec && requestItem.tokensPerSec > 0) {
      tokensPerSecondSum += requestItem.tokensPerSec;
      tokensPerSecondCount++;
    }
  }

  return {
    inputTokens,
    outputTokens,
    totalLatency,
    aggregatedCost,
    avgTokensPerSec:
      tokensPerSecondCount > 0
        ? tokensPerSecondSum / tokensPerSecondCount
        : null,
    models: collectDistinctScalarValues(requests, "model"),
    toolDisplayNames: collectDistinctListValues(requests, "toolDisplayNames"),
    toolApiNames: collectDistinctListValues(requests, "toolApiNames"),
  };
}

export function enrichConversationDocument(
  document: Record<string, unknown>,
  requestLogMap: Map<string, Document[]>,
): Record<string, unknown> {
  const documentId = typeof document.id === "string" ? document.id : "";
  const associatedRequests = requestLogMap.get(documentId) || [];
  const metrics = aggregateRequestMetrics(associatedRequests);

  // Apply cost overlay for agent conversations
  const originalCost = (document.totalCost as number) || 0;
  const totalCost =
    document.type === "agent" && metrics.aggregatedCost > 0
      ? Math.max(originalCost, metrics.aggregatedCost)
      : originalCost;

  return {
    ...document,
    totalCost,
    requestCount: associatedRequests.length,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    models: metrics.models,
    toolDisplayNames: metrics.toolDisplayNames,
    toolApiNames: metrics.toolApiNames,
    avgTokensPerSec: metrics.avgTokensPerSec,
    totalLatency: metrics.totalLatency,
  };
}

// ─── GET /conversations — cross-project conversation list ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { skip, limit, sortDirection } = parsePaginationParams(req.query);
      const filter = await buildConversationListFilter(req.query, req.db);
      const scope = resolveListScope(req.query, filter, sortDirection);

      const page = await fetchConversationPage(
        req.db,
        filter,
        scope,
        skip,
        limit,
      );
      const totals = await countConversationTotals(req.db, filter, scope);

      const merged = mergeConversationLists(page, scope);
      const paginatedDocuments = merged.slice(skip, skip + limit);

      const paginatedDocumentIds = paginatedDocuments.map(
        (document) => (document as Document).id,
      );
      const agentConversationIds = collectAgentConversationIds(paginatedDocuments);

      const requests = await fetchConversationRequests(
        req.db,
        paginatedDocumentIds,
        agentConversationIds,
      );
      const requestLogMap = buildRequestLogMap(requests, agentConversationIds);

      const enrichedDocuments = paginatedDocuments.map((document) =>
        enrichConversationDocument(document, requestLogMap),
      );

      res.json({
        data: enrichedDocuments,
        total: totals.direct + totals.agent,
        page: parsePaginationParams(req.query).page,
        limit,
      });
    } catch (error: unknown) {
      logger.error("Admin /conversations error: " + getErrorMessage(error));
      next(error);
    }
  }),
);

// ─── GET /conversations/filters — distinct filter values for admin dropdowns ─
router.get(
  "/filters",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [conversationProjects, requestProjects, usernames, models, providers] =
        await Promise.all([
          req.db.collection(CONVERSATIONS_COLLECTION).distinct("project"),
          req.db.collection(REQUESTS_COLLECTION).distinct("project"),
          req.db.collection(CONVERSATIONS_COLLECTION).distinct("username"),
          req.db.collection(REQUESTS_COLLECTION).distinct("model"),
          req.db.collection(REQUESTS_COLLECTION).distinct("provider"),
        ]);

      const projects = [...new Set([...conversationProjects, ...requestProjects])];
      const workspaceRoots = ToolOrchestratorService.getWorkspaceRoots();
      const agentPersonas = AgentPersonaRegistry.list().map((persona) => ({
        id: persona.id,
        name: persona.name,
      }));

      res.json({
        projects: projects.filter(Boolean).sort(),
        usernames: usernames.filter(Boolean).sort(),
        models: models.filter(Boolean).sort(),
        providers: providers.filter(Boolean).sort(),
        workspaces: workspaceRoots.filter(Boolean).sort(),
        agents: agentPersonas,
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /conversations/filters error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /conversations/stats — quick stats snapshot ──
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.query.project || null;
      const filter = project ? { project } : {};
      const oneHourAgo = new Date(
        Date.now() - MILLISECONDS_PER_HOUR,
      ).toISOString();
      const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();

      const [generatingCount, recentCount] = await Promise.all([
        req.db.collection(CONVERSATIONS_COLLECTION).countDocuments({
          ...filter,
          isGenerating: true,
          updatedAt: { $gte: fiveMinAgo },
        }),
        project
          ? req.db
              .collection(CONVERSATIONS_COLLECTION)
              .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } })
          : req.db
              .collection(CONVERSATIONS_COLLECTION)
              .estimatedDocumentCount(),
      ]);

      res.json({
        generatingCount:
          generatingCount +
          BenchmarkService.activeGenerationCount +
          ActiveGenerationTracker.count,
        recentCount,
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /conversations/stats error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /conversations/stream — SSE for real-time stats ─
router.get(
  "/stream",
  asyncHandler(async (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("\n");

    const project = req.query.project || null;
    let lastPayload = "";

    const sendStats = async () => {
      try {
        const filter = project ? { project } : {};
        const oneHourAgo = new Date(
          Date.now() - MILLISECONDS_PER_HOUR,
        ).toISOString();
        const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();

        const [generatingCount, recentCount] = await Promise.all([
          req.db.collection(CONVERSATIONS_COLLECTION).countDocuments({
            ...filter,
            isGenerating: true,
            updatedAt: { $gte: fiveMinAgo },
          }),
          project
            ? req.db
                .collection(CONVERSATIONS_COLLECTION)
                .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } })
            : req.db
                .collection(CONVERSATIONS_COLLECTION)
                .estimatedDocumentCount(),
        ]);

        const payload = JSON.stringify({
          generatingCount:
            generatingCount +
            BenchmarkService.activeGenerationCount +
            ActiveGenerationTracker.count,
          recentCount,
        });
        if (payload !== lastPayload) {
          lastPayload = payload;
          res.write(`data: ${payload}\n\n`);
        }
      } catch (error: unknown) {
        logger.error(
          `SSE conversations/stream error: ${getErrorMessage(error)}`,
        );
      }
    };

    await sendStats();

    const staleCleanupInterval = setInterval(() => {
      const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();
      req.db
        .collection(CONVERSATIONS_COLLECTION)
        .updateMany(
          { isGenerating: true, updatedAt: { $lt: fiveMinAgo } },
          { $set: { isGenerating: false } },
        )
        .then(({ modifiedCount }: { modifiedCount: number }) => {
          if (modifiedCount > 0)
            logger.info(
              `Auto-cleared ${modifiedCount} stale isGenerating flag(s)`,
            );
        })
        .catch(() => {});
    }, MILLISECONDS_PER_MINUTE);

    if (ChangeStreamService.available) {
      const onEvent = (
        event: import("../../services/ChangeStreamService.ts").ChangeStreamEventPayload,
      ) => {
        if (
          event.collection === CONVERSATIONS_COLLECTION ||
          event.collection === COLLECTIONS.AGENT_CONVERSATIONS
        ) {
          sendStats();
        }
      };
      ChangeStreamService.subscribe(onEvent);

      let previousNonConversationCount = 0;
      const generationPoll = setInterval(() => {
        const count =
          BenchmarkService.activeGenerationCount +
          ActiveGenerationTracker.count;
        if (count > 0 || previousNonConversationCount > 0) sendStats();
        previousNonConversationCount = count;
      }, 1000);

      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      req.on("close", () => {
        ChangeStreamService.unsubscribe(onEvent);
        clearInterval(generationPoll);
        clearInterval(keepAlive);
        clearInterval(staleCleanupInterval);
      });
    } else {
      const interval = setInterval(sendStats, 2000);
      const keepAlive = setInterval(() => {
        res.write(": ping\n\n");
      }, SSE_KEEPALIVE_INTERVAL_MS);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
        clearInterval(staleCleanupInterval);
      });
    }
  }),
);

// ─── GET /conversations/:id — single conversation, full msgs ─
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      let conversationDocument = await req.db
        .collection(CONVERSATIONS_COLLECTION)
        .findOne({ id: req.params.id });
      if (conversationDocument) {
        return res.json({ ...conversationDocument, type: "direct" });
      }

      conversationDocument = await req.db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: req.params.id });
      if (conversationDocument) {
        const agentRecord = conversationDocument as Record<string, unknown>;
        if (
          !agentRecord.hasSubAgents &&
          Array.isArray(agentRecord.subAgents) &&
          (agentRecord.subAgents as unknown[]).length > 0
        ) {
          agentRecord.hasSubAgents = true;
        }
        return res.json({ ...conversationDocument, type: "agent" });
      }

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      logger.error(`Admin /conversations/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
