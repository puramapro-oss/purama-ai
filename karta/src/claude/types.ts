import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";

export interface ClaudeDecideInput {
  systemPrompt: string;
  context: Record<string, unknown>;
  tools: AnyToolDefinition[];
  /** Utilisé par le mock pour varier la réponse de façon réaliste selon l'agent. */
  agentType: string;
}

export interface ClaudeClient {
  /** true si ce client renvoie des réponses simulées (à propager dans karta_runs.claude_mock). */
  readonly isMock: boolean;
  decide: (input: ClaudeDecideInput) => Promise<AgentDecision>;
}
