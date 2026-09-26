/** 4 agents cœur (compte admin, cf brief Phase 2) + 12 agents "action" du site (multi-tenant,
 * cf brief Phase 3) — slug identique à purama_ai.agents.slug pour les 12 derniers, ce qui permet
 * de joindre karta_agent_state/karta_runs directement sur le catalogue marketplace. */
export type CoreAgentType = "email" | "compta" | "legal" | "partner";

export type ActionAgentType =
  | "repondeur-intelligent"
  | "campagnes-par-courriel"
  | "pro-de-la-sensibilisation-au-froid"
  | "newsletter-genie"
  | "facture-pro"
  | "rapports-financiers"
  | "chasseur-de-paiements"
  | "crm-intelligent"
  | "machine-de-suivi"
  | "maitre-des-publicites"
  | "planificateur-d-appels"
  | "reservation-intelligente";

/** Les 16 agents "statiques" (définis en code, cf AGENT_REGISTRY) — union fermée, exhaustive. */
export type StaticAgentType = CoreAgentType | ActionAgentType;

/** Agent créé par un utilisateur (cf brief Phase 4 "Agent Créateur d'Agents") : `id` = creator_agents.id.
 * Type littéral gabarit (union ouverte) — AGENT_REGISTRY reste Record<StaticAgentType,...>, ces agents
 * sont résolus dynamiquement depuis la table `creator_agents` (cf agents/customAgent.ts), jamais depuis
 * le registre statique. */
export type CustomAgentType = `custom:${string}`;

export type AgentType = StaticAgentType | CustomAgentType;

export const ACTION_AGENT_TYPES: ActionAgentType[] = [
  "repondeur-intelligent",
  "campagnes-par-courriel",
  "pro-de-la-sensibilisation-au-froid",
  "newsletter-genie",
  "facture-pro",
  "rapports-financiers",
  "chasseur-de-paiements",
  "crm-intelligent",
  "machine-de-suivi",
  "maitre-des-publicites",
  "planificateur-d-appels",
  "reservation-intelligente",
];

export type AutonomyLevel = 1 | 2 | 3;

export type TriggerType = "cron" | "webhook" | "manual" | "delegation";

export interface AgentTrigger {
  type: TriggerType;
  source: string;
  /** Charge utile brute du déclencheur (payload webhook, nom du cron, etc.) */
  payload?: Record<string, unknown>;
}

export interface AgentState {
  userId: string;
  agentType: AgentType;
  isEnabled: boolean;
  autonomyLevel: AutonomyLevel;
  killSwitch: boolean;
  simulationMode: boolean;
}

/** Un outil que l'agent peut appeler. `sensitive: true` force la validation humaine en dessous du niveau 3. */
export interface ToolDefinition<Params = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  sensitive: boolean;
  execute: (params: Params, ctx: ToolExecutionContext) => Promise<Result>;
}

/**
 * Vue "effacée" d'un ToolDefinition, utilisée partout où des outils à Params hétérogènes
 * doivent cohabiter dans un même tableau (AgentDefinition.tools, ClaudeDecideInput.tools).
 * Chaque tool concret garde son typage précis à la définition (ex: gmailSendTool) ; c'est
 * uniquement au moment de l'agrégation dans un agent que le typage est effacé — la validation
 * réelle des params se fait dans engine/loop.ts au moment de l'exécution.
 *
 * `never` en position de paramètre (contravariance) : tout ToolDefinition<P> concret est
 * assignable à cette vue, puisque `never` est assignable à tout P. Un `unknown` ici exigerait
 * l'inverse (P assignable à unknown en paramètre de fn = interdit en strict), ce qui cassait
 * la compilation de toutes les agrégations d'outils (régression introduite puis reproduite
 * le 2026-09-26, cf ERRORS.md).
 */
export type AnyToolDefinition = ToolDefinition<never, unknown>;

/**
 * Unique point de levée du cast d'effacement : exécute un outil effacé avec des params réels.
 * Seul appelant légitime : `executeToolStrict` (engine/tool-result.ts), qui sert à la fois le
 * cycle (loop.ts) et l'exécution après validation humaine (approval.ts) — tout autre appel
 * doit être justifié.
 */
export function callErasedTool(
  tool: AnyToolDefinition,
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<unknown> {
  return tool.execute(params as never, ctx);
}

export interface ToolExecutionContext {
  userId: string;
  agentType: AgentType;
  mode: "simulation" | "live";
}

export interface ToolCallRecord {
  tool: string;
  paramsSummary: string;
  resultSummary: string;
  success: boolean;
  /** Présent uniquement pour un outil mis en attente de validation humaine (mode live) — id de la
   * ligne karta_pending_actions correspondante, pour retrouver/patcher cette entrée après résolution. */
  pendingActionId?: string;
}

/** Ce que Claude (ou le mock) retourne : la décision de l'agent pour ce cycle. */
export interface AgentDecision {
  summary: string;
  toolCalls: Array<{ tool: string; params: Record<string, unknown> }>;
  requiresApproval: boolean;
  /** true si la décision vient du mock Claude — propagé jusqu'à karta_runs.claude_mock */
  mock: boolean;
}

export interface AgentDefinition {
  type: AgentType;
  /** Construit le contexte (mémoire + données réelles) à passer au cerveau Claude. */
  buildContext: (userId: string, trigger: AgentTrigger) => Promise<Record<string, unknown>>;
  /** Prompt système spécifique à l'agent. */
  systemPrompt: string;
  /** Outils disponibles pour cet agent. */
  tools: AnyToolDefinition[];
}

export interface AgentRunResult {
  status: "success" | "error" | "awaiting_approval";
  decision: string;
  toolsUsed: ToolCallRecord[];
  resultSummary: string;
  errorMessage?: string;
  mock: boolean;
  /** true si le cycle a tenté au moins une exécution RÉELLE d'outil (mode live, hors simulation
   * et hors mise en attente d'approbation). Un rejeu BullMQ doublerait des side-effects déjà
   * commis (email parti, ligne insérée...) : le worker ne doit PAS relancer ces cycles —
   * il journalise et laisse la main à l'humain/cron suivant. */
  sideEffectsCommitted: boolean;
}
