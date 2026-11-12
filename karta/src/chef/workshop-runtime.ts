import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CodexCliChefDriver } from "./codex-cli-driver.js";
import { captureWorkshopHead } from "./workshop-git.js";
import { ChefProcessStopUnconfirmedError, runChefProcess } from "./process.js";
import { CommandChefVerifier, type ChefVerificationProfile, type ChefVerifier } from "./verifier.js";
import type { ChefWorkerDriver } from "./driver.js";
import { runChefWorkerCycle, type ChefControlPlane } from "./supervisor.js";
import { parseWorkshopProjects, workshopProjectHash, WORKSHOP_UUID, type WorkshopProject } from "./workshop-config.js";

export type WorkshopRuntimeCode = "WORKSHOP_CONFIG" | "WORKSHOP_PREFLIGHT" | "WORKSHOP_DATABASE" |
  "WORKSHOP_LEASE" | "WORKSHOP_KILL_SWITCH" | "WORKSHOP_PROCESS_STOP" | "WORKSHOP_WORKER";
const messages: Record<WorkshopRuntimeCode, string> = {
  WORKSHOP_CONFIG: "Catalogue atelier absent ou invalide.",
  WORKSHOP_PREFLIGHT: "Préparation locale de l’atelier refusée.",
  WORKSHOP_DATABASE: "Connexion au contrôle de l’atelier indisponible.",
  WORKSHOP_LEASE: "Un autre service détient ce projet.",
  WORKSHOP_KILL_SWITCH: "Création suspendue par l’arrêt global.",
  WORKSHOP_PROCESS_STOP: "Arrêt d’un processus non confirmé ; intervention requise.",
  WORKSHOP_WORKER: "Service de création arrêté après un incident de contrôle.",
};
export class WorkshopRuntimeError extends Error {
  constructor(readonly code: WorkshopRuntimeCode) { super(messages[code]); }
}

export interface WorkshopRun {
  missionId: string;
  state: string;
  cancelRequested: boolean;
  repo: string;
}
export interface WorkshopRuntimeStore {
  probe(signal: AbortSignal): Promise<void>;
  killSwitch(signal: AbortSignal): Promise<boolean>;
  heartbeat(projectId: string, instanceId: string, configHash: string, online: boolean, signal: AbortSignal): Promise<boolean>;
  activeRun(projectId: string, signal: AbortSignal): Promise<WorkshopRun | null>;
  finishCancel(missionId: string, signal: AbortSignal): Promise<boolean>;
}
export interface WorkshopPreflight {
  cwd: string;
  repositoryId: string;
  codexCommand: string;
  verificationProfiles: ChefVerificationProfile[];
}
export interface WorkshopWorker {
  control: ChefControlPlane;
  driver: ChefWorkerDriver;
  verifier: ChefVerifier;
}
export interface WorkshopRuntimeDependencies {
  store: WorkshopRuntimeStore;
  preflight(project: WorkshopProject, signal: AbortSignal): Promise<WorkshopPreflight>;
  clean(cwd: string, signal: AbortSignal): Promise<void>;
  createWorker(project: WorkshopProject, preflight: WorkshopPreflight, index: number): WorkshopWorker;
  cycle: typeof runChefWorkerCycle;
  /** Test clocks only; production defaults remain one second and five seconds. */
  pollMs?: number;
  heartbeatMs?: number;
}

