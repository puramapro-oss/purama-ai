import { isProxy } from "node:util/types";

export type ReflectionDepth = "auto" | "standard" | "deep" | "maximum";
export type ExecutionSpeed = "standard" | "fast" | "ultra_fast";
export interface ModelExecutionPreferences {
  model: string;
  reflection?: ReflectionDepth;
  speed?: ExecutionSpeed;
}
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Host-owned qualification of one exact model on the configured transport.
 * Presence in this catalogue never authorizes a user, an expense or data sharing. */
export interface ModelExecutionCapability {
  model: string;
  maxOutputTokens: number;
  reasoning: "none" | "budget" | "adaptive";
  effortLevels?: ModelEffort[];
}
export interface ModelExecutionPlan {
  model: string;
  reflection: Exclude<ReflectionDepth, "auto">;
  speed: ExecutionSpeed;
  maxOutputTokens: number;
  timeoutMs: number;
  research: { maxSearches: number; maxPages: number; maxReviewers: number; maxRounds: number; concurrency: number };
  providerOptions: {
    thinking?: { type: "enabled"; budget_tokens: number } | { type: "adaptive" };
    output_config?: { effort: ModelEffort };
  };
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$(?![\s\S])/;
const EFFORTS: ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
const invalid = (): never => { throw new Error("Profil de modèle invalide ou non qualifié"); };

export function normalizeModelPreferences(value: unknown): Required<ModelExecutionPreferences> {
  if (!plain(value) || Object.getOwnPropertyNames(value).some(key => !["model", "reflection", "speed"].includes(key))
    || typeof value.model !== "string" || !MODEL.test(value.model)) return invalid();
  const reflection = value.reflection ?? "auto";
  const speed = value.speed ?? "standard";
  if (value.reflection === null || value.speed === null
    || typeof reflection !== "string" || !["auto", "standard", "deep", "maximum"].includes(reflection)
    || typeof speed !== "string" || !["standard", "fast", "ultra_fast"].includes(speed)) return invalid();
  return { model: value.model, reflection: reflection as ReflectionDepth, speed: speed as ExecutionSpeed };
}

export function normalizeModelCatalog(value: unknown): ModelExecutionCapability[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: ModelExecutionCapability[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !("value" in property)) return invalid();
    const row: unknown = property.value;
    if (!plain(row) || Object.getOwnPropertyNames(row).some(key => !["model", "reasoning", "maxOutputTokens", "effortLevels"].includes(key))
      || typeof row.model !== "string" || !MODEL.test(row.model) || result.some(item => item.model === row.model)
      || !Number.isSafeInteger(row.maxOutputTokens) || Number(row.maxOutputTokens) < 1024 || Number(row.maxOutputTokens) > 65_536
      || typeof row.reasoning !== "string" || !["none", "budget", "adaptive"].includes(row.reasoning)) return invalid();
    let effortLevels: ModelEffort[] | undefined;
    if (row.reasoning === "adaptive") {
      const levels = row.effortLevels;
      if (!Array.isArray(levels) || isProxy(levels) || Object.getPrototypeOf(levels) !== Array.prototype
        || levels.length < 1 || levels.length > EFFORTS.length || Reflect.ownKeys(levels).length !== levels.length + 1) return invalid();
      effortLevels = [];
      for (let i = 0; i < levels.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(levels, String(i));
        if (!descriptor || !("value" in descriptor) || !EFFORTS.includes(descriptor.value)
          || effortLevels.includes(descriptor.value)) return invalid();
        effortLevels.push(descriptor.value);
      }
      effortLevels.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
    } else if (Object.hasOwn(row, "effortLevels")) return invalid();
    result.push({ model: row.model, maxOutputTokens: Number(row.maxOutputTokens),
      reasoning: row.reasoning as ModelExecutionCapability["reasoning"], ...(effortLevels ? { effortLevels } : {}) });
  }
  return result;
}

/** Exact model selection; speed never changes the model or explicit reflection.
 * Resource ceilings are policy defaults, not a latency/quality/cost guarantee. */
export function resolveModelExecutionPlan(
  preferences: ModelExecutionPreferences, catalog: readonly ModelExecutionCapability[], timeoutCeilingMs = 60_000,
): ModelExecutionPlan {
  const selected = normalizeModelPreferences(preferences);
  const models = normalizeModelCatalog(catalog);
  const capability = models.find(model => model.model === selected.model);
  if (!capability) return invalid();
  if (!Number.isSafeInteger(timeoutCeilingMs) || timeoutCeilingMs < 1000 || timeoutCeilingMs > 120_000) return invalid();
  const reflection = selected.reflection === "auto" ? "standard" : selected.reflection;
  if (reflection !== "standard" && capability.reasoning === "none") {
    throw new Error("Ce modèle n’a pas de réflexion approfondie qualifiée ; choisissez un profil compatible");
  }
  const outputTarget = reflection === "maximum" ? 16_384 : reflection === "deep" ? 8192 : 1024;
  // A smaller model can use its qualified ceiling; it is returned explicitly.
  const maxOutputTokens = Math.min(capability.maxOutputTokens, outputTarget);
  const providerOptions: ModelExecutionPlan["providerOptions"] = {};
  if (capability.reasoning === "budget" && reflection !== "standard") {
    const budget = maxOutputTokens - 1024;
    if (budget < 1024) throw new Error("Budget de sortie insuffisant pour la réflexion demandée");
    providerOptions.thinking = { type: "enabled", budget_tokens: budget };
  } else if (capability.reasoning === "adaptive") {
    const levels = capability.effortLevels!;
    const targetEffort = reflection === "deep" ? "high" : "medium";
    const desired = reflection === "maximum" ? levels.length - 1
      : levels.reduce((last, level, index) => EFFORTS.indexOf(level) <= EFFORTS.indexOf(targetEffort) ? index : last, 0);
    providerOptions.thinking = { type: "adaptive" };
    providerOptions.output_config = { effort: levels[desired] };
  }
  const depth = reflection === "maximum" ? 3 : reflection === "deep" ? 2 : 1;
  const breadth = selected.speed === "ultra_fast" ? 1 : selected.speed === "fast" ? Math.min(depth, 2) : depth;
  return {
    model: capability.model, reflection, speed: selected.speed, maxOutputTokens,
    timeoutMs: Math.min(timeoutCeilingMs, selected.speed === "ultra_fast" ? 15_000 : selected.speed === "fast" ? 30_000 : timeoutCeilingMs),
    research: { maxSearches: breadth, maxPages: breadth * 2,
      maxReviewers: selected.speed === "ultra_fast" ? 0 : breadth, maxRounds: breadth > 1 ? 2 : 1,
      concurrency: selected.speed === "standard" ? 2 : 3 },
    providerOptions,
  };
}

/** Explicit host configuration can qualify more models; absent configuration
 * only the already configured primary/fast IDs are admitted with legacy limits. */
export function configuredModelCatalog(main: string, fast: string, json?: string): ModelExecutionCapability[] {
  if (json) {
    if (json.length > 16_384) return invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return invalid(); }
    return normalizeModelCatalog(parsed);
  }
  return normalizeModelCatalog([...new Set([main, fast])].map(model => ({ model, reasoning: "none", maxOutputTokens: 1024 })));
}
