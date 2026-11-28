import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import { schemaForTool, validateProgrammaticToolParams } from "../engine/tool-input.js";
import { bounded } from "../runtime/lifecycle.js";
import { buildAssistantSystemPrompt } from "./assistant-policy.js";
import { normalizeModelCatalog, resolveModelExecutionPlan, type ModelExecutionCapability,
  type ModelExecutionPlan } from "./execution-profile.js";
import { normalizeConnectedModelLimits, type ConnectedModelLimit, type ModelProvider } from "./model-catalog.js";
import { requestNativeProviderJson } from "./native-provider-http.js";
import { createRealClaudeClient } from "./real.js";
import type { ClaudeClient, ClaudeDecideInput } from "./types.js";
import { normalizeNativeModelUsage } from "./usage.js";

type NativeProvider = Exclude<ModelProvider, "anthropic">;
const invalid = (): never => { throw new Error("Décision du modèle invalide ou incomplète : aucune action exécutable"); };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Reuse the host's one catalogue and IAO decision contract. These adapters
 * only propose client tool calls; existing KARTA admission and authorization
 * execute them. Hosted tools, actions and modalities are never inferred from
 * account connectivity, nor enabled through a model's response. */
export function createConnectedModelClient(options: {
  apiKeys: Partial<Record<ModelProvider, string>>;
  allowed: ConnectedModelLimit[];
  modelCatalog: ModelExecutionCapability[];
  timeoutMs?: number;
  fetch?: typeof fetch;
}): ClaudeClient {
  const allowed = normalizeConnectedModelLimits(options.allowed);
  const catalog = normalizeModelCatalog(options.modelCatalog);
  const apiKeys = { ...options.apiKeys };
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000
    || catalog.some(model => !allowed.some(limit => limit.model === model.model
      && model.maxOutputTokens <= limit.maxOutputTokens
      && ((limit.provider ?? "anthropic") === "anthropic" || (model.programmaticToolCalling !== true
        && model.reasoning === (limit.reasoning ?? "none")
        && (model.effortLevels ?? []).every(effort => limit.effortLevels?.includes(effort))))))) {
    throw new Error("Catalogue de routes non qualifié");
  }
  let anthropic: ClaudeClient | undefined;
  return {
    isMock: false,
    async decide(input: ClaudeDecideInput): Promise<AgentDecision> {
      if (input.signal?.aborted) throw new Error("Appel au modèle annulé : aucune décision disponible");
      // A native multi-provider route must be selected explicitly. There is no
      // fallback to another provider/account after a paid or ambiguous call.
      if (!input.preferences) throw new Error("Sélection explicite du modèle requise");
      const plan = resolveModelExecutionPlan(input.preferences, catalog, timeoutMs);
      const limit = allowed.find(item => item.model === plan.model)!;
      const provider = limit.provider ?? "anthropic";
      const apiKey = apiKeys[provider];
      if (!apiKey || /\s/.test(apiKey)) throw new Error("Compte fournisseur indisponible");
      if (provider === "anthropic") {
        anthropic ??= createRealClaudeClient({
          modelCatalog: catalog.filter(model => allowed.some(route => route.model === model.model
            && (route.provider ?? "anthropic") === "anthropic")),
          nativeAnthropicAccount: { apiKey },
        });
        return anthropic.decide(input);
      }
      input.onExecutionPlan?.(structuredClone(plan));
      const tools = uniqueTools(input.tools);
      const response = await bounded(async signal => {
        const system = buildAssistantSystemPrompt(input.systemPrompt, "task");
        const prompt = `Contexte actuel:\n${JSON.stringify(input.context)}\n\nDécide quelle(s) action(s) prendre.`;
        const request = nativeRequest(provider, plan, system, prompt, tools);
        return requestNativeProviderJson({ ...request, method: "POST", apiKey, provider,
          fetch: options.fetch, signal });
      }, plan.timeoutMs, input.signal).catch(() => {
        throw new Error(input.signal?.aborted
          ? "Appel au modèle annulé : aucune décision disponible"
          : "Réponse du modèle indisponible ou délai dépassé : aucune décision disponible");
      });
      // Capture billed but rejected/truncated responses before validating any
      // decision. Whitelisted counters never include prompts or reasoning text.
      const receipt = normalizeNativeModelUsage(response, plan.model, provider);
      input.onUsage?.(receipt);
      const identity = (model: string) => provider === "google" ? model.replace(/^models\//, "") : model;
      if (receipt.responseModel === null || ![plan.model, ...(limit.responseModels ?? [])]
        .some(model => identity(model) === identity(receipt.responseModel!))) {
        throw new Error("Le fournisseur n’a pas confirmé le modèle choisi : aucune action exécutable");
      }
      if (input.signal?.aborted) throw new Error("Appel au modèle annulé : aucune décision disponible");
      return provider === "google" ? geminiDecision(response, tools) : responsesDecision(response, tools);
    },
  };
}

function uniqueTools(tools: AnyToolDefinition[]): AnyToolDefinition[] {
  if (!Array.isArray(tools) || tools.length > 128) return invalid();
  const unique = new Map<string, AnyToolDefinition>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$(?![\s\S])/.test(tool.name)) return invalid();
    if (unique.has(tool.name) && unique.get(tool.name) !== tool) throw new Error("Catalogue d’outils ambigu");
    unique.set(tool.name, tool);
  }
  return [...unique.values()];
}

