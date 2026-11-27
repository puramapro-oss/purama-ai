import { isProxy } from "node:util/types";
import { bounded } from "../runtime/lifecycle.js";
import { normalizeModelCatalog, type ModelExecutionCapability, type ModelEffort } from "./execution-profile.js";
import { requestNativeProviderJson } from "./native-provider-http.js";

export interface CatalogModelLimit { model: string; maxOutputTokens: number }
export type ModelProvider = "anthropic" | "openai" | "google" | "xai";
export interface ConnectedModelLimit extends CatalogModelLimit {
  provider?: ModelProvider;
  reasoning?: ModelExecutionCapability["reasoning"];
  effortLevels?: ModelEffort[];
  /** Exact response identities separately qualified by the host for an alias. */
  responseModels?: string[];
}
const efforts: ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
const supported = (value: unknown): boolean => !!value && typeof value === "object"
  && (value as Record<string, unknown>).supported === true;
const row = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Discover the configured account's current capabilities; never infer them
 * from a model's name or grant spending rights from a successful list request. */
export async function loadAnthropicModelCatalog(options: {
  apiKey: string; allowed: CatalogModelLimit[]; fetch?: typeof fetch; timeoutMs?: number;
}, signal?: AbortSignal): Promise<ModelExecutionCapability[]> {
  const allowed = normalizeModelCatalog(options.allowed.map(item => ({ ...item, reasoning: "none" })));
  if (!options.apiKey || options.apiKey.trim() !== options.apiKey || /\s/.test(options.apiKey)) {
    throw new Error("Catalogue du fournisseur indisponible");
  }
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10_000) throw new Error("Délai de catalogue invalide");
  try {
    return await bounded(async active => {
      const response = await (options.fetch ?? fetch)("https://api.anthropic.com/v1/models?limit=1000", {
        method: "GET", redirect: "error", signal: active,
        headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!response.ok || !response.body || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      active.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          active.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 1_048_576) { cancel(); throw new Error(); }
          chunks.push(next.value);
        }
      } finally { active.removeEventListener("abort", cancel); reader.releaseLock(); }
      active.throwIfAborted();
      const raw = row(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      if (!Array.isArray(raw.data) || raw.data.length > 1000 || raw.has_more !== false) throw new Error();
      const models: ModelExecutionCapability[] = [];
      const seen = new Set<string>();
      for (const value of raw.data) {
        const item = row(value);
        if (typeof item.id !== "string" || seen.has(item.id)) throw new Error();
        seen.add(item.id);
        const limit = allowed.find(candidate => candidate.model === item.id);
        if (!limit || item.lifecycle !== "active" || !Number.isSafeInteger(item.max_tokens)
          || Number(item.max_tokens) < 1024) continue;
        const capabilities = row(Object.getOwnPropertyDescriptor(item, "capabilities")?.value);
        // The top-level code_execution capability denotes PTC. The similarly
        // named server_tools flag alone only qualifies a hosted code tool.
        const nativeCode = row(Object.getOwnPropertyDescriptor(capabilities, "code_execution")?.value);
        const serverTools = row(Object.getOwnPropertyDescriptor(capabilities, "server_tools")?.value);
        const hostedCode = row(Object.getOwnPropertyDescriptor(serverTools, "code_execution")?.value);
        const programmatic = Object.getOwnPropertyDescriptor(nativeCode, "supported")?.value === true
          && Object.getOwnPropertyDescriptor(hostedCode, "supported")?.value === true
          ? { programmaticToolCalling: true as const } : {};
        const thinking = row(capabilities.thinking);
        const types = row(thinking.types);
        const effort = row(capabilities.effort);
        const levels = efforts.filter(level => supported(effort[level]));
        const maximum = Math.min(limit.maxOutputTokens, Number(item.max_tokens));
        if (supported(thinking) && supported(types.adaptive) && supported(effort) && levels.length) {
          models.push({ model: item.id, maxOutputTokens: maximum, reasoning: "adaptive", effortLevels: levels, ...programmatic });
        } else if (supported(thinking) && supported(types.enabled)) {
          models.push({ model: item.id, maxOutputTokens: maximum, reasoning: "budget", ...programmatic });
        } else if (supported(types.disabled) || capabilities.thinking === null) {
          models.push({ model: item.id, maxOutputTokens: maximum, reasoning: "none", ...programmatic });
        }
      }
      return models.length ? normalizeModelCatalog(models) : [];
    }, timeout, signal);
  } catch { throw new Error("Catalogue du fournisseur indisponible"); }
}

