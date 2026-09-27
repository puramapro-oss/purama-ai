import type { ChefDriverProvider, ChefDriverResponse, ChefWorkerDriver } from "./driver.js";
import type { ChefVerificationEvidence, ChefVerifier } from "./verifier.js";

export interface ChefRuntimeTask {
  id: string;
  missionId: string;
  briefHash: string;
  instructions: string;
  cwd: string;
  accessMode: "read" | "write";
  fencingToken: number;
  attempt: number;
  branch?: string;
  baseSha?: string;
  verificationProfiles: string[];
}

export interface ChefControlPlane {
  heartbeat(input: { workerId: string; provider: ChefDriverProvider; model?: string; state: "idle" | "claimed" | "running" | "verifying" | "blocked" | "failed"; taskId?: string }): Promise<void>;
  claimNext(input: { missionId: string; workerId: string; provider: ChefDriverProvider; leaseSeconds: number }): Promise<ChefRuntimeTask | null>;
  renewLease(input: { taskId: string; workerId: string; fencingToken: number; leaseSeconds: number }): Promise<boolean>;
  transition(input: { taskId: string; workerId: string; fencingToken: number; target: "running" | "verifying" | "verified_done" | "retryable" | "blocked_human" | "blocked_external" | "failed"; error?: string; outputSha?: string }): Promise<boolean>;
  addEvidence(taskId: string, evidence: ChefVerificationEvidence): Promise<void>;
  recordUsage(input: { eventKey: string; missionId: string; taskId: string; workerId: string; provider: ChefDriverProvider; model?: string; inputTokens: number; outputTokens: number; cachedInputTokens: number; costMicros: number }): Promise<void>;
  tryFinishMission(missionId: string): Promise<boolean>;
}

export type ChefWorkerCycleResult =
  | { state: "idle" }
  | { state: "verified_done"; taskId: string }
  | { state: "retryable"; taskId: string; error: string }
  | { state: "blocked_human" | "blocked_external" | "failed" | "lost_lease"; taskId: string; error?: string };

export interface ChefWorkerCycleOptions {
  missionId: string;
  workerId: string;
  provider: ChefDriverProvider;
  model?: string;
  leaseSeconds?: number;
  renewEveryMs?: number;
}

function usageEventKey(task: ChefRuntimeTask, response: ChefDriverResponse): string {
  const usage = response.usage;
  return [
    "chef-usage",
    task.id,
    task.attempt,
    task.fencingToken,
    usage?.model ?? "unknown",
    usage?.inputTokens ?? 0,
    usage?.outputTokens ?? 0,
  ].join("|");
}

/**
 * Runs one durable worker cycle. Worker claims are fenced; verification is performed by
 * a deterministic verifier, not trusted from the model's own "done" text.
 */
