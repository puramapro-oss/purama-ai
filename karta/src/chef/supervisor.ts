import type { ChefDriverProvider, ChefDriverResponse, ChefWorkerDriver } from "./driver.js";
import { captureCleanGitBaseline, verifyCommittedGitState } from "./git-state.js";
import { ChefProcessStopUnconfirmedError } from "./process.js";
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
  allowedPaths: string[];
}

export interface ChefEvidenceClaim {
  workerId: string;
  fencingToken: number;
  attempt: number;
}

export interface ChefControlPlane {
  housekeeping?(missionId: string): Promise<void>;
  heartbeat(input: { workerId: string; provider: ChefDriverProvider; model?: string; state: "idle" | "claimed" | "running" | "verifying" | "blocked" | "failed"; taskId?: string }): Promise<void>;
  claimNext(input: { missionId: string; workerId: string; provider: ChefDriverProvider; leaseSeconds: number }): Promise<ChefRuntimeTask | null>;
  renewLease(input: { taskId: string; workerId: string; fencingToken: number; leaseSeconds: number }): Promise<boolean>;
  transition(input: { taskId: string; workerId: string; fencingToken: number; target: "running" | "verifying" | "verified_done" | "retryable" | "blocked_human" | "blocked_external" | "failed"; error?: string; outputSha?: string }): Promise<boolean>;
  quarantineProcess?(taskId: string, claim: ChefEvidenceClaim, reason: string): Promise<boolean>;
  addEvidence(taskId: string, evidence: ChefVerificationEvidence, claim: ChefEvidenceClaim): Promise<boolean>;
  recordUsage(input: { eventKey: string; missionId: string; taskId: string; workerId: string; provider: ChefDriverProvider; model?: string; inputTokens: number; outputTokens: number; cachedInputTokens: number; costMicros: number }): Promise<void>;
  tryFinishMission(missionId: string): Promise<boolean>;
}

export type ChefWorkerCycleResult =
  | { state: "idle" }
  | { state: "verified_done"; taskId: string }
  | { state: "retryable"; taskId: string; error: string }
  | { state: "blocked_external"; taskId: string; error: string; haltWorker: true }
  | { state: "blocked_human" | "blocked_external" | "failed" | "lost_lease"; taskId: string; error?: string };

