import { config } from "../config.js";
import { bounded } from "../runtime/lifecycle.js";
import { isGlobalKillSwitchActive } from "../engine/killswitch.js";
import type { ConsultationCatalog, ConsultationHost, ConsultationInput, ConsultationOperation as PublicOperation } from "../api/consultation-contract.js";
import { createConnectedResearchClient } from "../knowledge/connected-research.js";
import { createRealClaudeClient } from "./real.js";
import { loadAnthropicModelCatalog } from "./model-catalog.js";
import { normalizeModelCatalog, resolveModelExecutionPlan, type ModelExecutionCapability } from "./execution-profile.js";
import { normalizeConsultationRequest, runModelConsultation, type ConsultationRequest, type ConsultationResult, type ConsultationDependencies } from "./consultation.js";
import { createConsultationStore, type ConsultationEstimates, type ConsultationOperation } from "./consultation-store.js";
import type { ClaudeClient } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OVERHEAD = 16_384;
interface ModelPolicy { model: string; maxInputTokens: number; maxOutputTokens: number; maxCostMicros: number }
interface ConsultationPolicy {
  version: string;
  expiresAt: string;
  models: ModelPolicy[];
  research?: { searchMaxCostMicros?: number; scrapeMaxCostMicros?: number };
}
const failure = (code: string): Error => Object.assign(new Error("Consultation indisponible"), { code });
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function parsePolicy(raw: string | undefined): ConsultationPolicy | null {
  if (!raw || raw.length > 32_768) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (!object(p) || Object.keys(p).some(k => !["version", "expiresAt", "models", "research"].includes(k))
      || typeof p.version !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(p.version)
      || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))
      || !Array.isArray(p.models) || p.models.length < 1 || p.models.length > 32) return null;
    const models: ModelPolicy[] = [];
    for (const m of p.models) {
      if (!object(m) || Object.keys(m).some(k => !["model", "maxInputTokens", "maxOutputTokens", "maxCostMicros"].includes(k))
        || typeof m.model !== "string" || !integer(m.maxInputTokens, 32_768, 278_528)
        || !integer(m.maxOutputTokens, 1024, 65_536) || !integer(m.maxCostMicros, 1, 1_000_000_000)) return null;
      models.push({ model: m.model, maxInputTokens: m.maxInputTokens, maxOutputTokens: m.maxOutputTokens, maxCostMicros: m.maxCostMicros });
    }
    normalizeModelCatalog(models.map(m => ({ model: m.model, maxOutputTokens: m.maxOutputTokens, reasoning: "none" })));
    let research: ConsultationPolicy["research"];
    if (p.research !== undefined) {
      if (!object(p.research) || Object.keys(p.research).some(k => !["searchMaxCostMicros", "scrapeMaxCostMicros"].includes(k))) return null;
      research = {};
      for (const key of ["searchMaxCostMicros", "scrapeMaxCostMicros"] as const) {
        const value = p.research[key];
        if (value !== undefined) { if (!integer(value, 1, 1_000_000_000)) return null; research[key] = value; }
      }
    }
    return { version: p.version, expiresAt: p.expiresAt, models, ...(research ? { research } : {}) };
  } catch { return null; }
}
/** Bound persisted excerpts in encoded bytes, including JSON escapes. Keep the
 * complete answer, citation identities, URLs and private usage receipts. */
function persistableConsultationResult(result: ConsultationResult): ConsultationResult {
  const excerpt = (value: string, maximum: number): string => {
    let lower = 0; let upper = value.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (Buffer.byteLength(JSON.stringify(value.slice(0, middle)), "utf8") <= maximum) lower = middle;
      else upper = middle - 1;
    }
    if (lower && /[\uD800-\uDBFF]/.test(value[lower - 1])) lower--;
    return value.slice(0, lower);
  };
  let remaining = 16_384;
  return { ...result, sources: result.sources.map(source => {
    const text = excerpt(source.text.slice(0, 2000), Math.min(2048, Math.max(2, remaining)));
    remaining -= Buffer.byteLength(JSON.stringify(text), "utf8");
    const title = excerpt(source.title, 128);
    return { ...source, text, title, truncated: source.truncated === true || text !== source.text || title !== source.title };
  }) };
}
function publicOperation(value: ConsultationOperation): PublicOperation {
  const source = value.result;
  let remaining = 32_000;
  const result = source ? {
    status: source.status, reason: source.reason,
    plan: { model: source.plan.model, reflection: source.plan.reflection, speed: source.plan.speed,
      maxOutputTokens: source.plan.maxOutputTokens, timeoutMs: source.plan.timeoutMs, research: { ...source.plan.research } },
    answer: source.answer, citedSourceIds: [...source.citedSourceIds], disagreements: [...source.disagreements],
    uncertainties: [...source.uncertainties], verificationStatus: "unverified" as const,
    sources: source.sources.map(s => {
      const text = s.text.slice(0, Math.min(2000, remaining)); remaining -= text.length;
      return { id: s.id, provider: s.provider, retrievedAt: s.retrievedAt, url: s.url,
        title: s.title.slice(0, 512), text, contentKind: s.contentKind,
        verificationStatus: "unverified" as const, truncated: s.truncated === true || text !== s.text || s.title.length > 512 };
    }),
  } : null;
  return { operationId: value.operationId, cancelRequested: value.cancelRequested, result,
    status: value.resourceState === "reconciliation_required" ? "reconciliation_required"
      : value.state === "pending" ? "running" : value.state === "interrupted" ? "failed" : value.state };
}
function storeError(error: unknown): never {
  const code = object(error) ? error.code : undefined;
  throw failure(code === "conflict" ? "IAO_CONFLICT" : code === "budget_unavailable" ? "IAO_BUDGET"
    : code === "invalid" ? "IAO_INVALID" : "IAO_UNAVAILABLE");
}