function fault(error: unknown, fallback: WorkshopRuntimeCode): WorkshopRuntimeError {
  if (error instanceof WorkshopRuntimeError) return error;
  return new WorkshopRuntimeError(error instanceof ChefProcessStopUnconfirmedError ? "WORKSHOP_PROCESS_STOP" : fallback);
}
function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel));
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Atelier arrêté");
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(done => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal.addEventListener("abort", finish, { once: true });
  });
}
async function executable(command: string, cwd: string): Promise<string> {
  const candidates = command.includes("/") ? [resolve(cwd, command)] :
    (process.env.PATH ?? "").split(delimiter).filter(p => isAbsolute(p)).map(p => join(p, command));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch { /* Try the next trusted PATH entry. */ }
  }
  throw new WorkshopRuntimeError("WORKSHOP_PREFLIGHT");
}
async function command(cwd: string, binary: string, args: string[], signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  const result = await runChefProcess({
    command: binary, args, cwd, env: safeEnv(), signal,
    timeoutMs: 10_000, maxOutputBytes: 256 * 1024, label: "préparation atelier",
    abortMessage: "Préparation atelier arrêtée", timeoutMessage: "Préparation atelier expirée",
  });
  if (result.exitCode !== 0) throw new WorkshopRuntimeError("WORKSHOP_PREFLIGHT");
  return result.stdout.trim();
}
export async function assertCleanWorkshop(cwd: string, signal: AbortSignal): Promise<void> {
  try { await captureWorkshopHead(cwd, signal); }
  catch (error) { throw fault(error, "WORKSHOP_PREFLIGHT"); }
}

/** No model call and no verifier execution: only executable, auth and Git checks. */
export async function preflightWorkshopProject(project: WorkshopProject, signal: AbortSignal): Promise<WorkshopPreflight> {
  try {
    checkAbort(signal);
    const cwd = await realpath(project.workdir);
    if (!(await stat(cwd)).isDirectory() || cwd === "/") throw new Error("cwd");
    await access(cwd, constants.R_OK | constants.W_OK | constants.X_OK);
    const git = await executable("git", cwd);
    const top = await realpath(await command(cwd, git, ["rev-parse", "--show-toplevel"], signal));
    if (top !== cwd) throw new Error("repository root");
    const common = await command(cwd, git, ["rev-parse", "--git-common-dir"], signal);
    const repositoryId = await realpath(resolve(cwd, common));
    await assertCleanWorkshop(cwd, signal);
    for (const path of project.allowedPaths) {
      if (path.split("/").some(p => p.toLowerCase() === ".git")) throw new Error("git scope");
      let ancestor = resolve(cwd, path);
      // A new file is allowed, but its closest existing parent cannot escape the worktree.
      while (true) {
        try {
          const actual = await realpath(ancestor);
          if (!within(cwd, actual)) throw new WorkshopRuntimeError("WORKSHOP_PREFLIGHT");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === dirname(ancestor)) throw error;
          ancestor = dirname(ancestor);
        }
      }
    }
    const codexCommand = await executable(project.codexCommand, cwd);
    // A task must not be able to replace its own CLI between preflight and execution.
    if (within(cwd, codexCommand)) throw new Error("mutable CLI");
    const version = await command(cwd, codexCommand, ["--version"], signal);
    if (!/^codex(?:-cli)?\s+\d+\.\d+/i.test(version)) throw new Error("CLI version");
    await command(cwd, codexCommand, ["--ignore-user-config", "login", "status"], signal);
    const verificationProfiles: ChefVerificationProfile[] = [];
    for (const profile of project.verificationProfiles) {
      verificationProfiles.push({ ...profile, command: await executable(profile.command, cwd) });
    }
    // Constructor validates profile names, requirements and duplicates without executing them.
    new CommandChefVerifier(verificationProfiles, [cwd]);
    checkAbort(signal);
    return { cwd, repositoryId, codexCommand, verificationProfiles };
  } catch (error) { throw fault(error, "WORKSHOP_PREFLIGHT"); }
}

