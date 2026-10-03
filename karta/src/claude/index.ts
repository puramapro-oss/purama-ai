import { config } from "../config.js";
import { createMockClaudeClient } from "./mock.js";
import { createRealClaudeClient } from "./real.js";
import type { ClaudeClient } from "./types.js";
import { createOpenAICompatibleProvider } from "../inference/openaiCompatible.js";
import { withOptInFallback } from "../inference/fallback.js";
import type { InferenceProvider } from "../inference/types.js";

export type { ClaudeClient, ClaudeDecideInput } from "./types.js";

let cached: InferenceProvider | null = null;

/** Sélectionne le fournisseur explicitement validé par la configuration. */
export function getClaudeClient(): ClaudeClient {
  if (!cached) {
    const primary = createProvider(config.aiProvider);
    const fallback = config.aiFallbackProvider === "none" ? undefined : createProvider(config.aiFallbackProvider);
    cached = withOptInFallback(primary, fallback);
  }
  return cached;
}

export const getInferenceProvider = getClaudeClient;

function createProvider(provider: typeof config.aiProvider): InferenceProvider {
  if (provider === "mock") return createMockClaudeClient();
  if (provider === "anthropic") return createRealClaudeClient();
  const ollama = provider === "ollama";
  return createOpenAICompatibleProvider({
    baseUrl: config.aiBaseUrl || (ollama ? "http://127.0.0.1:11434/v1" : ""),
    apiKey: config.aiApiKey,
    modelMain: config.aiModelMain,
    modelFast: config.aiModelFast,
    timeoutMs: config.aiTimeoutMs,
    maxRetries: config.aiMaxRetries,
  });
}
