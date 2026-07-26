import { getClaudeClient } from "../claude/index.js";
import { isRunnable, loadAgentState, recordRunOutcome, requiresHumanApproval } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { startRun } from "./logger.js";
import { notify } from "./notify.js";
import type { AgentDefinition, AgentRunResult, AgentTrigger, ToolCallRecord } from "./types.js";

/**
 * Boucle cœur KARTA : déclencheur → contexte → décision (Claude, mock ou réel) → outils → log → notif.
 * Un seul point d'entrée pour les 4 agents cœur — chaque agent ne fournit que sa définition
 * (buildContext, systemPrompt, tools), la boucle gère l'autonomie, le kill switch, le mode
 * simulation et la journalisation immuable de façon identique pour tous.
 */
export async function runAgentCycle(
  userId: string,
  definition: AgentDefinition,
  trigger: AgentTrigger
): Promise<AgentRunResult> {
  if (await isGlobalKillSwitchActive()) {
    return {
      status: "success",
      decision: "Cycle ignoré : kill switch global actif",
      toolsUsed: [],
      resultSummary: "kill switch global actif",
      mock: false,
    };
  }

  const state = await loadAgentState(userId, definition.type);

  const runnable = isRunnable(state);
  if (!runnable.ok) {
    await recordRunOutcome(userId, definition.type, "skipped");
    return {
      status: "success",
      decision: `Cycle ignoré : ${runnable.reason}`,
      toolsUsed: [],
      resultSummary: runnable.reason,
      mock: false,
    };
  }

  const mode: "simulation" | "live" = state.simulationMode ? "simulation" : "live";
  const run = await startRun(userId, definition.type, trigger, mode);
  const claude = getClaudeClient();

  try {
    const context = await definition.buildContext(userId, trigger);

    const decision = await claude.decide({
      systemPrompt: definition.systemPrompt,
      context,
      tools: definition.tools,
      agentType: definition.type,
    });

    const toolsUsed: ToolCallRecord[] = [];
    let awaitingApproval = false;

    for (const call of decision.toolCalls) {
      const tool = definition.tools.find((t) => t.name === call.tool);
      if (!tool) {
        toolsUsed.push({
          tool: call.tool,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: "outil inconnu — ignoré",
          success: false,
        });
        continue;
      }

      const needsApproval = decision.requiresApproval || requiresHumanApproval(state, tool.sensitive);

      if (needsApproval || mode === "simulation") {
        toolsUsed.push({
          tool: tool.name,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: mode === "simulation" ? "simulé — aucune action réelle (dry-run)" : "en attente de validation humaine",
          success: true,
        });
        awaitingApproval = awaitingApproval || (needsApproval && mode === "live");
        continue;
      }

      try {
        const result = await tool.execute(call.params, { userId, agentType: definition.type, mode });
        toolsUsed.push({
          tool: tool.name,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: summarize(result),
          success: true,
        });
      } catch (toolError) {
        toolsUsed.push({
          tool: tool.name,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: toolError instanceof Error ? toolError.message : String(toolError),
          success: false,
        });
      }
    }

    const status = awaitingApproval ? "awaiting_approval" : "success";
    const resultSummary = summarizeToolsUsed(toolsUsed, mode);

    await run.finish({
      status,
      decision: decision.summary,
      toolsUsed,
      resultSummary,
      mock: decision.mock,
    });

    if (awaitingApproval) {
      await notify({
        userId,
        agentType: definition.type,
        title: `${definition.type} : action en attente de validation`,
        body: decision.summary,
        actionType: "review",
        priority: "normal",
        channels: ["in_app"],
      });
    }

    await recordRunOutcome(userId, definition.type, "success");

    return { status, decision: decision.summary, toolsUsed, resultSummary, mock: decision.mock };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await run.finish({
      status: "error",
      decision: "",
      toolsUsed: [],
      resultSummary: "erreur avant complétion du cycle",
      errorMessage,
      mock: false,
    });
    await recordRunOutcome(userId, definition.type, "error");

    return {
      status: "error",
      decision: "",
      toolsUsed: [],
      resultSummary: "erreur avant complétion du cycle",
      errorMessage,
      mock: false,
    };
  }
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result.slice(0, 200);
  try {
    return JSON.stringify(result).slice(0, 200);
  } catch {
    return "ok";
  }
}

function summarizeToolsUsed(tools: ToolCallRecord[], mode: "simulation" | "live"): string {
  if (tools.length === 0) return "aucune action";
  const done = tools.filter((t) => t.success).length;
  return `${done}/${tools.length} action(s) ${mode === "simulation" ? "simulée(s)" : "exécutée(s)"}`;
}
