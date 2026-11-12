import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import { schemaForTool, validateToolParams } from "../engine/tool-input.js";
import type { ClaudeClient, ClaudeDecideInput } from "./types.js";
import { buildAssistantSystemPrompt } from "./assistant-policy.js";
import { normalizeModelUsage } from "./usage.js";

/**
 * Client Claude réel (tool-use natif Anthropic). Structurellement complet et prêt à l'emploi —
 * TODO_LIVE_TEST : non exécutable tant que le crédit du compte Anthropic n'est pas rechargé
 * (cf AUDIT-AGENTS.md, "Your credit balance is too low"). À valider en conditions réelles
 * avant le vrai lancement (règle permanente 2026-07-26 : ne bloque pas le dev, mais bloque le launch).
 */
/**
 * Routage Haiku/Sonnet selon complexité (brief §PRICING "maximiser la marge") : un cycle avec peu
 * d'outils et peu de contexte est une décision simple (ex: choisir d'envoyer 1 relance générée à
 * partir de 2-3 champs) — Haiku suffit. Dès que le nombre d'outils ou le volume de contexte grandit,
 * la décision devient plus fine (arbitrages entre plusieurs actions possibles) — Sonnet reste utilisé.
 */
export function selectModel(input: ClaudeDecideInput): string {
  const contextSize = JSON.stringify(input.context).length;
  const isSimple = input.tools.length <= 2 && contextSize < 2000 && input.systemPrompt.length < 1500;
  return isSimple ? config.anthropicModelFast : config.anthropicModelMain;
}

export function createRealClaudeClient(): ClaudeClient {
  // KARTA owns durable delivery/recovery. The SDK's implicit retries can repeat
  // a paid inference after an ambiguous response, outside that execution log.
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });

  return {
    isMock: false,
    async decide(input: ClaudeDecideInput): Promise<AgentDecision> {
      const model = selectModel(input);
      const response = await client.messages.create({
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
