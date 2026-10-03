import type { AgentDecision } from "../engine/types.js";
import type { ClaudeClient, ClaudeDecideInput } from "./types.js";

/**
 * Client Claude simulé — actif par défaut (KARTA_MOCK_CLAUDE=true) tant que le crédit Anthropic
 * n'est pas rechargé (règle permanente 2026-07-26 : ne jamais bloquer le dev sur les crédits).
 *
 * Chaque décision produite ici est un canevas de test, jamais une vraie inférence.
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
      const decision = MOCK_DECISIONS[input.agentType]?.(input) ?? genericItemsFallback(input);
      return { ...decision, mock: true };
    },
  };
}

/**
 * Fallback pour tout agent sans handler dédié (les 12 agents "action", cf actionAgents.ts) :
 * lit le signal générique `context.items` (array) que chacun expose, et si non vide, choisit le
 * premier outil "d'action" disponible dans les tools déclarés par CET agent (donc naturellement
 * pertinent — un agent facture n'a que generate_pdf, un agent CRM n'a que supabase_upsert...).
 */
const PREFERRED_TOOL_ORDER = [
  "gmail_create_draft",
  "gmail_send",
  "calendar_create_event",
  "generate_pdf",
  "supabase_upsert",
  "send_notification",
];

function genericItemsFallback(input: ClaudeDecideInput): AgentDecision {
  const items = Array.isArray(input.context.items) ? (input.context.items as unknown[]) : [];

  if (items.length === 0) {
    return {
      summary: `Simulation de test — rien à traiter pour l'agent "${input.agentType}" avec ce contexte.`,
      toolCalls: [],
      requiresApproval: false,
      mock: true,
    };
  }

  const chosenToolName = PREFERRED_TOOL_ORDER.find((name) => input.tools.some((t) => t.name === name));
  const tool = input.tools.find((t) => t.name === chosenToolName);

  return {
    summary: `Simulation de test — ${items.length} élément(s) à traiter pour "${input.agentType}"${tool ? ` → ${tool.name} proposé` : ""}.`,
    toolCalls: tool ? [{ tool: tool.name, params: { mock: true, itemsCount: items.length } }] : [],
    requiresApproval: true,
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
        summary: "Simulation de test — aucun nouvel email depuis le dernier passage. Rien à faire.",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    const first = newEmails[0] as Record<string, unknown>;
    const wantsDraft = toolExists(input, "gmail_create_draft");
    return {
      summary: `Simulation de test — ${newEmails.length} nouvel(aux) email(s). Le premier ("${first.subject ?? "sans sujet"}") semble être une demande simple → proposition de brouillon de réponse professionnelle.`,
      toolCalls: wantsDraft
        ? [
            {
              tool: "gmail_create_draft",
              params: {
                threadId: first.threadId ?? "mock-thread",
                to: first.from ?? "inconnu@example.com",
                subject: `Re: ${first.subject ?? ""}`,
                body: "Brouillon de test — Bonjour, merci pour votre message, nous revenons vers vous rapidement. Aucune réponse réelle ne sera envoyée.",
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
        summary: "Simulation de test — aucune déclaration en attente de préparation.",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    return {
      summary: `Simulation de test — ${pending.length} déclaration(s) à préparer avant échéance. Validation humaine requise avant toute action réelle.`,
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
        summary: "Simulation de test — aucune échéance juridique imminente détectée.",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    return {
      summary: `Simulation de test — ${deadlines.length} échéance(s) approchent. Une alerte serait proposée sans être envoyée.`,
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
        summary: "Simulation de test — aucun nouveau prospect à contacter ce cycle.",
        toolCalls: [],
        requiresApproval: false,
        mock: true,
      };
    }
    const first = prospects[0] as Record<string, unknown>;
    return {
      summary: `Simulation de test — nouveau prospect détecté ("${first.name ?? "inconnu"}"). Un brouillon de prospection serait proposé sans envoi réel.`,
      toolCalls: toolExists(input, "send_outreach_email")
        ? [{ tool: "send_outreach_email", params: { prospectId: first.id ?? "mock-id", template: "outreach_v1" } }]
        : [],
      requiresApproval: true,
      mock: true,
    };
  },
};

// Répondeur Intelligent (agent action) partage le même contexte que l'agent cœur Email
// (buildGmailInboxContext) — donc le même canevas mock.
MOCK_DECISIONS["repondeur-intelligent"] = MOCK_DECISIONS.email;