function nativeRequest(provider: NativeProvider, plan: ModelExecutionPlan, system: string,
  prompt: string, tools: AnyToolDefinition[]): { url: string; body: Record<string, unknown> } {
  const effort = plan.providerOptions.output_config?.effort;
  if (provider === "google") {
    const thinking = plan.providerOptions.thinking;
    // The host qualifies either numeric-budget or level-based Gemini models;
    // do not send Anthropic's thinking/output_config fields to this endpoint.
    const thinkingConfig = thinking?.type === "enabled" ? { thinkingBudget: thinking.budget_tokens }
      : effort ? { thinkingLevel: effort.toUpperCase() } : undefined;
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${plan.model.replace(/^models\//, "")}:generateContent`, body: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: plan.maxOutputTokens, ...(thinkingConfig ? { thinkingConfig } : {}) },
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name,
        description: tool.description, parametersJsonSchema: schemaForTool(tool) })) }] } : {}),
    } };
  }
  return { url: provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.x.ai/v1/responses", body: {
    model: plan.model, instructions: system, input: prompt, store: false,
    max_output_tokens: plan.maxOutputTokens,
    ...(effort ? { reasoning: { effort } } : {}),
    // Explicit non-strict mode preserves the existing tools' optional fields.
    // Their full supported schema is checked locally before exposing calls.
    ...(tools.length ? { tools: tools.map(tool => ({ type: "function", name: tool.name,
      description: tool.description, parameters: schemaForTool(tool), strict: false })) } : {}),
  } };
}

function decision(summary: string, toolCalls: AgentDecision["toolCalls"]): AgentDecision {
  if (!summary.trim() && toolCalls.length === 0) return invalid();
  return { summary: summary || "(aucun résumé texte — décision uniquement via appels d’outils)",
    toolCalls, requiresApproval: false, mock: false };
}

function appendTool(tools: AnyToolDefinition[], calls: AgentDecision["toolCalls"], name: unknown, args: unknown): void {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool || calls.length >= 128) return invalid();
  try { validateProgrammaticToolParams(tool, args); } catch { return invalid(); }
  calls.push({ tool: tool.name, params: args as Record<string, unknown> });
}

function responsesDecision(response: Record<string, unknown>, tools: AnyToolDefinition[]): AgentDecision {
  if (response.status !== "completed" || response.error != null || response.incomplete_details != null
    || !Array.isArray(response.output) || response.output.length > 1024) return invalid();
  const calls: AgentDecision["toolCalls"] = [], ids = new Set<string>(), summaries: string[] = [];
  for (const item of response.output) {
    if (!object(item)) return invalid();
    if (item.type === "reasoning") continue; // Never expose provider reasoning as final answer.
    if (item.type === "message") {
      if (item.role !== "assistant" || (item.status !== undefined && item.status !== "completed")
        || !Array.isArray(item.content) || item.content.length > 1024) return invalid();
      for (const part of item.content) {
        if (!object(part) || part.type !== "output_text" || typeof part.text !== "string") return invalid();
        summaries.push(part.text);
      }
    } else if (item.type === "function_call") {
      if ((item.status !== undefined && item.status !== "completed") || typeof item.call_id !== "string"
        || !item.call_id.trim() || item.call_id.length > 200 || ids.has(item.call_id)
        || typeof item.arguments !== "string" || item.arguments.length > 65_536) return invalid();
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { return invalid(); }
      appendTool(tools, calls, item.name, args);
      ids.add(item.call_id);
    } else return invalid();
  }
  return decision(summaries.join("\n"), calls);
}

function geminiDecision(response: Record<string, unknown>, tools: AnyToolDefinition[]): AgentDecision {
  if (response.error != null || (response.promptFeedback !== undefined && !object(response.promptFeedback))
    || (object(response.promptFeedback) && response.promptFeedback.blockReason != null)
    || !Array.isArray(response.candidates) || response.candidates.length !== 1) return invalid();
  const candidate: unknown = response.candidates[0];
  if (!object(candidate) || candidate.finishReason !== "STOP" || !object(candidate.content)
    || candidate.content.role !== "model" || !Array.isArray(candidate.content.parts)
    || candidate.content.parts.length > 1024) return invalid();
  const calls: AgentDecision["toolCalls"] = [], ids = new Set<string>(), summaries: string[] = [];
  for (const part of candidate.content.parts) {
    if (!object(part)) return invalid();
    if ((Object.hasOwn(part, "thought") && typeof part.thought !== "boolean")
      || (Object.hasOwn(part, "thoughtSignature") && typeof part.thoughtSignature !== "string")) return invalid();
    // A reasoning part is not a tool proposal or user-facing final text.
    if (part.thought === true) {
      if (typeof part.text !== "string" || Object.keys(part).some(key => !["text", "thought", "thoughtSignature"].includes(key))) return invalid();
      continue;
    }
    const keys = Object.keys(part);
    if (typeof part.text === "string" && keys.every(key => ["text", "thought", "thoughtSignature"].includes(key))) {
      summaries.push(part.text);
    } else if (object(part.functionCall) && keys.every(key => ["functionCall", "thought", "thoughtSignature"].includes(key))) {
      const call = part.functionCall;
      if (call.id !== undefined && (typeof call.id !== "string" || !call.id.trim()
        || call.id.length > 200 || ids.has(call.id))) return invalid();
      appendTool(tools, calls, call.name, Object.hasOwn(call, "args") ? call.args : {});
      if (typeof call.id === "string") ids.add(call.id);
    } else return invalid();
  }
  return decision(summaries.join("\n"), calls);
}
