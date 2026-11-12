import { runChefProcess, ChefProcessStopUnconfirmedError } from "./process.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { ChefCapabilitySelection } from "./capability-selection.js";
import {
  prepareChefCapabilities, hasChefCapabilityReceipt, bindChefCapabilityPlan,
  type ChefCapabilityPlan, type ChefCapabilityRuntime,
} from "./capability-runtime.js";

export type ChefDriverProvider = "codex" | "claude" | "glm";
export type ChefDriverStatus = "completed" | "blocked_human" | "blocked_external" | "failed";

export interface ChefDriverRequest {
  schemaVersion: 1;
  missionId: string;
  taskId: string;
  workerId: string;
  provider: ChefDriverProvider;
  fencingToken: number;
  attempt: number;
  briefHash: string;
  instructions: string;
  cwd: string;
  branch?: string;
  baseSha?: string;
  accessMode: "read" | "write";
  allowedPaths: string[];
  capabilitySelection?: ChefCapabilitySelection;
  /** Canonical mission owner; required for capability-enabled tasks only. */
  userId?: string;
}

export interface ChefDriverUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costMicros?: number;
  model?: string;
}

export interface ChefDriverResponse {
  schemaVersion: 1;
  status: ChefDriverStatus;
  summary: string;
  outputSha?: string;
  usage?: ChefDriverUsage;
  metadata?: Record<string, unknown>;
  capabilityReceipt?: { selectionHash: string; appliedIds: string[] };
}

export interface ChefWorkerDriver {
  readonly provider: ChefDriverProvider;
  run(request: ChefDriverRequest, signal?: AbortSignal): Promise<ChefDriverResponse>;
}

export interface ProcessChefDriverOptions {
  provider: ChefDriverProvider;
  command: string;
  args?: string[];
  allowedRoots: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  envAllowList?: string[];
  env?: Record<string, string>;
  capabilityRuntime?: ChefCapabilityRuntime;
}

const SHA = /^[0-9a-f]{40,64}$/i;

export function assertAllowedCwd(cwd: string, allowedRoots: string[]): string {
  if (!isAbsolute(cwd)) throw new Error("CHEF cwd doit être absolu");
  if (allowedRoots.length === 0) throw new Error("CHEF allowedRoots vide");

  let canonical: string;
  try {
    // realpath resolves symlinks. Lexical path checks alone allow /trusted/link -> /etc escapes.
    canonical = realpathSync(cwd);
  } catch {
    throw new Error("CHEF cwd introuvable ou inaccessible");
  }

  const allowed = allowedRoots.some((root) => {
    if (!isAbsolute(root)) return false;
    let trustedRoot: string;
    try { trustedRoot = realpathSync(root); } catch { return false; }
    const rel = relative(trustedRoot, canonical);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) throw new Error("CHEF cwd hors périmètre autorisé");
  return canonical;
}

export function validateDriverResponse(value: unknown): ChefDriverResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Réponse worker invalide");
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) throw new Error("Version de réponse worker invalide");
  if (!["completed", "blocked_human", "blocked_external", "failed"].includes(String(v.status))) {
    throw new Error("Statut worker invalide");
  }
  if (typeof v.summary !== "string" || v.summary.length === 0 || v.summary.length > 50_000) {
    throw new Error("Résumé worker invalide");
  }
  if (v.outputSha !== undefined && (typeof v.outputSha !== "string" || !SHA.test(v.outputSha))) {
    throw new Error("outputSha worker invalide");
  }
  if (v.usage !== undefined) {
    if (!v.usage || typeof v.usage !== "object" || Array.isArray(v.usage)) throw new Error("Usage worker invalide");
    const usage = v.usage as Record<string, unknown>;
    for (const key of ["inputTokens", "outputTokens"] as const) {
      if (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) throw new Error("Usage worker invalide");
    }
    for (const key of ["cachedInputTokens", "costMicros"] as const) {
      if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0)) {
        throw new Error("Usage worker invalide");
      }
    }
    if (usage.model !== undefined && (typeof usage.model !== "string" || usage.model.length > 200)) {
      throw new Error("Modèle worker invalide");
    }
  }
  return value as ChefDriverResponse;
}

function minimalEnv(allow: string[], extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of allow) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) env[name] = value;
  return env;
}

/**
 * Trusted bridge process for Codex / Claude Code / GLM.
 * No shell is involved. Model-controlled text is sent only through stdin as JSON.
 * The child receives a minimal environment to avoid leaking unrelated secrets.
 */
export class ProcessChefDriver implements ChefWorkerDriver {
  readonly provider: ChefDriverProvider;
  private readonly options: Required<Pick<ProcessChefDriverOptions, "timeoutMs" | "maxOutputBytes">> & ProcessChefDriverOptions;