async function defaultDependencies(): Promise<WorkshopRuntimeDependencies> {
  // Keep importing this module and injected tests independent of production credentials.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new WorkshopRuntimeError("WORKSHOP_DATABASE");
  const [{ supabase }, { SupabaseChefControlPlane }] = await Promise.all([
    import("../db/supabase.js"), import("./control-plane.js"),
  ]);
  const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
  const dbCheck = (error: unknown) => { if (error) throw new WorkshopRuntimeError("WORKSHOP_DATABASE"); };
  const store: WorkshopRuntimeStore = {
    async probe(signal) {
      const results = await Promise.all([
        supabase.from("chef_workshop_runtimes").select("project_id,instance_id,config_hash,online,heartbeat_at").limit(1).abortSignal(requestSignal(signal)),
        supabase.from("chef_workshop_runs").select("mission_id,project_id,cancel_requested_at,finished_at").limit(1).abortSignal(requestSignal(signal)),
        supabase.from("chef_process_quarantines").select("task_id").limit(1).abortSignal(requestSignal(signal)),
      ]);
      for (const result of results) dbCheck(result.error);
      // Schema probe only. A quarantine for an unrelated repository must not disable this
      // catalogue. Migration 023 remains authoritative when CHEF claims each actual task.
    },
    async killSwitch(signal) {
      const result = await supabase.from("karta_global_state").select("kill_switch").eq("id", "global").abortSignal(requestSignal(signal)).single();
      dbCheck(result.error);
      if (typeof result.data?.kill_switch !== "boolean") throw new WorkshopRuntimeError("WORKSHOP_DATABASE");
      return result.data.kill_switch;
    },
    async heartbeat(projectId, instanceId, configHash, online, signal) {
      const result = await supabase.rpc("chef_workshop_heartbeat", {
        p_project_id: projectId, p_instance_id: instanceId, p_config_hash: configHash, p_online: online,
      }).abortSignal(requestSignal(signal));
      dbCheck(result.error);
      return result.data === true;
    },
    async activeRun(projectId, signal) {
      const result = await supabase.from("chef_workshop_runs")
        .select("mission_id,cancel_requested_at,chef_missions!inner(state,repo)")
        .eq("project_id", projectId).is("finished_at", null).abortSignal(requestSignal(signal)).maybeSingle();
      dbCheck(result.error);
      if (!result.data) return null;
      const row = result.data;
      const joined: unknown = row.chef_missions;
      const mission = (Array.isArray(joined) ? joined[0] : joined) as { state?: unknown; repo?: unknown } | null;
      if (!WORKSHOP_UUID.test(String(row.mission_id)) || !mission ||
          typeof mission.state !== "string" || typeof mission.repo !== "string") {
        throw new WorkshopRuntimeError("WORKSHOP_DATABASE");
      }
      return { missionId: String(row.mission_id), state: mission.state, repo: mission.repo,
        cancelRequested: row.cancel_requested_at !== null };
    },
    async finishCancel(missionId, signal) {
      const result = await supabase.rpc("chef_workshop_finish_cancel", { p_mission_id: missionId }).abortSignal(requestSignal(signal));
      dbCheck(result.error);
      return result.data === true;
    },
  };
  return {
    store, preflight: preflightWorkshopProject, clean: assertCleanWorkshop, cycle: runChefWorkerCycle,
    createWorker(project, preflight) {
      return {
        control: new SupabaseChefControlPlane({
          repo: project.repo, defaultCwd: preflight.cwd, worktree: preflight.cwd,
          defaultVerificationProfiles: project.implementationProfiles,
          capabilities: { driverProtocol: 1, verifier: "deterministic", workshop: project.id },
        }),
        driver: new CodexCliChefDriver({ command: preflight.codexCommand, allowedRoots: [preflight.cwd] }),
        verifier: new CommandChefVerifier(preflight.verificationProfiles, [preflight.cwd]),
      };
    },
  };
}
function catalogue(projects: WorkshopProject[]): WorkshopProject[] {
  try {
    const parsed = parseWorkshopProjects(JSON.stringify(projects));
    if (!parsed.length) throw new Error("empty");
    return parsed;
  } catch { throw new WorkshopRuntimeError("WORKSHOP_CONFIG"); }
}
interface PreparedProject {
  project: WorkshopProject;
  preflight: WorkshopPreflight;
  instanceId: string;
  configHash: string;
  workers: WorkshopWorker[];
  uncertain: boolean;
}
async function prepare(projects: WorkshopProject[], dependencies: WorkshopRuntimeDependencies, signal: AbortSignal): Promise<PreparedProject[]> {
  const prepared: PreparedProject[] = [];
  for (const project of projects) {
    const preflight = await dependencies.preflight(project, signal);
    if (prepared.some(other => other.preflight.repositoryId === preflight.repositoryId ||
        within(other.preflight.cwd, preflight.cwd) || within(preflight.cwd, other.preflight.cwd))) {
      throw new WorkshopRuntimeError("WORKSHOP_CONFIG");
    }
    prepared.push({ project, preflight, instanceId: randomUUID(), configHash: workshopProjectHash(project),
      workers: Array.from({ length: project.maxParallel }, (_, i) => dependencies.createWorker(project, preflight, i)),
      uncertain: false });
  }
  await dependencies.store.probe(signal);
  if (await dependencies.store.killSwitch(signal)) throw new WorkshopRuntimeError("WORKSHOP_KILL_SWITCH");
  return prepared;
}

