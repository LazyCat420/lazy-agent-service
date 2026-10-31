import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter, ContinueSubAgentCallback, TopologyConfig } from "../TopologyRouter.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../InstanceResolver.ts";
import { getProvider } from "../../../providers/index.ts";
import logger from "../../../utils/logger.ts";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.ts";
import RequestLogger from "../../RequestLogger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";

const MAXIMUM_EVALUATION_CHARACTERS = 120_000;
const DEFAULT_VERIFICATION_COMMANDS = ["tsc --noEmit", "npm test"];

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

interface VerificationOutcome {
  candidateIndex: number;
  isPassing: boolean;
  commandResults: { command: string; isPassing: boolean; output: string }[];
}

function parseVerificationResponse(
  responseText: string,
  commands: string[],
): { command: string; isPassing: boolean; output: string }[] {
  let cleanedResponse = responseText.trim();
  cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleanedResponse);
    } catch {
      const arrayMatch = cleanedResponse.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        parsed = JSON.parse(arrayMatch[0]);
      }
    }

    if (Array.isArray(parsed)) {
      const resultsMap = new Map<string, { pass: boolean; output: string }>();
      for (const item of parsed) {
        if (item && typeof item === "object" && "command" in item) {
          const cmd = String((item as Record<string, unknown>).command).trim().toLowerCase();
          const pass = "pass" in item ? Boolean((item as Record<string, unknown>).pass) : false;
          const out = "output" in item ? String((item as Record<string, unknown>).output) : "";
          resultsMap.set(cmd, { pass, output: out });
        }
      }

      // Check if all requested commands are in the parsed results
      const allFound = commands.every((cmd) => resultsMap.has(cmd.trim().toLowerCase()));
      if (allFound) {
        return commands.map((cmd) => {
          const entry = resultsMap.get(cmd.trim().toLowerCase())!;
          return {
            command: cmd,
            isPassing: entry.pass,
            output: entry.output,
          };
        });
      }
    }
  } catch (error) {
    logger.warn(`[TournamentRouter] Failed to parse verification JSON: ${getErrorMessage(error)}. Falling back to heuristic parsing.`);
  }

  // Fallback heuristic parsing (line-by-line)
  const lines = responseText.split("\n");
  return commands.map((command) => {
    const lowerCommand = command.toLowerCase();
    
    // Find a line that contains the command
    const matchingLine = lines.find((line) => line.toLowerCase().includes(lowerCommand));
    let isPassing = false;

    if (matchingLine) {
      const lowerLine = matchingLine.toLowerCase();
      const hasPass = lowerLine.includes("pass") || lowerLine.includes("ok") || lowerLine.includes("success") || lowerLine.includes("true");
      const hasFail = lowerLine.includes("fail") || lowerLine.includes("error") || lowerLine.includes("false");
      isPassing = hasPass && !hasFail;
    } else {
      const lowerOutput = responseText.toLowerCase();
      isPassing = lowerOutput.includes("pass") && !lowerOutput.includes("fail");
    }

    return {
      command,
      isPassing,
      output: responseText.slice(0, 500),
    };
  });
}


function buildSelectionPrompt(
  teamName: string,
  memberResults: (SubAgentResult | { error: string })[],
  verificationOutcomes?: Map<number, VerificationOutcome>,
): string {
  const characterBudgetPerMember = Math.floor(MAXIMUM_EVALUATION_CHARACTERS / Math.max(memberResults.length, 1));

  const resultSections = memberResults.map((result, resultIndex) => {
    if ("error" in result) {
      return `### Sub-Agent #${resultIndex + 1}\n**Status:** Error\n**Error:** ${result.error}`;
    }
    const outputText = result.result
      ? truncateResultOutput(result.result, characterBudgetPerMember)
      : (buildToolCallFallbackSummary(result) || result.summary);
    return [
      `### Sub-Agent #${resultIndex + 1}: ${result.description || "unnamed"}`,
      `**Status:** ${result.status}`,
      `**Tool Uses:** ${result.toolUses}`,
      `**Duration:** ${result.durationMs}ms`,
      ...(verificationOutcomes?.has(resultIndex) ? [
        `**Verification:**`,
        ...verificationOutcomes.get(resultIndex)!.commandResults.map((commandResult) =>
          `  ${commandResult.isPassing ? "✅" : "❌"} \`${commandResult.command}\`: ${commandResult.isPassing ? "PASS" : `FAIL — ${commandResult.output.slice(0, 500)}`}`,
        ),
      ] : []),
      `**Output:**\n${outputText}`,
    ].join("\n");
  });

  return [
    PromptLocaleService.get("en", "routers.tournament.judge", { teamName }),
    PromptLocaleService.get("en", "routers.tournament.judgeJobDescription", { memberCount: String(memberResults.length) }),
    "",
    "## Sub-Agent Results",
    "",
    resultSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    PromptLocaleService.get("en", "routers.tournament.judgeInstructions"),
    "",
    PromptLocaleService.get("en", "routers.tournament.judgeFormat"),
  ].join("\n");
}

