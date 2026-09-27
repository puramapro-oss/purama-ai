import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

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
}

const SHA = /^[0-9a-f]{40,64}$/i;

export function assertAllowedCwd(cwd: string, allowedRoots: string[]): string {
  if (!isAbsolute(cwd)) throw new Error("CHEF cwd doit être absolu");
  const canonical = resolve(cwd);
  if (allowedRoots.length === 0) throw new Error("CHEF allowedRoots vide");
  const allowed = allowedRoots.some((root) => {
    if (!isAbsolute(root)) return false;
    const rel = relative(resolve(root), canonical);
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

    const env = minimalEnv(
      this.options.envAllowList ?? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
      {
        ...(this.options.env ?? {}),
        PURAMA_CHEF_WORKER_ID: request.workerId,
        PURAMA_CHEF_TASK_ID: request.taskId,
        PURAMA_CHEF_FENCING_TOKEN: String(request.fencingToken),
      }
    );

    return await new Promise<ChefDriverResponse>((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let killedForOutput = false;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };
      const finishResolve = (value: ChefDriverResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      };
      const terminate = () => {
        if (!child.killed) child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2_000).unref();
      };
      const append = (current: string, chunk: Buffer, label: string) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > this.options.maxOutputBytes) {
          killedForOutput = true;
          terminate();
          throw new Error(`Sortie ${label} du worker trop volumineuse`);
        }
        return next;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        try { stdout = append(stdout, chunk, "stdout"); } catch (error) { finishReject(error as Error); }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try { stderr = append(stderr, chunk, "stderr"); } catch (error) { finishReject(error as Error); }
      });

      const timeout = setTimeout(() => {
        terminate();
        finishReject(new Error("Worker CHEF expiré"));
      }, this.options.timeoutMs);
      timeout.unref();

      const onAbort = () => {
        terminate();
        finishReject(new Error("Worker CHEF annulé"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (error) => finishReject(error));
      child.on("close", (code, signalName) => {
        if (settled || killedForOutput) return;
        if (code !== 0) {
          finishReject(new Error(`Worker CHEF échoué (code=${code ?? "null"}, signal=${signalName ?? "none"})`));
          return;
        }
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        let parsed: unknown;
        for (let index = lines.length - 1; index >= 0; index--) {
          try { parsed = JSON.parse(lines[index]); break; } catch { /* logs autorisés avant le JSON final */ }
        }
        if (parsed === undefined) {
          finishReject(new Error("Worker CHEF terminé sans réponse JSON valide"));
          return;
        }
        try { finishResolve(validateDriverResponse(parsed)); } catch (error) { finishReject(error as Error); }
      });

      child.stdin.on("error", (error) => finishReject(error));
      child.stdin.end(JSON.stringify(request) + "\n");
    });
  }
}
