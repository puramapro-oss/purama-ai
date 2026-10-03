import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";

export interface InferenceInput {
  systemPrompt: string;
  context: Record<string, unknown>;
  tools: AnyToolDefinition[];
  agentType: string;
}

export interface InferenceProvider {
  readonly isMock: boolean;
  decide: (input: InferenceInput) => Promise<AgentDecision>;
}