interface TournamentJudgeParams {
  teamName: string;
  memberCount: number;
  memberResults: (SubAgentResult | { error: string })[];
  successfulResults: (SubAgentResult | { error: string })[];
  verificationOutcomes: Map<number, VerificationOutcome> | undefined;
  providerName: string;
  resolvedModel: string;
  orchestratorContext: OrchestratorContext;
}

/**
 * Tournament Router — Best-of-N Selection with Judge Pass (BoN)
 *
 * Paper: "Large Language Monkeys: Scaling Inference Compute
 * with Repeated Sampling" (arxiv.org/abs/2407.21787)
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "tournament")
 * for full paper-alignment metadata and config option documentation.
 */
export class TournamentRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    _continueSubAgent?: ContinueSubAgentCallback,
    topologyConfig?: TopologyConfig,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    const isVerificationEnabled = topologyConfig?.enableVerification === true;
    const verificationCommands: string[] = Array.isArray(topologyConfig?.verificationCommands)
      ? (topologyConfig.verificationCommands as string[]).filter((command) => typeof command === "string")
      : DEFAULT_VERIFICATION_COMMANDS;

    logger.info(
      `[TournamentRouter] createTeam: tournament selection of ${members.length} sub-agent(s)${isVerificationEnabled ? " (verification enabled)" : ""}...`,
    );

    // ── Phase 1: Parallel execution (identical to HierarchicalRouter) ────

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "TournamentRouter",
    );

    const assignments: OrchestratorSpawnParams[] = [];

    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const member = members[memberIndex];
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        member,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

      assignments.push({
        description: member.description,
        prompt: member.prompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        agentIndex: memberIndex,
        teamSize: members.length,
        orchestratorContext,
      });
    }

    const spawnPromises = assignments.map((assignment) =>
      spawnSubAgent(assignment),
    );
    const memberResults = await Promise.all(spawnPromises);

    // ── Phase 2: Judge selection (Tournament / Best-of-N) ────────────────

    const successfulResults = memberResults.filter(
      (result) => !("error" in result) && result.status === "completed",
    );

    if (successfulResults.length === 0) {
      logger.warn(
        `[TournamentRouter] All ${memberResults.length} sub-agents failed — skipping judge pass`,
      );
      return memberResults;
    }

    if (successfulResults.length === 1) {
      logger.info(
        `[TournamentRouter] Only 1 sub-agent succeeded — auto-selecting as winner`,
      );
      return memberResults;
    }

    // ── Phase 1.5: Automated Verification (optional) ──────────────────────

    let verificationOutcomes: Map<number, VerificationOutcome> | undefined;

    if (isVerificationEnabled && verificationCommands.length > 0) {
      logger.info(
        `[TournamentRouter] Running automated verification (${verificationCommands.length} command(s)) on ${successfulResults.length} candidates...`,
      );

      verificationOutcomes = new Map();

      const verificationPromises = memberResults.map(async (result, resultIndex) => {
        if ("error" in result || result.status !== "completed") return;

        const hasFileChanges = result.diff && (result.diff.additions > 0 || result.diff.deletions > 0);
        if (!hasFileChanges) {
          verificationOutcomes!.set(resultIndex, {
            candidateIndex: resultIndex,
            isPassing: true,
            commandResults: [{ command: "(no file changes)", isPassing: true, output: "Skipped — no file modifications" }],
          });
          return;
        }

        const verificationPrompt = [
          PromptLocaleService.get("en", "routers.tournament.verifier"),
          "",
          ...verificationCommands.map((command, commandIndex) => `${commandIndex + 1}. \`${command}\``),
          "",
          "Report your results as a JSON array:",
          '```json',
          JSON.stringify(verificationCommands.map((command) => ({ command, pass: true, output: "" })), null, 2),
          '```',
          "",
          "Set pass=false and include the error output if a command fails.",
        ].join("\n");

        try {
          const { assignedProvider, assignedModel } = selectInstanceForMember(
            members[0],
            resolvedSiblings,
            { providerName, resolvedModel },
          );

          const verificationResult = await spawnSubAgent({
            description: `Verification for candidate #${resultIndex + 1}`,
            prompt: verificationPrompt,
            files: members[0].files,
            model: members[0].model,
            agent: members[0].agent,
            assignedProvider,
            assignedModel,
            agentIndex: resultIndex,
            teamSize: members.length,
            orchestratorContext,
          });

          if ("error" in verificationResult) {
            verificationOutcomes!.set(resultIndex, {
              candidateIndex: resultIndex,
              isPassing: false,
              commandResults: [{ command: "verification", isPassing: false, output: (verificationResult as { error: string }).error }],
            });
            return;
          }

          const commandResults = parseVerificationResponse(
            verificationResult.result || "",
            verificationCommands,
          );

          verificationOutcomes!.set(resultIndex, {
            candidateIndex: resultIndex,
            isPassing: commandResults.every((commandResult) => commandResult.isPassing),
            commandResults,
          });
        } catch (verificationError: unknown) {
          verificationOutcomes!.set(resultIndex, {
            candidateIndex: resultIndex,
            isPassing: false,
            commandResults: [{ command: "verification", isPassing: false, output: getErrorMessage(verificationError) }],
          });
        }
      });

      await Promise.all(verificationPromises);

      const passingCandidateCount = Array.from(verificationOutcomes.values()).filter(
        (outcome) => outcome.isPassing,
      ).length;

      logger.info(
        `[TournamentRouter] Verification complete: ${passingCandidateCount}/${verificationOutcomes.size} candidates passed`,
      );
    }

    logger.info(
      `[TournamentRouter] Running judge selection over ${successfulResults.length} successful sub-agent results...`,
    );

    const judgeSubAgentResult = await this.runTournamentJudgePass({
      teamName,
      memberCount: members.length,
      memberResults,
      successfulResults,
      verificationOutcomes,
      providerName,
      resolvedModel,
      orchestratorContext,
    });

    if (!judgeSubAgentResult) {
      return memberResults;
    }

    return [...memberResults, judgeSubAgentResult];
  }

  private async runTournamentJudgePass(
    params: TournamentJudgeParams,
  ): Promise<SubAgentResult | null> {
    const {
      teamName,
      memberCount,
      memberResults,
      successfulResults,
      verificationOutcomes,
      providerName,
      resolvedModel,
      orchestratorContext,
    } = params;

    try {
      const selectionPrompt = buildSelectionPrompt(teamName, memberResults, verificationOutcomes);
      const provider = getProvider(providerName);

      if (!provider) {
        logger.error(
          `[TournamentRouter] Provider "${providerName}" not found for judge pass`,
        );
        return null;
      }

      const selectionStartTime = Date.now();
      const selectionRequestStartMs = performance.now();
      const selectionMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [{ role: "user", content: selectionPrompt }];
      const selectionResult = await provider.generateText(
        selectionMessages,
        resolvedModel,
        { maxTokens: 8192 },
      );
      const selectionDurationMs = Date.now() - selectionStartTime;

      RequestLogger.logBackgroundLlmCall({
        requestId: `${orchestratorContext.conversationId || "unknown"}-tournament-${teamName}`,
        endpoint: "/agent",
        operation: "orchestrator:tournament-judge",
        project: orchestratorContext.project || null,
        username: orchestratorContext.username || "system",
        agent: null,
        provider: providerName,
        model: resolvedModel,
        traceId: orchestratorContext.traceId || null,
        agentConversationId: orchestratorContext.agentConversationId || null,
        aiMessages: selectionMessages,
        resultText: selectionResult.text || "",
        usage: selectionResult.usage || null,
        success: true,
        errorMessage: null,
        requestStartMs: selectionRequestStartMs,
        extraRequestPayload: {
          teamName,
          memberCount,
          successfulCount: successfulResults.length,
        },
      }).catch((loggingError: unknown) =>
        logger.error(
          `[TournamentRouter] Failed to log tournament judge request: ${getErrorMessage(loggingError)}`,
        ),
      );

      const judgeSubAgentResult: SubAgentResult = {
        agent_id: `tournament-judge-${teamName}-${Date.now()}`,
        description: `Tournament judge for team "${teamName}"`,
        status: "completed",
        summary: `Evaluated ${successfulResults.length} sub-agent results and selected the best one`,
        result: selectionResult.text,
        toolUses: 0,
        iterations: 1,
        durationMs: selectionDurationMs,
        messages: [],
        diff: { additions: 0, deletions: 0, files: [] },
      };

      const inputTokens = selectionResult.usage?.inputTokens ?? 0;
      const outputTokens = selectionResult.usage?.outputTokens ?? 0;

      logger.info(
        `[TournamentRouter] Judge selection complete in ${selectionDurationMs}ms (${inputTokens} input, ${outputTokens} output tokens)`,
      );

      return judgeSubAgentResult;
    } catch (judgeError: unknown) {
      const errorMessage =
        judgeError instanceof Error
          ? judgeError.message
          : String(judgeError);
      logger.error(
        `[TournamentRouter] Judge pass failed: ${errorMessage}`,
      );
      return null;
    }
  }
}
