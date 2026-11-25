import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import type { ModelUsageReceipt, ProgrammaticUsageDetails } from "./usage.js";
import type { ModelExecutionPlan, ModelExecutionPreferences } from "./execution-profile.js";

export interface ClaudeDecideInput {
  systemPrompt: string;
  context: Record<string, unknown>;
  tools: AnyToolDefinition[];
  /** Utilisé par le mock pour varier la réponse de façon réaliste selon l'agent. */
  agentType: string;
  /** Optional caller cancellation; never forwarded in the model's prompt/context. */
  signal?: AbortSignal;
  /** Server-owned observation, called before decision validation; never sent to the model. */
  onUsage?: (receipt: ModelUsageReceipt, programmatic?: ProgrammaticUsageDetails) => void;
  /** KARTA-owned capability. Never serialized to a provider or derived from
   * prompt data. The transport cannot execute tool handlers on its own. */
  programmaticReads?: {
    readonly toolNames: readonly string[];
    beforeRequest(signal: AbortSignal): Promise<void>;
    execute(call: { id: string; tool: string; params: Record<string, unknown> }, signal: AbortSignal): Promise<string>;
  };
  /** Authenticated choice; independently qualified against the host catalogue. */
  preferences?: ModelExecutionPreferences;
  /** Effective resource settings, without secrets or internal reasoning. */
  onExecutionPlan?: (plan: ModelExecutionPlan) => void;
}

export interface ClaudeClient {
  /** true si ce client renvoie des réponses simulées (à propager dans karta_runs.claude_mock). */
  readonly isMock: boolean;
  decide: (input: ClaudeDecideInput) => Promise<AgentDecision>;
}
