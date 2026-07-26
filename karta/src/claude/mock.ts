import type { AgentDecision } from "../engine/types.js";
import type { ClaudeClient, ClaudeDecideInput } from "./types.js";

/**
 * Client Claude simulé — actif par défaut (KARTA_MOCK_CLAUDE=true) tant que le crédit Anthropic
 * n'est pas rechargé (règle permanente 2026-07-26 : ne jamais bloquer le dev sur les crédits).
 *
 * TODO_LIVE_TEST : chaque décision produite ici est un canevas réaliste, pas une vraie inférence.
 * Avant le vrai lancement, repasser KARTA_MOCK_CLAUDE=false et valider CHAQUE agent avec
 * createRealClaudeClient() + un vrai crédit Anthropic (cf task_plan.md, section "prêt à tester").
 *
 * Logique : simule un raisonnement simple à partir des signaux présents dans le contexte
 * (ex: `newEmails`, `pendingDeclarations`, `upcomingDeadlines`, `newProspects`) pour que le
 * reste du moteur (autonomie, outils, logs, notifications) soit exercé de façon réaliste
 * par les tests d'intégration, sans dépendre d'un vrai appel API.
 */
export function createMockClaudeClient(): ClaudeClient {
  return {
    isMock: true,
    async decide(input: ClaudeDecideInput): Promise<AgentDecision> {
      const decision = MOCK_DECISIONS[input.agentType]?.(input) ?? genericNoOp(input);
      return { ...decision, mock: true };
    },
  };
}

function genericNoOp(input: ClaudeDecideInput): AgentDecision {
  return {
    summary: `[MOCK] Rien à traiter pour l'agent "${input.agentType}" avec ce contexte (TODO_LIVE_TEST).`,
    toolCalls: [],
    requiresApproval: false,
    mock: true,
  };
}

function firstArray(context: Record<string, unknown>, key: string): unknown[] {
  const value = context[key];
  return Array.isArray(value) ? value : [];
}

function toolExists(input: ClaudeDecideInput, name: string): boolean {
  return input.tools.some((t) => t.name === name);
}

const MOCK_DECISIONS: Record<string, (input: ClaudeDecideInput) => AgentDecision> = {
  email: (input) => {
    const newEmails = firstArray(input.context, "newEmails");
    if (newEmails.length === 0) {
      return {
        summary: "[MOCK] Aucun nouvel email depuis le dernier passage. Rien à faire (TODO_LIVE_TEST).",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    const first = newEmails[0] as Record<string, unknown>;
    const wantsDraft = toolExists(input, "gmail_create_draft");
    return {
      summary: `[MOCK] ${newEmails.length} nouvel(aux) email(s). Le premier ("${first.subject ?? "sans sujet"}") semble être une demande simple → proposition de brouillon de réponse professionnelle (TODO_LIVE_TEST).`,
      toolCalls: wantsDraft
        ? [
            {
              tool: "gmail_create_draft",
              params: {
                threadId: first.threadId ?? "mock-thread",
                to: first.from ?? "inconnu@example.com",
                subject: `Re: ${first.subject ?? ""}`,
                body: "[MOCK] Bonjour, merci pour votre message, nous revenons vers vous rapidement. (réponse simulée — TODO_LIVE_TEST)",
              },
            },
          ]
        : [],
      requiresApproval: true,
      mock: true,
    };
  },

  compta: (input) => {
    const pending = firstArray(input.context, "pendingDeclarations");
    if (pending.length === 0) {
      return {
        summary: "[MOCK] Aucune déclaration en attente de préparation (TODO_LIVE_TEST).",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    return {
      summary: `[MOCK] ${pending.length} déclaration(s) à préparer avant échéance. Préparation du calcul et du document, validation humaine requise avant envoi (obligation légale, TODO_LIVE_TEST).`,
      toolCalls: toolExists(input, "supabase_upsert")
        ? [{ tool: "supabase_upsert", params: { table: "compta_transactions", note: "mock: catégorisation simulée" } }]
        : [],
      requiresApproval: true,
      mock: true,
    };
  },

  legal: (input) => {
    const deadlines = firstArray(input.context, "upcomingDeadlines");
    if (deadlines.length === 0) {
      return {
        summary: "[MOCK] Aucune échéance juridique imminente détectée (TODO_LIVE_TEST).",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    return {
      summary: `[MOCK] ${deadlines.length} échéance(s) approchent. Génération d'une alerte utilisateur (TODO_LIVE_TEST).`,
      toolCalls: toolExists(input, "send_notification")
        ? [{ tool: "send_notification", params: { title: "Échéance juridique à venir (simulation)" } }]
        : [],
      requiresApproval: false,
      mock: true,
    };
  },

  partner: (input) => {
    const prospects = firstArray(input.context, "newProspects");
    if (prospects.length === 0) {
      return {
        summary: "[MOCK] Aucun nouveau prospect à contacter ce cycle (TODO_LIVE_TEST).",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    const first = prospects[0] as Record<string, unknown>;
    return {
      summary: `[MOCK] Nouveau prospect détecté ("${first.name ?? "inconnu"}"). Rédaction d'un email de prospection personnalisé simulé (TODO_LIVE_TEST).`,
      toolCalls: toolExists(input, "send_outreach_email")
        ? [{ tool: "send_outreach_email", params: { prospectId: first.id ?? "mock-id", template: "outreach_v1" } }]
        : [],
      requiresApproval: true,
      mock: true,
    };
  },
};
