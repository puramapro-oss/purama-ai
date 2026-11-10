import type { ChefDriverProvider, ChefDriverResponse, ChefWorkerDriver } from "./driver.js";
import { createHash } from "node:crypto";
import { captureCleanGitBaseline, verifyCommittedGitState } from "./git-state.js";
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

export interface ChefClaimUsage {
  eventKey: string;
  missionId: string;
  taskId: string;
  workerId: string;
  provider: ChefDriverProvider;
  model?: string;
  attempt: number;
  fencingToken: number;
  /** Final totals for a dimension, or null when the provider did not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costMicros: number | null;
}

export interface ChefControlPlane {
  housekeeping?(missionId: string): Promise<void>;
  heartbeat(input: { workerId: string; provider: ChefDriverProvider; model?: string; state: "idle" | "claimed" | "running" | "verifying" | "blocked" | "failed"; taskId?: string }): Promise<void>;
  claimNext(input: { missionId: string; workerId: string; provider: ChefDriverProvider; leaseSeconds: number }): Promise<ChefRuntimeTask | null>;
  renewLease(input: { taskId: string; workerId: string; fencingToken: number; leaseSeconds: number }): Promise<boolean>;
  transition(input: { taskId: string; workerId: string; fencingToken: number; target: "running" | "verifying" | "verified_done" | "retryable" | "blocked_human" | "blocked_external" | "failed"; error?: string; outputSha?: string }): Promise<boolean>;
  addEvidence(taskId: string, evidence: ChefVerificationEvidence, claim: ChefEvidenceClaim): Promise<boolean>;
  /** False means a capped dimension is still unknown; its reservation remains held. */
  recordUsage(input: ChefClaimUsage): Promise<boolean>;
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
  const fingerprint = createHash("sha256").update(JSON.stringify({
    model: usage?.model ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    costMicros: usage?.costMicros ?? null,
  })).digest("hex");
  return [
    "chef-usage",
    task.id,
    task.attempt,
    task.fencingToken,
    fingerprint,
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

  if (control.housekeeping) await control.housekeeping(options.missionId);
  await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "idle" });
  const task = await control.claimNext({
    missionId: options.missionId,
    workerId: options.workerId,
    provider: options.provider,
    leaseSeconds,
  });
  if (!task) return { state: "idle" };
  const evidenceClaim = Object.freeze({
    workerId: options.workerId,
    fencingToken: task.fencingToken,
    attempt: task.attempt,
  });
  // These paths have not called the driver. Zero is a known observation here,
  // unlike missing provider metrics after an execution or timeout.
  const settleBeforeExecution = async () => {
    const settled = await control.recordUsage({
      eventKey: `chef-no-execution|${task.id}|${task.attempt}|${task.fencingToken}`,
      missionId: task.missionId, taskId: task.id, workerId: options.workerId,
      provider: options.provider, model: options.model,
      attempt: task.attempt, fencingToken: task.fencingToken,
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0,
    });
    if (!settled) throw new Error("Réservation sans exécution non réconciliée");
  };

  if (task.briefHash.length !== 64) {
    await settleBeforeExecution();
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
        await settleBeforeExecution();
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
      await settleBeforeExecution();
      const blocked = await control.transition({
        taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
        target: "blocked_human", error: message.slice(0, 10_000),
      });
      return blocked
        ? { state: "blocked_human", taskId: task.id, error: message }
        : { state: "lost_lease", taskId: task.id, error: message };
    }
  }

  let running: boolean;
  try {
    running = await control.transition({
      taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken, target: "running",
    });
  } catch (error) {
    await settleBeforeExecution();
    throw error;
  }
  if (!running) {
    await settleBeforeExecution();
    return { state: "lost_lease", taskId: task.id, error: "Claim périmé avant exécution" };
  }
  try {
    await control.heartbeat({ workerId: options.workerId, provider: options.provider, model: options.model, state: "running", taskId: task.id });
  } catch (error) {
    await settleBeforeExecution();
    throw error;
  }

  const abort = new AbortController();
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
        baseSha: executionBaseSha,
        accessMode: task.accessMode,
        allowedPaths: task.allowedPaths,
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

    // Accounting is bound to this attempt even if its lease was lost meanwhile.
    // A late receipt may settle its own reservation; it cannot complete another claim.
    try {
        const accounted = await control.recordUsage({
          eventKey: usageEventKey(task, response),
          missionId: task.missionId,
          taskId: task.id,
          workerId: options.workerId,
          provider: options.provider,
          model: response.usage?.model ?? options.model,
          attempt: task.attempt,
          fencingToken: task.fencingToken,
          inputTokens: response.usage?.inputTokens ?? null,
          outputTokens: response.usage?.outputTokens ?? null,
          cachedInputTokens: response.usage?.cachedInputTokens ?? null,
          costMicros: response.usage?.costMicros ?? null,
        });
        if (!accounted) throw new Error("Usage fournisseur incomplet : réservation conservée, réconciliation requise");
    } catch (error) {
        stopRenewal();
        const message = error instanceof Error ? error.message : "Comptabilité d'usage indisponible";
        if (lostLease) return { state: "lost_lease", taskId: task.id, error: message };
        const blocked = await control.transition({
          taskId: task.id, workerId: options.workerId, fencingToken: task.fencingToken,
          target: "blocked_external", error: message.slice(0, 10_000), outputSha: response.outputSha,
        }).catch(() => false);
        return blocked
          ? { state: "blocked_external", taskId: task.id, error: message }
          : { state: "lost_lease", taskId: task.id, error: message };
    }

    if (lostLease) return { state: "lost_lease", taskId: task.id, error: "Lease perdue pendant l'exécution" };

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
  }
}
