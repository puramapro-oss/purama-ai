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
export interface ToolInputSchema extends Record<string, unknown> {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolDefinition<Params = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  sensitive: boolean;
  inputSchema: ToolInputSchema;
  parseInput: (input: unknown) => Params;
  /** La frontière publique reçoit des données non fiables et les valide avant tout effet. */
  execute: (input: unknown, ctx: ToolExecutionContext) => Promise<Result>;
}

/**
 * Vue "effacée" d'un ToolDefinition, utilisée partout où des outils à Params hétérogènes
 * doivent cohabiter dans un même tableau (AgentDefinition.tools, ClaudeDecideInput.tools).
 * Chaque tool concret garde son typage précis à la définition (ex: gmailSendTool) ; c'est
 * uniquement au moment de l'agrégation que le résultat du parseur est effacé. Les outils créés
 * avec defineTool valident les paramètres dans execute, y compris hors de la boucle principale.
 */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

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
  /** Facultatif pour relire les anciens journaux ; écrit explicitement par les nouveaux cycles. */
  outcome?: "executed" | "failed" | "awaiting_approval" | "simulated" | "blocked" | "rejected" | "unknown";
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
  status: "success" | "error" | "awaiting_approval" | "skipped" | "simulated";
  decision: string;
  toolsUsed: ToolCallRecord[];
  resultSummary: string;
  errorMessage?: string;
  mock: boolean;
  /** Seul true autorise une reprise automatique ; absence ou résultat ambigu = arrêt. */
  retrySafe?: boolean;
  warnings?: string[];
}