/** One host composition, using the existing CHEF resource authority. The public
 * request cannot allocate a budget, change provider endpoints or enable mocks. */
export function createConsultationHost(options: {
  policyJson?: string;
  apiKey?: string;
  simulation?: boolean;
  store?: ReturnType<typeof createConsultationStore>;
  loadCatalog?: (limits: ModelPolicy[], signal: AbortSignal) => Promise<ModelExecutionCapability[]>;
  createClient?: (catalog: ModelExecutionCapability[]) => ClaudeClient;
  research?: ConsultationDependencies["research"];
  searchConfigured?: boolean;
  scrapeConfigured?: boolean;
  stopped?: () => Promise<boolean>;
  now?: () => number;
} = {}): ConsultationHost {
  const policy = parsePolicy(options.policyJson ?? process.env.KARTA_CONSULTATION_POLICY_JSON);
  const apiKey = options.apiKey ?? config.anthropicApiKey;
  const simulation = options.simulation ?? config.mockClaude;
  const store = options.store ?? createConsultationStore();
  const now = options.now ?? Date.now;
  const stopped = options.stopped ?? (() => isGlobalKillSwitchActive(true));
  const research = options.research ?? createConnectedResearchClient({
    perplexityApiKey: process.env.PERPLEXITY_API_KEY, firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
  });
  const search = (options.searchConfigured ?? !!process.env.PERPLEXITY_API_KEY) && !!policy?.research?.searchMaxCostMicros;
  const scrape = (options.scrapeConfigured ?? !!process.env.FIRECRAWL_API_KEY) && !!policy?.research?.scrapeMaxCostMicros;
  const active = new Map<string, AbortController>();
  let cache: { until: number; models: ModelExecutionCapability[] } | undefined;
  const valid = () => !!policy && Date.parse(policy.expiresAt) > now();
  const authorize = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!valid() || simulation || !apiKey) throw failure("IAO_UNAVAILABLE");
    if (await bounded(() => stopped(), 5000, signal) !== false) throw failure("IAO_UNAVAILABLE");
    signal.throwIfAborted();
  };
  const models = async (signal: AbortSignal) => {
    if (!policy || !valid()) throw failure("IAO_UNAVAILABLE");
    if (cache && cache.until > now()) return cache.models.length ? normalizeModelCatalog(cache.models) : [];
    const found = await (options.loadCatalog
      ? options.loadCatalog(policy.models, signal)
      : loadAnthropicModelCatalog({ apiKey, allowed: policy.models }, signal));
    signal.throwIfAborted();
    const qualified = found.length ? normalizeModelCatalog(found) : [];
    if (qualified.some(m => !policy.models.some(p => p.model === m.model && p.maxOutputTokens >= m.maxOutputTokens))) throw failure("IAO_UNAVAILABLE");
    cache = { until: now() + 60_000, models: qualified };
    return qualified;
  };
  const validateIdentity = (userId: string, operationId?: string) => {
    if (!UUID.test(userId) || (operationId !== undefined && !UUID.test(operationId))) throw failure("IAO_INVALID");
  };
  return {
    async catalog(userId, signal) {
      validateIdentity(userId); signal.throwIfAborted();
      const empty = (reason: ConsultationCatalog["reason"]): ConsultationCatalog => ({
        available: false, reason, models: [], research: { search: false, scrape: false },
      });
      if (simulation) return empty("simulation_enabled");
      if (!valid() || !apiKey) return empty("not_configured");
      try { if (await bounded(() => stopped(), 5000, signal) !== false) return empty("paused"); }
      catch { return empty("service_unavailable"); }
      let found: ModelExecutionCapability[];
      try { found = await models(signal); } catch { return empty("account_unavailable"); }
      if (!found.length) return empty("model_unavailable");
      let funded: boolean;
      try { funded = await store.availability(userId, signal); } catch { return empty("service_unavailable"); }
      return { available: funded, reason: funded ? "ready" : "budget_unavailable", research: { search, scrape },
        models: found.map(model => {
          const profiles: ConsultationCatalog["models"][number]["profiles"] = [];
          for (const reflection of ["auto", "standard", "deep", "maximum"] as const) {
            for (const speed of ["standard", "fast", "ultra_fast"] as const) {
              try { const plan = resolveModelExecutionPlan({ model: model.model, reflection, speed }, found);
                profiles.push({ reflection, speed, research: plan.research }); } catch { /* unsupported level is omitted */ }
            }
          }
          return { model: model.model, provider: "anthropic", maxOutputTokens: model.maxOutputTokens, profiles,
            reflections: [...new Set(profiles.map(p => p.reflection))], speeds: [...new Set(profiles.map(p => p.speed))] };
        }) };
    },
    async consult(userId, input: ConsultationInput, signal) {
      validateIdentity(userId, input.operationId); signal.throwIfAborted();
      let request: Required<ConsultationRequest>;
      try {
        if (Object.keys(input).some(k => !["operationId", "question", "preferences", "reviewerModels", "research"].includes(k))) throw new Error();
        request = normalizeConsultationRequest({ ...input, userId });
      } catch { throw failure("IAO_INVALID"); }
      try { const existing = await store.resume(userId, request, signal); if (existing) return publicOperation(existing); }
      catch (error) { return storeError(error); }
      await authorize(signal);
      const catalog = await models(signal);
      let plan;
      try {
        plan = resolveModelExecutionPlan(request.preferences, catalog);
        for (const model of request.reviewerModels) resolveModelExecutionPlan({ ...request.preferences, model }, catalog);
        if (request.reviewerModels.length > plan.research.maxReviewers || request.research.queries.length > plan.research.maxSearches
          || request.research.urls.length > plan.research.maxPages || (request.research.queries.length && !search)
          || (request.research.urls.length && !scrape)) throw new Error();
      } catch { throw failure("IAO_INVALID"); }
      const selected = [request.preferences.model, ...request.reviewerModels];
      const estimates: ConsultationEstimates = { policyVersion: policy!.version, calls: [] };
      const addModel = (model: string, kind: "proposal" | "critique" | "synthesis") => {
        const limits = policy!.models.find(m => m.model === model)!;
        estimates.calls.push({ kind, provider: "anthropic", model, maxCalls: 1,
          maxInputTokens: limits.maxInputTokens, maxOutputTokens: resolveModelExecutionPlan({ ...request.preferences, model }, catalog).maxOutputTokens,
          maxCostMicros: limits.maxCostMicros });
      };
      if (request.reviewerModels.length) {
        selected.forEach(m => addModel(m, "proposal"));
        if (plan.research.maxRounds > 1) request.reviewerModels.forEach(m => addModel(m, "critique"));
      }
      addModel(request.preferences.model, "synthesis");
      if (request.research.queries.length) estimates.calls.push({ kind: "search", provider: "perplexity", maxCalls: request.research.queries.length,
        maxInputTokens: 0, maxOutputTokens: 0, maxCostMicros: policy!.research!.searchMaxCostMicros! });
      if (request.research.urls.length) estimates.calls.push({ kind: "scrape", provider: "firecrawl", maxCalls: request.research.urls.length,
        maxInputTokens: 0, maxOutputTokens: 0, maxCostMicros: policy!.research!.scrapeMaxCostMicros! });
      const client = (options.createClient ?? (c => createRealClaudeClient({ modelCatalog: c, nativeAnthropicAccount: { apiKey } })))(catalog);
      if (client.isMock || typeof client.decide !== "function") throw failure("IAO_UNAVAILABLE");
      let admission;
      try { admission = await store.begin(userId, request, plan, estimates, signal); }
      catch (error) { return storeError(error); }
      if (!admission.created) return publicOperation(admission.operation);
      const begun = admission;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const key = userId + ":" + request.operationId;
      active.set(key, controller);
      if (signal.aborted) abort();
      try {
        const result = await runModelConsultation(request, {
          maxContextBytes: Math.min(262_144, ...selected.map(m => policy!.models.find(p => p.model === m)!.maxInputTokens - OVERHEAD)),
          catalog, models: selected.map(model => ({ model, provider: "anthropic", client })), research,
          admission: { ...begun.admission, reserve: async (call, current) => {
            await authorize(current);
            return begun.admission.reserve(call, current);
          } },
        }, controller.signal);
        return publicOperation(await begun.finalize(persistableConsultationResult(result)));
      } catch (error) { return storeError(error); }
      finally { active.delete(key); signal.removeEventListener("abort", abort); }
    },
    async status(userId, operationId, signal) {
      validateIdentity(userId, operationId);
      try { const result = await store.status(userId, operationId, signal); return result && publicOperation(result); }
      catch (error) { return storeError(error); }
    },
    async cancel(userId, operationId, signal) {
      validateIdentity(userId, operationId);
      try {
        const result = await store.cancel(userId, operationId, signal);
        active.get(userId + ":" + operationId)?.abort();
        return result && publicOperation(result);
      } catch (error) { return storeError(error); }
    },
  };
}