export interface ChefWorkerCycleOptions {
  missionId: string;
  workerId: string;
  provider: ChefDriverProvider;
  model?: string;
  leaseSeconds?: number;
  renewEveryMs?: number;
  signal?: AbortSignal;
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
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3_600) {
    throw new Error("Durée de lease CHEF invalide");
  }
  if (!Number.isInteger(renewEveryMs) || renewEveryMs < 1_000 || renewEveryMs >= leaseSeconds * 1_000) {
    throw new Error("Cadence de renouvellement CHEF invalide");
  }

  if (options.signal?.aborted) return { state: "idle" };
  if (control.housekeeping) await control.housekeeping(options.missionId);
  if (options.signal?.aborted) return { state: "idle" };
  await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "idle" });
  if (options.signal?.aborted) return { state: "idle" };
  const task = await control.claimNext({
    missionId: options.missionId,
    workerId: options.workerId,
    provider: options.provider,
    leaseSeconds,
  });
  if (!task) return { state: "idle" };
  const releaseForShutdown = async (): Promise<ChefWorkerCycleResult> => {
    const error = "Arrêt du worker demandé; exécution arrêtée ou non démarrée";
    const released = await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "retryable", error,
    });
    return released
      ? { state: "retryable", taskId: task.id, error }
      : { state: "lost_lease", taskId: task.id, error };
  };
  if (options.signal?.aborted) return await releaseForShutdown();
  const evidenceClaim = Object.freeze({
    workerId: options.workerId,
    fencingToken: task.fencingToken,
    attempt: task.attempt,
  });

  if (task.briefHash.length !== 64) {
    await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "failed", error: "Brief hash invalide",
    });
    return { state: "failed", taskId: task.id, error: "Brief hash invalide" };
  }

  let executionBaseSha = task.baseSha;
  if (task.accessMode === "write") {
    try {
      const baseline = await captureCleanGitBaseline({ cwd: task.cwd, expectedBranch: task.branch });
      if (task.baseSha && baseline.headSha.toLowerCase() !== task.baseSha.toLowerCase()) {
        const error = "Base Git assignée devenue obsolète : replanification requise";
        const blocked = await control.transition({
          taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
          target: "blocked_external", error,
        });
        return blocked
          ? { state: "blocked_external", taskId: task.id, error }
          : { state: "lost_lease", taskId: task.id, error };
      }
      executionBaseSha = baseline.headSha;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Préflight Git impossible";
      const blocked = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "blocked_human", error: message.slice(0, 10_000),
      });
      return blocked
        ? { state: "blocked_human", taskId: task.id, error: message }
        : { state: "lost_lease", taskId: task.id, error: message };
    }
  }

  if (options.signal?.aborted) return await releaseForShutdown();
  const running = await control.transition({
    taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken, target: "running",
  });
  if (!running) return { state: "lost_lease", taskId: task.id, error: "Claim périmé avant exécution" };
  await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "running", taskId: task.id });

  const abort = new AbortController();
  const onShutdown = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onShutdown, { once: true });
  if (options.signal?.aborted) onShutdown();
  let lostLease = false;
  let renewalBusy = false;
  let renewalStopped = false;
  let heartbeatState: "running" | "verifying" = "running";

  const loseLease = () => {
    lostLease = true;
    abort.abort();
  };
  const renewal = setInterval(() => {
    if (renewalBusy || lostLease || renewalStopped) return;
    renewalBusy = true;
    void control.renewLease({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken, leaseSeconds,
    }).then(async (ok) => {
      if (!ok || renewalStopped) {
        if (!renewalStopped) loseLease();
        return;
      }
      // A live task renews BOTH its fencing lease and the worker heartbeat. Otherwise
      // housekeeping could mark a healthy long-running worker stale after two minutes.
      await control.heartbeat({
        workerId: options.workerId,
        provider: options.provider,
        model: options.model,
        state: heartbeatState,
        taskId: task.id,
      });
    }).catch(() => {
      if (!renewalStopped) loseLease();
    }).finally(() => { renewalBusy = false; });
  }, renewEveryMs);
  renewal.unref();

  const stopRenewal = () => {
    renewalStopped = true;
    clearInterval(renewal);
  };

  const blockUnconfirmedStop = async (error: ChefProcessStopUnconfirmedError): Promise<ChefWorkerCycleResult> => {
    stopRenewal();
    const message = error.message.slice(0, 10_000);
    let quarantined = false;
    try {
      quarantined = await control.quarantineProcess?.(task.id, evidenceClaim, message) === true;
    } catch {
      throw new ChefProcessStopUnconfirmedError(`${message}; quarantaine durable non enregistrée`);
    }
    if (!quarantined) {
      throw new ChefProcessStopUnconfirmedError(`${message}; quarantaine durable indisponible ou refusée`);
    }
    // The persistent scope exclusion MUST exist before blocked_external releases
    // the ordinary active-task index locks. A stale claim can still quarantine
    // its authenticated historical generation, even if this transition fails.
    let blocked: boolean;
    try {
      blocked = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "blocked_external", error: message,
      });
    } catch {
      throw new ChefProcessStopUnconfirmedError(`${message}; blocage durable non enregistré`);
    }
    if (!blocked) {
      throw new ChefProcessStopUnconfirmedError(`${message}; blocage durable refusé (claim périmé)`);
    }
    return { state: "blocked_external", taskId: task.id, error: message, haltWorker: true };
  };

  try {
    if (abort.signal.aborted) {
      stopRenewal();
      return await releaseForShutdown();
    }
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
        baseSha: executionBaseSha,
        accessMode: task.accessMode,
        allowedPaths: task.allowedPaths,
      }, abort.signal);
    } catch (error) {
      if (error instanceof ChefProcessStopUnconfirmedError) return await blockUnconfirmedStop(error);
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
      try {
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
      } catch (error) {
        stopRenewal();
        const message = error instanceof Error ? error.message : "Comptabilité d'usage indisponible";
        const blocked = await control.transition({
          taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
          target: "blocked_external", error: message.slice(0, 10_000),
        }).catch(() => false);
        return blocked
          ? { state: "blocked_external", taskId: task.id, error: message }
          : { state: "lost_lease", taskId: task.id, error: message };
      }
    }

    if (abort.signal.aborted) {
      stopRenewal();
      return await releaseForShutdown();
    }

    if (response.status === "blocked_human" || response.status === "blocked_external") {
      stopRenewal();
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
      stopRenewal();
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: response.summary.slice(0, 10_000),
      });
      return ok
        ? { state: "retryable", taskId: task.id, error: response.summary }
        : { state: "lost_lease", taskId: task.id, error: response.summary };
    }

    if (task.accessMode === "write" && !response.outputSha) {
      stopRenewal();
      const error = "Worker write terminé sans outputSha";
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error,
      });
      return ok ? { state: "retryable", taskId: task.id, error } : { state: "lost_lease", taskId: task.id, error };
    }

    let gitEvidence: ChefVerificationEvidence | undefined;
    if (task.accessMode === "write" && response.outputSha) {
      try {
        gitEvidence = await verifyCommittedGitState({
          cwd: task.cwd,
          expectedHeadSha: response.outputSha,
          expectedBranch: task.branch,
          baseSha: executionBaseSha,
          allowedPaths: task.allowedPaths,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "État Git invalide";
        stopRenewal();
        const ok = await control.transition({
          taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
          target: "retryable", error: message.slice(0, 10_000),
        });
        return ok
          ? { state: "retryable", taskId: task.id, error: message }
          : { state: "lost_lease", taskId: task.id, error: message };
      }
    }

    const verifying = await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "verifying", outputSha: response.outputSha,
    });
    if (!verifying) return { state: "lost_lease", taskId: task.id, error: "Lease perdue avant vérification" };
    heartbeatState = "verifying";
    await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "verifying", taskId: task.id });

    let verification;
    try {
      verification = await verifier.verify(task.cwd, task.verificationProfiles, abort.signal);
    } catch (error) {
      if (error instanceof ChefProcessStopUnconfirmedError) return await blockUnconfirmedStop(error);
      if (lostLease) return { state: "lost_lease", taskId: task.id, error: "Lease perdue pendant la vérification" };
      const message = error instanceof Error ? error.message : "Erreur de vérification";
      stopRenewal();
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: message.slice(0, 10_000),
      });
      return ok ? { state: "retryable", taskId: task.id, error: message } : { state: "lost_lease", taskId: task.id, error: message };
    }

    if (lostLease) return { state: "lost_lease", taskId: task.id, error: "Lease perdue pendant la vérification" };
    if (abort.signal.aborted) {
      stopRenewal();
      return await releaseForShutdown();
    }

    // Observe Git again after the checks. This detects a changed final HEAD/worktree;
    // it is not a claim that commands executed inside an immutable snapshot.
    if (task.accessMode === "write" && response.outputSha) {
      try {
        gitEvidence = await verifyCommittedGitState({
          cwd: task.cwd,
          expectedHeadSha: response.outputSha,
          expectedBranch: task.branch,
          baseSha: executionBaseSha,
          allowedPaths: task.allowedPaths,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "État Git modifié pendant la vérification";
        stopRenewal();
        const ok = await control.transition({
          taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
          target: "retryable", error: message.slice(0, 10_000),
        });
        return ok ? { state: "retryable", taskId: task.id, error: message } : { state: "lost_lease", taskId: task.id, error: message };
      }
    }

    for (const evidence of [...(gitEvidence ? [gitEvidence] : []), ...verification.evidence]) {
      if (options.signal?.aborted) {
        stopRenewal();
        return await releaseForShutdown();
      }
      if (lostLease || !await control.addEvidence(task.id, evidence, evidenceClaim)) {
        loseLease();
        return { state: "lost_lease", taskId: task.id, error: "Claim périmé lors de l'enregistrement des preuves" };
      }
    }

    if (!verification.ok) {
      stopRenewal();
      const error = verification.error ?? "Vérification échouée";
      const ok = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "retryable", error: error.slice(0, 10_000),
      });
      return ok ? { state: "retryable", taskId: task.id, error } : { state: "lost_lease", taskId: task.id, error };
    }

    stopRenewal();
    if (options.signal?.aborted) return await releaseForShutdown();
    const done = await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
      target: "verified_done", outputSha: response.outputSha,
    });
    if (!done) return { state: "lost_lease", taskId: task.id, error: "Lease perdue avant validation finale" };
    await control.tryFinishMission(task.missionId);
    await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "idle" });
    return { state: "verified_done", taskId: task.id };
  } finally {
    stopRenewal();
    options.signal?.removeEventListener("abort", onShutdown);
  }
}
