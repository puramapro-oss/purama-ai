import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import type { ClaudeClient, ClaudeDecideInput } from "./types.js";

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
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    isMock: false,
    async decide(input: ClaudeDecideInput): Promise<AgentDecision> {
      const response = await client.messages.create({
        model: selectModel(input),
        max_tokens: 1024,
        system: input.systemPrompt,
        messages: [
          {
            role: "user",
            content: `Contexte actuel:\n${JSON.stringify(input.context, null, 2)}\n\nDécide quelle(s) action(s) prendre.`,
          },
        ],
        tools: toAnthropicTools(input.tools),
      });

      const toolCalls: AgentDecision["toolCalls"] = [];
      let summary = "";

      for (const block of response.content) {
        if (block.type === "text") {
          summary += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({ tool: block.name, params: block.input as Record<string, unknown> });
        }
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
    input_schema: { type: "object", properties: {}, additionalProperties: true },
  }));
}
