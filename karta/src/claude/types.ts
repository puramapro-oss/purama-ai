import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import type { ModelUsageReceipt } from "./usage.js";

export interface ClaudeDecideInput {
  systemPrompt: string;
  context: Record<string, unknown>;
  tools: AnyToolDefinition[];
  /** Utilisé par le mock pour varier la réponse de façon réaliste selon l'agent. */
  agentType: string;
  /** Optional caller cancellation; never forwarded in the model's prompt/context. */
  signal?: AbortSignal;
  /** Server-owned observation, called before decision validation; never sent to the model. */
  onUsage?: (receipt: ModelUsageReceipt) => void;
}

export interface ClaudeClient {
  /** true si ce client renvoie des réponses simulées (à propager dans karta_runs.claude_mock). */
  readonly isMock: boolean;
  decide: (input: ClaudeDecideInput) => Promise<AgentDecision>;
}
