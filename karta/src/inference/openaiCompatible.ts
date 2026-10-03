import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import type { InferenceInput, InferenceProvider } from "./types.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  modelMain: string;
  modelFast?: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{
    function?: { name?: string; arguments?: string };
  }> } }>;
}

class NonRetryableProviderError extends Error {}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): InferenceProvider {
  const baseUrl = validateBaseUrl(options.baseUrl);
  if (!options.modelMain) throw new Error("AI_MODEL_MAIN est requis pour un fournisseur OpenAI-compatible");
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 2) {
    throw new Error("AI_MAX_RETRIES doit etre compris entre 0 et 2");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
    throw new Error("AI_TIMEOUT_MS doit etre compris entre 1000 et 120000");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    isMock: false,
    async decide(input: InferenceInput): Promise<AgentDecision> {
      const body = {
        model: selectModel(input, options),
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: `Contexte actuel:\n${JSON.stringify(input.context, null, 2)}\n\nDecide quelle(s) action(s) prendre.` },
        ],
        tools: input.tools.map(toOpenAITool),
        tool_choice: "auto",
        temperature: 0,
      };
      const response = await requestWithRetry(fetchImpl, `${baseUrl}/chat/completions`, body, options);
      const payload = await response.json() as CompletionResponse;
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("Reponse OpenAI-compatible invalide: message absent");
      const toolCalls: AgentDecision["toolCalls"] = [];
      for (const call of message.tool_calls ?? []) {
        const name = call.function?.name;
        if (!name) throw new Error("Reponse OpenAI-compatible invalide: nom d'outil absent");
        let params: unknown;
        try {
          params = JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          throw new Error(`Reponse OpenAI-compatible invalide: arguments JSON de ${name}`);
        }
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          throw new Error(`Reponse OpenAI-compatible invalide: arguments de ${name}`);
        }
        toolCalls.push({ tool: name, params: params as Record<string, unknown> });
      }
      return {
        summary: message.content?.trim() || "(aucun resume texte - decision uniquement via appels d'outils)",
        toolCalls,
        requiresApproval: false,
        mock: false,
      };
    },
  };
}

function validateBaseUrl(value: string): string {
  if (!value) throw new Error("AI_BASE_URL est requis pour un fournisseur OpenAI-compatible");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("AI_BASE_URL doit utiliser HTTP(S)");
  return url.toString().replace(/\/$/, "");
}

function selectModel(input: InferenceInput, options: OpenAICompatibleOptions): string {
  const contextSize = JSON.stringify(input.context).length;
  const simple = input.tools.length <= 2 && contextSize < 2_000 && input.systemPrompt.length < 1_500;
  return simple && options.modelFast ? options.modelFast : options.modelMain;
}

function toOpenAITool(tool: AnyToolDefinition): Record<string, unknown> {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  options: OpenAICompatibleOptions,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) return response;
      const detail = (await response.text()).slice(0, 300);
      const error = new Error(`Fournisseur OpenAI-compatible ${response.status}: ${detail}`);
      if (!isRetryable(response.status)) throw new NonRetryableProviderError(error.message);
      if (attempt === options.maxRetries) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof NonRetryableProviderError) throw error;
      lastError = error;
      if (attempt === options.maxRetries) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Echec du fournisseur OpenAI-compatible");
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