const providers: ModelProvider[] = ["anthropic", "openai", "google", "xai"];
const googleModel = /^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,199}$(?![\s\S])/;
const invalidConnected = (): never => { throw new Error("Catalogue des modèles connectés invalide"); };

function catalogObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}

function catalogArray(value: unknown, maximum: number, minimum = 0): value is unknown[] {
  if (value === null || typeof value !== "object" || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

/** One host allowlist for discovery and execution. Model/profile validation is
 * delegated to the existing catalogue contract; no name grants capabilities. */
export function normalizeConnectedModelLimits(value: unknown): ConnectedModelLimit[] {
  if (!catalogArray(value, 32, 1)) return invalidConnected();
  const limits: ConnectedModelLimit[] = [];
  const googleIds = new Set<string>();
  for (const item of value) {
    if (!catalogObject(item) || Object.getOwnPropertyNames(item).some(key => ![
      "model", "maxOutputTokens", "provider", "reasoning", "effortLevels", "responseModels",
    ].includes(key))) return invalidConnected();
    const provider = Object.hasOwn(item, "provider") ? item.provider : "anthropic";
    if (typeof provider !== "string" || !providers.includes(provider as ModelProvider)) return invalidConnected();
    const profile = normalizeModelCatalog([{
      model: Object.getOwnPropertyDescriptor(item, "model")?.value,
      maxOutputTokens: Object.getOwnPropertyDescriptor(item, "maxOutputTokens")?.value,
      reasoning: Object.hasOwn(item, "reasoning") ? item.reasoning : "none",
      ...(Object.hasOwn(item, "effortLevels") ? { effortLevels: item.effortLevels } : {}),
    }])[0];
    if (((provider === "openai" || provider === "xai") && profile.reasoning === "budget")
      || (provider !== "anthropic" && profile.effortLevels?.includes("max"))) return invalidConnected();
    if (limits.some(limit => limit.model === profile.model)) return invalidConnected();
    if (provider === "google") {
      const identity = profile.model.replace(/^models\//, "");
      if (!googleModel.test(profile.model) || googleIds.has(identity)) return invalidConnected();
      googleIds.add(identity);
    }
    let responseModels: string[] | undefined;
    if (Object.hasOwn(item, "responseModels")) {
      if (!catalogArray(item.responseModels, 32, 1)) return invalidConnected();
      responseModels = normalizeModelCatalog(item.responseModels.map(model => ({
        model, reasoning: "none", maxOutputTokens: 1024,
      }))).map(model => model.model);
      if (provider === "google" && (responseModels.some(model => !googleModel.test(model))
        || new Set(responseModels.map(model => model.replace(/^models\//, ""))).size !== responseModels.length)) {
        return invalidConnected();
      }
    }
    limits.push({ ...profile, provider: provider as ModelProvider, ...(responseModels ? { responseModels } : {}) });
  }
  return limits;
}

function connectedCapability(limit: ConnectedModelLimit, maximum = limit.maxOutputTokens,
  effortLevels = limit.effortLevels): ModelExecutionCapability {
  return { model: limit.model, maxOutputTokens: Math.min(limit.maxOutputTokens, maximum),
    reasoning: limit.reasoning ?? "none", ...(effortLevels ? { effortLevels: [...effortLevels] } : {}) };
}

function accountModels(value: unknown): Record<string, unknown>[] {
  if (!catalogArray(value, 1000) || value.some(item => !catalogObject(item))) return invalidConnected();
  return value as Record<string, unknown>[];
}

async function nativeCatalog(provider: Exclude<ModelProvider, "anthropic">, apiKey: string,
  allowed: ConnectedModelLimit[], transport: typeof fetch | undefined, signal: AbortSignal): Promise<ModelExecutionCapability[]> {
  const found: ModelExecutionCapability[] = [];
  const seen = new Set<string>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    signal.throwIfAborted();
    const url = provider === "google" ? new URL("https://generativelanguage.googleapis.com/v1beta/models")
      : new URL(provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.x.ai/v1/language-models");
    if (provider === "google") {
      url.searchParams.set("pageSize", "1000");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    }
    const response = await requestNativeProviderJson({ url: url.toString(), provider, apiKey,
      method: "GET", fetch: transport, signal });
    signal.throwIfAborted();
    // OpenAI/xAI routes are not paginated. Never advertise a truncated custom
    // response as a complete account catalogue.
    if (provider !== "google" && (response.has_more === true || response.nextPageToken != null)) return invalidConnected();
    for (const item of accountModels(provider === "openai" ? response.data : response.models)) {
      const id = provider === "google" ? item.name : item.id;
      if (typeof id !== "string" || !id || id.length > 256 || seen.has(id)) return invalidConnected();
      seen.add(id);
      const identities = [id];
      if (provider === "xai" && Object.hasOwn(item, "aliases")) {
        if (!catalogArray(item.aliases, 32) || item.aliases.some(alias => typeof alias !== "string"
          || !alias || alias.length > 200 || seen.has(alias))) return invalidConnected();
        for (const alias of item.aliases as string[]) {
          if (identities.includes(alias)) return invalidConnected();
          identities.push(alias); seen.add(alias);
        }
      }
      const matches = allowed.filter(limit => provider === "google"
        ? `models/${limit.model.replace(/^models\//, "")}` === id : identities.includes(limit.model));
      if (!matches.length) continue;
      if (provider === "google") {
        if (!catalogArray(item.supportedGenerationMethods, 32)
          || !item.supportedGenerationMethods.includes("generateContent")
          || !Number.isSafeInteger(item.outputTokenLimit) || Number(item.outputTokenLimit) < 1024) continue;
        found.push(...matches.filter(limit => limit.reasoning === "none" || item.thinking !== false)
          .map(limit => connectedCapability(limit, Number(item.outputTokenLimit))));
      } else if (provider === "openai") {
        // This endpoint publishes no general output/effort capability matrix;
        // the exact host qualification remains the ceiling.
        if (item.shutdown_date != null && (typeof item.shutdown_date !== "string"
          || !Number.isFinite(Date.parse(item.shutdown_date)) || Date.parse(item.shutdown_date) <= Date.now())) continue;
        found.push(...matches.map(limit => connectedCapability(limit)));
      } else {
        if (["input_modalities", "output_modalities"].some(key => Object.hasOwn(item, key)
          && (!catalogArray(item[key], 32) || !(item[key] as unknown[]).includes("text")))) continue;
        const advertised = catalogObject(item.capabilities) ? item.capabilities.reasoning_effort : undefined;
        if (advertised !== undefined && (!catalogArray(advertised, 32)
          || advertised.some(level => typeof level !== "string"))) return invalidConnected();
        for (const limit of matches) {
          const levels = limit.effortLevels?.filter(level => advertised === undefined || (advertised as string[]).includes(level));
          if (limit.reasoning === "adaptive" && !levels?.length) continue;
          found.push(connectedCapability(limit, limit.maxOutputTokens, levels));
        }
      }
    }
    if (provider !== "google" || response.nextPageToken === undefined || response.nextPageToken === "") return found;
    if (typeof response.nextPageToken !== "string" || response.nextPageToken.length > 4096
      || seenTokens.has(response.nextPageToken)) return invalidConnected();
    seenTokens.add(response.nextPageToken);
    pageToken = response.nextPageToken;
  }
  // Discard partial results when the bounded pagination cannot finish.
  return invalidConnected();
}

/** Account discovery intersects the same explicit allowlist used for execution.
 * Each route has an independent deadline; a caller cancellation stops them all. */
export async function loadConnectedModelCatalog(options: {
  apiKeys: Partial<Record<ModelProvider, string>>;
  allowed: ConnectedModelLimit[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}, signal?: AbortSignal): Promise<ModelExecutionCapability[]> {
  signal?.throwIfAborted();
  const allowed = normalizeConnectedModelLimits(options.allowed);
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10_000) throw new Error("Délai de catalogue invalide");
  if (!catalogObject(options.apiKeys)) return invalidConnected();
  const results = await Promise.all(providers.map(async provider => {
    const routes = allowed.filter(limit => limit.provider === provider);
    const apiKey: unknown = Object.getOwnPropertyDescriptor(options.apiKeys, provider)?.value;
    if (!routes.length || typeof apiKey !== "string" || !apiKey || /\s/.test(apiKey)) return [];
    try {
      if (provider === "anthropic") return await loadAnthropicModelCatalog({ apiKey,
        allowed: routes.map(({ model, maxOutputTokens }) => ({ model, maxOutputTokens })),
        fetch: options.fetch, timeoutMs: timeout }, signal);
      return await bounded(active => nativeCatalog(provider, apiKey, routes, options.fetch, active), timeout, signal);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }));
  signal?.throwIfAborted();
  const byModel = new Map(results.flat().map(model => [model.model, model]));
  const ordered = allowed.flatMap(limit => byModel.has(limit.model) ? [byModel.get(limit.model)!] : []);
  return ordered.length ? normalizeModelCatalog(ordered) : [];
}