export async function runChefWorkerCycle(
  control: ChefControlPlane,
  driver: ChefWorkerDriver,
  verifier: ChefVerifier,
  options: ChefWorkerCycleOptions
): Promise<ChefWorkerCycleResult> {
  const leaseSeconds = options.leaseSeconds ?? 300;
  const renewEveryMs = options.renewEveryMs ?? Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3));

  await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "idle" });
  const task = await control.claimNext({
    missionId: options.missionId,
    workerId: options.workerId,
    provider: options.provider,
    leaseSeconds,
  });
  if (!task) return { state: "idle" };

  if (task.briefHash.length !== 64) {
    await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "failed", error: "Brief hash invalide",
    });
    return { state: "failed", taskId: task.id, error: "Brief hash invalide" };
  }

  const running = await control.transition({
    taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken, target: "running",
  });
  if (!running) return { state: "lost_lease", taskId: task.id, error: "Claim périmé avant exécution" };
  await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "running", taskId: task.id });

  const abort = new AbortController();
  let lostLease = false;
  let renewalBusy = false;
  const renewal = setInterval(() => {
    if (renewalBusy || lostLease) return;
    renewalBusy = true;
    void control.renewLease({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken, leaseSeconds,
    }).then((ok) => {
      if (!ok) {
        lostLease = true;
        abort.abort();
      }
    }).catch(() => {
      lostLease = true;
      abort.abort();
    }).finally(() => { renewalBusy = false; });
  }, renewEveryMs);
  renewal.unref();

  try {
    let response: ChefDriverResponse;
    try {
      response = await driver.run({
        schemaVersion: 1,
        missionId: task.missionId,
        taskId: task.id,
        workerId: options.workerId,
        provider: options.provider,
        fencingToken: task.fencingToken,
        attempt: task.attempt,
        briefHash: task.briefHash,
        instructions: task.instructions,
        cwd: task.cwd,
        branch: task.branch,
        baseSha: task.baseSha,
      }, abort.signal);
    } catch (error) {
      if (lostLease) return { state: "lost_lease", taskId: task.id, error: "Lease perdue pendant l'exécution" };
      const message = error instanceof Error ? error.message : "Erreur worker";
      const retry = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: message.slice(0, 10_000),
      });
      return retry
        ? { state: "retryable", taskId: task.id, error: message }
        : { state: "lost_lease", taskId: task.id, error: message };
    }

    if (lostLease) return { state: "lost_lease", taskId: task.id, error: "Lease perdue pendant l'exécution" };

    if (response.usage) {
      await control.recordUsage({
        eventKey: usageEventKey(task, response),
        missionId: task.missionId,
        taskId: task.id,
        workerId: options.workerId,
        provider: options.provider,
        model: response.usage.model ?? options.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens ?? 0,
        costMicros: response.usage.costMicros ?? 0,
      });
    }

    if (response.status === "blocked_human" || response.status === "blocked_external") {
      const target = response.status;
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target, error: response.summary.slice(0, 10_000),
      });
      return ok
        ? { state: target, taskId: task.id, error: response.summary }
        : { state: "lost_lease", taskId: task.id, error: response.summary };
    }

    if (response.status === "failed") {
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: response.summary.slice(0, 10_000),
      });
      return ok
        ? { state: "retryable", taskId: task.id, error: response.summary }
        : { state: "lost_lease", taskId: task.id, error: response.summary };
    }

    if (task.accessMode === "write" && !response.outputSha) {
      const error = "Worker write terminé sans outputSha";
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error,
      });
      return ok ? { state: "retryable", taskId: task.id, error } : { state: "lost_lease", taskId: task.id, error };
    }

    const verifying = await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "verifying", outputSha: response.outputSha,
    });
    if (!verifying) return { state: "lost_lease", taskId: task.id, error: "Lease perdue avant vérification" };
    await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "verifying", taskId: task.id });

    let verification;
    try {
      verification = await verifier.verify(task.cwd, task.verificationProfiles, abort.signal);
    } catch (error) {
      if (lostLease) return { state: "lost_lease", taskId: task.id, error: "Lease perdue pendant la vérification" };
      const message = error instanceof Error ? error.message : "Erreur de vérification";
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: message.slice(0, 10_000),
      });
      return ok ? { state: "retryable", taskId: task.id, error: message } : { state: "lost_lease", taskId: task.id, error: message };
    }

    for (const evidence of verification.evidence) await control.addEvidence(task.id, evidence);

    if (!verification.ok) {
      const error = verification.error ?? "Vérification échouée";
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: error.slice(0, 10_000),
      });
      return ok ? { state: "retryable", taskId: task.id, error } : { state: "lost_lease", taskId: task.id, error };
    }

    const done = await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "verified_done", outputSha: response.outputSha,
    });
    if (!done) return { state: "lost_lease", taskId: task.id, error: "Lease perdue avant validation finale" };
    await control.tryFinishMission(task.missionId);
    await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "idle" });
    return { state: "verified_done", taskId: task.id };
  } finally {
    clearInterval(renewal);
  }
}
