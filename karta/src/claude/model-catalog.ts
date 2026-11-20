import { bounded } from "../runtime/lifecycle.js";
import { normalizeModelCatalog, type ModelExecutionCapability, type ModelEffort } from "./execution-profile.js";

export interface CatalogModelLimit { model: string; maxOutputTokens: number }
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
        const capabilities = row(item.capabilities);
        const thinking = row(capabilities.thinking);
        const types = row(thinking.types);
        const effort = row(capabilities.effort);
        const levels = efforts.filter(level => supported(effort[level]));
        const maximum = Math.min(limit.maxOutputTokens, Number(item.max_tokens));
        if (supported(thinking) && supported(types.adaptive) && supported(effort) && levels.length) {
          models.push({ model: item.id, maxOutputTokens: maximum, reasoning: "adaptive", effortLevels: levels });
        } else if (supported(thinking) && supported(types.enabled)) {
          models.push({ model: item.id, maxOutputTokens: maximum, reasoning: "budget" });
        } else if (supported(types.disabled) || capabilities.thinking === null) {
          models.push({ model: item.id, maxOutputTokens: maximum, reasoning: "none" });
        }
      }
      return models.length ? normalizeModelCatalog(models) : [];
    }, timeout, signal);
  } catch { throw new Error("Catalogue du fournisseur indisponible"); }
}