/**
 * Read-only local/configuration inspection, not provider qualification or a task admission.
 * Does not acquire a lease or make a project available. A relevant quarantine can still
 * refuse the actual CHEF claim; the scoped SQL guards remain authoritative.
 */
export async function checkWorkshopRuntime(projects: WorkshopProject[], signal = new AbortController().signal,
  dependencies?: WorkshopRuntimeDependencies): Promise<{ projectCount: number }> {
  const config = catalogue(projects);
  const deps = dependencies ?? await defaultDependencies();
  try { return { projectCount: (await prepare(config, deps, signal)).length }; }
  catch (error) { throw fault(error, "WORKSHOP_PREFLIGHT"); }
}

/** Admission and lifecycle adapter only. All claims, fencing, execution and proofs stay in CHEF. */
export async function runWorkshopRuntime(projects: WorkshopProject[], signal?: AbortSignal,
  dependencies?: WorkshopRuntimeDependencies): Promise<void> {
  const config = catalogue(projects);
  if (signal?.aborted) return;
  const deps = dependencies ?? await defaultDependencies();
  const pollMs = deps.pollMs ?? 1_000;
  const heartbeatMs = deps.heartbeatMs ?? 5_000;
  if (pollMs <= 0 || pollMs > 1_000 || heartbeatMs <= 0 || heartbeatMs > 5_000) throw new WorkshopRuntimeError("WORKSHOP_CONFIG");
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  // Credential/module loading above is asynchronous; do not miss a shutdown in that gap.
  if (signal?.aborted) stop.abort();
  let failure: WorkshopRuntimeError | undefined;
  const fail = (error: unknown, code: WorkshopRuntimeCode) => {
    failure ??= fault(error, code);
    stop.abort();
  };
  const attempted: PreparedProject[] = [];
  let loops: Promise<void>[] = [];

  async function projectLoop(item: PreparedProject): Promise<void> {
    let current: { id: string; abort: AbortController; workers: Promise<void>[] } | undefined;
    const stopMission = async () => {
      if (!current) return;
      current.abort.abort();
      await Promise.all(current.workers);
      current = undefined;
    };
    const stopCurrent = () => current?.abort.abort();
    stop.signal.addEventListener("abort", stopCurrent);
    try {
      while (!stop.signal.aborted) {
        const started = Date.now();
        const run = await deps.store.activeRun(item.project.id, stop.signal);
        if (stop.signal.aborted) break;
        if (run && run.repo !== item.project.repo) throw new WorkshopRuntimeError("WORKSHOP_DATABASE");
        if (current && (run?.missionId !== current.id || run.state !== "active" || run.cancelRequested)) await stopMission();
        if (stop.signal.aborted) break;
        if (run?.cancelRequested) {
          // False leaves the run cancelling. Only SQL can confirm every historical process stopped.
          await deps.store.finishCancel(run.missionId, stop.signal);
        } else if (run?.state === "active" && !current) {
          // Once per mission admission, never during a poll while another slot is writing.
          await deps.clean(item.preflight.cwd, stop.signal);
          if (stop.signal.aborted) break;
          const abort = new AbortController();
          current = { id: run.missionId, abort, workers: [] };
          current.workers = item.workers.map((worker, index) => (async () => {
            try {
              while (!abort.signal.aborted && !stop.signal.aborted) {
                const result = await deps.cycle(worker.control, worker.driver, worker.verifier, {
                  missionId: run.missionId, workerId: "workshop:" + item.instanceId + ":" + item.project.id + ":" + index,
                  provider: "codex", signal: abort.signal,
                });
                if ("haltWorker" in result && result.haltWorker) {
                  item.uncertain = true;
                  throw new WorkshopRuntimeError("WORKSHOP_PROCESS_STOP");
                }
                await delay(pollMs, abort.signal);
              }
            } catch (error) {
              if (error instanceof ChefProcessStopUnconfirmedError ||
                  (error instanceof WorkshopRuntimeError && error.code === "WORKSHOP_PROCESS_STOP")) item.uncertain = true;
              // An ordinary abort is already settled by the CHEF supervisor. Any thrown error
              // can mean an unpersisted lease release, so never retry it inside this dispatcher.
              if (!abort.signal.aborted || error instanceof ChefProcessStopUnconfirmedError || item.uncertain) fail(error, "WORKSHOP_WORKER");
            }
          })());
        }
        await delay(pollMs - (Date.now() - started), stop.signal);
      }
    } catch (error) {
      if (!stop.signal.aborted) fail(error, "WORKSHOP_DATABASE");
    } finally {
      await stopMission();
      stop.signal.removeEventListener("abort", stopCurrent);
    }
  }

  async function maintainLeases(): Promise<void> {
    while (!stop.signal.aborted) {
      const started = Date.now();
      try {
        // All calls have independent four-second HTTP deadlines; no stale cached kill switch.
        await Promise.all([
          deps.store.killSwitch(stop.signal).then(active => {
            if (active) throw new WorkshopRuntimeError("WORKSHOP_KILL_SWITCH");
          }),
          ...attempted.map(async item => {
            if (!await deps.store.heartbeat(item.project.id, item.instanceId, item.configHash, true, stop.signal)) {
              throw new WorkshopRuntimeError("WORKSHOP_LEASE");
            }
          }),
        ].map(promise => promise.catch(error => {
          if (!stop.signal.aborted) fail(error, "WORKSHOP_DATABASE");
        })));
      } catch (error) { if (!stop.signal.aborted) fail(error, "WORKSHOP_DATABASE"); }
      await delay(heartbeatMs - (Date.now() - started), stop.signal);
    }
  }

  try {
    const prepared = await prepare(config, deps, stop.signal);
    if (!stop.signal.aborted) {
      // Acquire together so a large catalogue cannot age the first lease while waiting for the last.
      attempted.push(...prepared);
      await Promise.all(prepared.map(async item => {
        try {
          if (!await deps.store.heartbeat(item.project.id, item.instanceId, item.configHash, true, stop.signal)) {
            throw new WorkshopRuntimeError("WORKSHOP_LEASE");
          }
        } catch (error) { if (!stop.signal.aborted) fail(error, "WORKSHOP_DATABASE"); }
      }));
    }
    if (!stop.signal.aborted) {
      loops = [maintainLeases(), ...attempted.map(projectLoop)];
      await Promise.all(loops);
    }
  } catch (error) {
    if (!stop.signal.aborted) fail(error, "WORKSHOP_PREFLIGHT");
  } finally {
    stop.abort();
    await Promise.all(loops);
    // Never publish offline before every in-flight worker and lease call has settled.
    // A quarantined process cannot be called stopped: let its heartbeat expire instead.
    await Promise.all(attempted.filter(item => !item.uncertain).map(async item => {
      try {
        await deps.store.heartbeat(item.project.id, item.instanceId, item.configHash, false, new AbortController().signal);
      } catch (error) { failure ??= fault(error, "WORKSHOP_DATABASE"); }
    }));
    signal?.removeEventListener("abort", onAbort);
  }
  if (failure) throw failure;
}
