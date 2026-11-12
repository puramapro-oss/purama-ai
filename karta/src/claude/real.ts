import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import { schemaForTool, validateToolParams } from "../engine/tool-input.js";
import { bounded } from "../runtime/lifecycle.js";
import type { ClaudeClient, ClaudeDecideInput } from "./types.js";
import { buildAssistantSystemPrompt } from "./assistant-policy.js";
import { normalizeModelUsage } from "./usage.js";
import { createLmStudioTransport, type LmStudioOptions } from "./lmstudio.js";

/**
 * Client Claude réel (tool-use natif Anthropic). Structurellement complet et prêt à l'emploi —
 * TODO_LIVE_TEST : non exécutable tant que le crédit du compte Anthropic n'est pas rechargé
 * (cf AUDIT-AGENTS.md, "Your credit balance is too low"). À valider en conditions réelles
 * avant le vrai lancement (règle permanente 2026-07-26 : ne bloque pas le dev, mais bloque le launch).
 */
/**
 * Keep the primary model for sensitive, financial/legal and unqualified custom
 * decisions. Prompt length is a workload heuristic, not proof of equivalent
 * quality. Preserve the existing fast route only outside these guarded cases;
 * real model quality and cost still need workload-specific evaluation.
 */
export function selectModel(input: ClaudeDecideInput): string {
  if (input.agentType.startsWith("custom:") || input.tools.some(tool => tool.sensitive)
    || ["legal", "compta", "facture-pro", "rapports-financiers", "chasseur-de-paiements"].includes(input.agentType)) {
    return config.anthropicModelMain;
  }
  const contextSize = JSON.stringify(input.context).length;
  const isSimple = input.tools.length <= 2 && contextSize < 2000 && input.systemPrompt.length < 1500;
  return isSimple ? config.anthropicModelFast : config.anthropicModelMain;
}

export function createRealClaudeClient(options?: { lmStudio: LmStudioOptions }): ClaudeClient {
  const timeoutMs = config.anthropicTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("KARTA_MODEL_TIMEOUT_MS invalide : entier de 1000 à 120000 requis");
  }
  // KARTA owns durable delivery/recovery. The SDK's implicit retries can repeat
  // a paid inference after an ambiguous response, outside that execution log.
  const local = options ? createLmStudioTransport(options.lmStudio) : undefined;
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    ...local?.clientOptions,
    timeout: timeoutMs,
    maxRetries: 0,
    // The SDK's debug logger can include complete prompts and provider bodies.
    // KARTA records its own minimized traces instead.
    logLevel: "off",
  });

  return {
    isMock: false,
    async decide(input: ClaudeDecideInput): Promise<AgentDecision> {
      // Reuse the existing monotonic runtime bound. The SDK's fetch timeout
      // ends at headers; awaiting the full APIPromise also covers JSON/error
      // body consumption and discards late results from non-cooperative I/O.
      const { model, response } = await bounded(async signal => {
        // Select after admission so pre-cancelled calls do not read context;
        // keep the same selected model for the request and its usage receipt.
        const model = local?.model ?? selectModel(input);
        const send = () => client.messages.create({
          model,
          max_tokens: 1024,
          system: buildAssistantSystemPrompt(input.systemPrompt, 'task'),
          messages: [
            {
              role: "user",
              content: `Contexte actuel:\n${JSON.stringify(input.context)}\n\nDécide quelle(s) action(s) prendre.`,
            },
          ],
          tools: toAnthropicTools(input.tools),
        }, { signal, timeout: timeoutMs, maxRetries: 0 });
        const response = local ? await local.run(signal, input.tools.length > 0, send) : await send();
        return { model, response };
      }, timeoutMs, input.signal)
        .catch(() => {
          // Neither a provider response nor a caller's abort reason is safe
          // to copy into a public cycle error or the worker's failed log.
          throw new Error(input.signal?.aborted
            ? "Appel au modèle annulé : aucune décision disponible"
            : "Réponse du modèle indisponible ou délai dépassé : aucune décision disponible");
        });

      // Rejected/truncated decisions can still consume provider tokens. Keep
      // their receipt before validating content, without another HTTP request.
      input.onUsage?.(normalizeModelUsage(response, model, client.baseURL));

      // This client requests only client tools, without stop sequences or a
      // server-tool continuation loop. Never turn a truncated, paused, refused
      // or unknown completion into executable actions, even if its first tool
      // block is well formed. Do not retry a rejected decision automatically.
      if (response.stop_reason !== "end_turn" && response.stop_reason !== "tool_use") {
        throw new Error(response.stop_reason === "refusal"
          ? "Décision Claude refusée : aucune action exécutable"
          : "Décision Claude incomplète ou fin non prise en charge : aucune action exécutable");
      }
      if (!Array.isArray(response.content)) {
        throw new Error("Décision Claude invalide : contenu absent");
      }

      const toolCalls: AgentDecision["toolCalls"] = [];
      const toolIds = new Set<string>();
      let summary = "";

      for (const block of response.content) {
        if (!block || typeof block !== "object") {
          throw new Error("Décision Claude invalide : bloc de contenu incorrect");
        }
        if (block.type === "text") {
          if (typeof block.text !== "string") {
            throw new Error("Décision Claude invalide : texte incorrect");
          }
          summary += block.text;
        } else if (block.type === "tool_use") {
          if (response.stop_reason !== "tool_use" || typeof block.id !== "string"
            || !block.id.trim() || toolIds.has(block.id)) {
            throw new Error("Décision Claude incohérente : appel d'outil sans fin ou identifiant valide");
          }
          const tool = input.tools.find(candidate => candidate.name === block.name);
          if (!tool) throw new Error("Décision Claude invalide : outil non proposé");
          // Preflight the whole response before exposing any calls to KARTA.
          // Permission checks remain the engine's responsibility at execution
          // time; schema validity does not grant permission to execute.
          try { validateToolParams(tool, block.input); }
          catch { throw new Error("Décision Claude invalide : paramètres d'outil non conformes"); }
          toolIds.add(block.id);
          toolCalls.push({ tool: block.name, params: block.input });
        } else if (block.type !== "thinking" && block.type !== "redacted_thinking") {
          throw new Error("Décision Claude invalide : type de contenu non pris en charge");
        }
      }

      if (response.stop_reason === "tool_use" && toolCalls.length === 0) {
        throw new Error("Décision Claude incohérente : aucun appel d'outil reçu");
      }
      // An empty end_turn is possible in the API (e.g. after tool results), but
      // cannot prove a decision for this client's fresh, single-context request.
      if (response.stop_reason === "end_turn" && !summary.trim()) {
        throw new Error("Décision Claude vide : aucune conclusion exploitable");
      }

      return {
        summary: summary || "(aucun résumé texte — décision uniquement via appels d'outils)",
        toolCalls,
        requiresApproval: false, // décidé en aval par engine/autonomy.ts, pas par Claude lui-même
        mock: false,
      };
    },
  };
}

function toAnthropicTools(tools: AnyToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: schemaForTool(tool),
    strict: true,
  } as unknown as Anthropic.Tool));
}
