import { ProcessChefDriver, type ChefDriverProvider } from "./driver.js";
import { SupabaseChefControlPlane } from "./control-plane.js";
import { runChefWorkerCycle } from "./supervisor.js";
import { CommandChefVerifier, type ChefVerificationProfile } from "./verifier.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable CHEF manquante: ${name}`);
  return value;
}

function parseJson<T>(name: string, fallback?: T): T {
  const raw = process.env[name];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Variable CHEF manquante: ${name}`);
  }
  try { return JSON.parse(raw) as T; } catch { throw new Error(`JSON CHEF invalide: ${name}`); }
}

function provider(value: string): ChefDriverProvider {
  if (value === "codex" || value === "claude" || value === "glm") return value;
  throw new Error("CHEF_PROVIDER invalide");
}

function positiveInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} invalide`);
  return value;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const missionId = required("CHEF_MISSION_ID");
  const workerId = required("CHEF_WORKER_ID");
  const selectedProvider = provider(required("CHEF_PROVIDER"));
  const defaultCwd = required("CHEF_WORKDIR");
  const repo = required("CHEF_REPO");
  const driverCommand = required("CHEF_DRIVER_COMMAND");
  const driverArgs = parseJson<string[]>("CHEF_DRIVER_ARGS_JSON", []);
  const allowedRoots = parseJson<string[]>("CHEF_ALLOWED_ROOTS_JSON", [defaultCwd]);
  const verificationProfiles = parseJson<ChefVerificationProfile[]>("CHEF_VERIFICATION_PROFILES_JSON");
  const verificationProfileNames = parseJson<string[]>(
    "CHEF_VERIFICATION_PROFILE_NAMES_JSON",
    verificationProfiles.map((profile) => profile.name)
  );
  if (verificationProfileNames.length === 0) throw new Error("Aucun profil de vérification actif");

  const envAllowList = parseJson<string[]>(
    "CHEF_DRIVER_ENV_ALLOWLIST_JSON",
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
  );

  const control = new SupabaseChefControlPlane({
    repo,
    defaultCwd,
    worktree: process.env.CHEF_WORKTREE,
    branch: process.env.CHEF_BRANCH,
    defaultVerificationProfiles: verificationProfileNames,
    staleWorkerSeconds: positiveInt("CHEF_STALE_WORKER_SECONDS", 120, 30, 86_400),
    capabilities: { driverProtocol: 1, verifier: "deterministic" },
  });
  const driver = new ProcessChefDriver({
    provider: selectedProvider,
    command: driverCommand,
    args: driverArgs,
    allowedRoots,
    timeoutMs: positiveInt("CHEF_DRIVER_TIMEOUT_MS", 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
    maxOutputBytes: positiveInt("CHEF_MAX_DRIVER_OUTPUT_BYTES", 2 * 1024 * 1024, 1_024, 16 * 1024 * 1024),
    envAllowList,
  });
  const verifier = new CommandChefVerifier(verificationProfiles, allowedRoots);

  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const idleMs = positiveInt("CHEF_IDLE_POLL_MS", 2_000, 250, 60_000);
  const leaseSeconds = positiveInt("CHEF_LEASE_SECONDS", 300, 30, 3_600);
  const maxInfraBackoffMs = positiveInt("CHEF_MAX_INFRA_BACKOFF_MS", 30_000, 1_000, 5 * 60_000);
  let consecutiveInfraFailures = 0;

  try {
    while (!abort.signal.aborted) {
      try {
        const result = await runChefWorkerCycle(control, driver, verifier, {
          missionId,
          workerId,
          provider: selectedProvider,
          model: process.env.CHEF_MODEL,
          leaseSeconds,
        });
        consecutiveInfraFailures = 0;

        if (result.state === "failed") {
          process.exitCode = 2;
          break;
        }
        if (result.state === "lost_lease") {
          await sleep(Math.min(idleMs * 2, 10_000), abort.signal);
        } else if (result.state === "idle") {
          await sleep(idleMs, abort.signal);
        }
      } catch (error) {
        if (abort.signal.aborted) break;
        consecutiveInfraFailures += 1;
        const message = error instanceof Error ? error.message : "erreur runtime inconnue";
        // Runtime/control-plane failures must not kill an all-day worker. No provider
        // call is started again until the control plane can safely reconcile state.
        console.error(`[chef-worker] incident runtime #${consecutiveInfraFailures}: ${message}`);
        const delay = Math.min(maxInfraBackoffMs, idleMs * 2 ** Math.min(consecutiveInfraFailures, 8));
        await sleep(delay, abort.signal);
      }
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

void main().catch((error) => {
  console.error("[chef-worker] arrêt sûr:", error instanceof Error ? error.message : "erreur inconnue");
  process.exitCode = 1;
});