  constructor(options: ProcessChefDriverOptions) {
    if (!options.command || options.command.length > 1000) throw new Error("Commande driver invalide");
    if (options.allowedRoots.length === 0) throw new Error("allowedRoots requis");
    this.provider = options.provider;
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
      maxOutputBytes: options.maxOutputBytes ?? 2 * 1024 * 1024,
    };
  }

  async run(request: ChefDriverRequest, signal?: AbortSignal): Promise<ChefDriverResponse> {
    if (request.provider !== this.provider) throw new Error("Provider du driver incohérent");
    const cwd = assertAllowedCwd(request.cwd, this.options.allowedRoots);
    if (!Number.isSafeInteger(request.fencingToken) || request.fencingToken < 0) throw new Error("fencingToken invalide");
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) throw new Error("attempt invalide");
    if (!/^[0-9a-f]{64}$/i.test(request.briefHash)) throw new Error("briefHash invalide");
    if (typeof request.instructions !== "string" || request.instructions.length === 0 || request.instructions.length > 200_000) {
      throw new Error("instructions invalides");
    }
    if (request.accessMode !== "read" && request.accessMode !== "write") throw new Error("accessMode driver invalide");
    if (!Array.isArray(request.allowedPaths) || request.allowedPaths.some((path) => typeof path !== "string")) {
      throw new Error("allowedPaths driver invalides");
    }
    if (request.accessMode === "write" && request.allowedPaths.length === 0) {
      throw new Error("allowedPaths requis pour un worker write");
    }

    let capabilityPlan: ChefCapabilityPlan | undefined;
    let capabilitySelection: ChefCapabilitySelection | undefined;
    if (request.capabilitySelection !== undefined) {
      const prepared = await prepareChefCapabilities(request.capabilitySelection, {
        userId: request.userId ?? "", missionId: request.missionId, taskId: request.taskId, briefHash: request.briefHash,
      }, this.options.capabilityRuntime, signal);
      if (signal?.aborted) throw new Error("Worker CHEF annulé");
      if (!prepared.ready) {
        // No model or coding process has started. Settle known-zero usage and
        // block durably instead of retrying indefinitely or silently dropping choices.
        return {
          schemaVersion: 1, status: "blocked_external",
          summary: `Sélection des capacités indisponible : ${prepared.reason}`,
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
          metadata: { capabilitySelection: { state: "blocked", reason: prepared.reason } },
        };
      }
      capabilityPlan = bindChefCapabilityPlan(prepared.plan, {
        workerId: request.workerId, attempt: request.attempt, fencingToken: request.fencingToken,
      });
      capabilitySelection = prepared.selection;
    }
    // Build the transport from known fields. A caller cannot inject an approved
    // plan or trusted catalogue via additional JSON properties on the request.
    const payload = {
      schemaVersion: request.schemaVersion, missionId: request.missionId, taskId: request.taskId,
      workerId: request.workerId, provider: request.provider, fencingToken: request.fencingToken,
      attempt: request.attempt, briefHash: request.briefHash, instructions: request.instructions,
      cwd, branch: request.branch, baseSha: request.baseSha,
      accessMode: request.accessMode, allowedPaths: request.allowedPaths,
      ...(capabilityPlan ? { userId: request.userId, capabilitySelection, capabilityPlan } : {}),
    };

    const env = minimalEnv(
      this.options.envAllowList ?? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
      {
        ...(this.options.env ?? {}),
        PURAMA_CHEF_WORKER_ID: request.workerId,
        PURAMA_CHEF_TASK_ID: request.taskId,
        PURAMA_CHEF_FENCING_TOKEN: String(request.fencingToken),
      }
    );

    const uncertainCapabilityExecution = (): ChefDriverResponse => ({
      schemaVersion: 1, status: "blocked_external",
      summary: "Exécution interrompue sans reçu fiable ; effets et consommation à rapprocher avant reprise.",
      metadata: { capabilitySelection: { state: "unconfirmed", selectionHash: capabilityPlan?.selectionHash } },
    });
    let result;
    try { result = await runChefProcess({
      command: this.options.command,
      args: this.options.args,
      cwd,
      env,
      input: JSON.stringify(payload) + "\n",
      signal,
      timeoutMs: this.options.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
      label: "worker CHEF",
      abortMessage: "Worker CHEF annulé",
      timeoutMessage: "Worker CHEF expiré",
    }); } catch (error) {
      if (error instanceof ChefProcessStopUnconfirmedError) throw error;
      if (capabilityPlan) return uncertainCapabilityExecution();
      throw error;
    }
    // Cancellation can arrive after the process promise settles, before this
    // async method resumes. A late response must not restore a cancelled run.
    if (signal?.aborted) {
      if (capabilityPlan) return uncertainCapabilityExecution();
      throw new Error("Worker CHEF annulé");
    }
    if (result.exitCode !== 0) {
      if (capabilityPlan) return uncertainCapabilityExecution();
      throw new Error(`Worker CHEF échoué (code=${result.exitCode ?? "null"}, signal=${result.signal ?? "none"})`);
    }
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let parsed: unknown;
    for (let index = lines.length - 1; index >= 0; index--) {
      try { parsed = JSON.parse(lines[index]); break; } catch { /* logs autorisés avant le JSON final */ }
    }
    if (parsed === undefined) {
      if (capabilityPlan) return uncertainCapabilityExecution();
      throw new Error("Worker CHEF terminé sans réponse JSON valide");
    }
    let response: ChefDriverResponse;
    try { response = validateDriverResponse(parsed); } catch (error) {
      if (capabilityPlan) return uncertainCapabilityExecution();
      throw error;
    }
    if (capabilityPlan && (response.status === "failed" || !hasChefCapabilityReceipt(response.capabilityReceipt, capabilityPlan))) {
      // The process may have acted: preserve actual/unknown usage and stop for
      // reconciliation. Do not automatically repeat the execution.
      return {
        ...response, status: "blocked_external",
        summary: "L’adaptateur n’a pas confirmé les capacités appliquées ; résultat à rapprocher avant reprise.",
        metadata: { capabilitySelection: { state: "unconfirmed", selectionHash: capabilityPlan.selectionHash } },
      };
    }
    return response;
  }
}
