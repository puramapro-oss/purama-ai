import { randomUUID } from "node:crypto";
import { supabase } from "../db/supabase.js";
import type { ChefDriverProvider } from "./driver.js";
import { ChefProcessStopUnconfirmedError } from "./process.js";
import type { ChefClaimUsage, ChefControlPlane, ChefEvidenceClaim, ChefRuntimeTask } from "./supervisor.js";
import { normalizeChefRequirementKeys, type ChefVerificationEvidence } from "./verifier.js";
import { normalizeChefCapabilitySelection } from "./capability-selection.js";

export interface SupabaseChefControlPlaneOptions {
  repo: string;
  defaultCwd: string;
  worktree?: string;
  branch?: string;
  defaultVerificationProfiles: string[];
  capabilities?: Record<string, unknown>;
  staleWorkerSeconds?: number;
}

function safeInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} invalide`);
  return n;
}

function oneRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const value = data[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Réponse control-plane invalide");
  return value as Record<string, unknown>;
}

function assertRpc(error: { message?: string } | null, label: string): void {
  if (error) throw new Error(`${label}: ${error.message ?? "erreur RPC"}`);
}

export class SupabaseChefControlPlane implements ChefControlPlane {
  private readonly sessionId = randomUUID();
  private reportSequence = 0;

  constructor(private readonly options: SupabaseChefControlPlaneOptions) {
    if (!options.repo || !options.defaultCwd) throw new Error("Métadonnées CHEF incomplètes");
    if (options.defaultVerificationProfiles.length === 0) throw new Error("Profils de vérification par défaut requis");
  }

  async housekeeping(missionId: string): Promise<void> {
    const stale = await supabase.rpc("chef_mark_stale_workers", {
      p_stale_seconds: this.options.staleWorkerSeconds ?? 120,
    });
    assertRpc(stale.error, "chef_mark_stale_workers");

    const requeue = await supabase.rpc("chef_requeue_expired_tasks", { p_mission_id: missionId });
    if (requeue.error?.code === "PCQ01") {
      throw new ChefProcessStopUnconfirmedError("Récupération CHEF bloquée: arrêt du processus expiré non confirmé; intervention requise");
    }
    assertRpc(requeue.error, "chef_requeue_expired_tasks");

    // Self-heal a prior transient failure that happened after the last task became verified.
    // Re-running this check is safe and avoids a mission staying "active" forever with no work left.
    await this.tryFinishMission(missionId);
  }

  async heartbeat(input: {
    workerId: string;
    provider: ChefDriverProvider;
    model?: string;
    state: "idle" | "claimed" | "running" | "verifying" | "blocked" | "failed";
    taskId?: string;
  }): Promise<void> {
    const result = await supabase.rpc("chef_heartbeat_worker", {
      p_worker_id: input.workerId,
      p_provider: input.provider,
      p_model: input.model ?? null,
      p_state: input.state,
      p_session_id: this.sessionId,
      p_sequence: ++this.reportSequence,
      p_pid: process.pid,
      p_repo: this.options.repo,
      p_worktree: this.options.worktree ?? this.options.defaultCwd,
      p_branch: this.options.branch ?? null,
      p_capabilities: this.options.capabilities ?? {},
    });
    assertRpc(result.error, "chef_heartbeat_worker");
    if (result.data !== true) {
      throw new Error("chef_heartbeat_worker: rapport rejeté ou périmé");
    }
  }

  async claimNext(input: {
    missionId: string;
    workerId: string;
    provider: ChefDriverProvider;
    leaseSeconds: number;
  }): Promise<ChefRuntimeTask | null> {
    const result = await supabase.rpc("chef_claim_next_task", {
      p_mission_id: input.missionId,
      p_worker_id: input.workerId,
      p_session_id: this.sessionId,
      p_provider: input.provider,
      p_lease_seconds: input.leaseSeconds,
    });
    if (result.error?.code === "PCQ01") {
      // This is a persistent safety stop, not an empty queue or transient outage.
      // Let the daemon halt instead of polling or launching another process.
      throw new ChefProcessStopUnconfirmedError("Admission CHEF bloquée par une quarantaine persistante; intervention requise");
    }
    assertRpc(result.error, "chef_claim_next_task");
    const row = oneRow(result.data);
    if (!row) return null;

    const id = row.id;
    const missionId = row.mission_id;
    const briefHash = row.brief_hash;
    const instructions = row.instructions;
    if (typeof id !== "string" || typeof missionId !== "string" || missionId !== input.missionId) {
      throw new Error("Task CHEF incohérente");
    }
    if (typeof briefHash !== "string" || !/^[0-9a-f]{64}$/i.test(briefHash)) throw new Error("Brief hash CHEF invalide");
    if (typeof instructions !== "string" || instructions.length === 0) throw new Error("Instructions CHEF invalides");

    const worktree = typeof row.worktree === "string" && row.worktree ? row.worktree : this.options.defaultCwd;
    const accessMode = row.access_mode === "read" ? "read" : row.access_mode === "write" ? "write" : null;
    if (!accessMode) throw new Error("Mode d'accès CHEF invalide");

    const rowProfiles = Array.isArray(row.verification_profiles)
      ? row.verification_profiles.filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value))
      : [];
    const verificationProfiles = rowProfiles.length > 0 ? rowProfiles : this.options.defaultVerificationProfiles;
    if (verificationProfiles.length === 0) throw new Error("Task CHEF sans vérification");

    const allowedPaths = Array.isArray(row.allowed_paths)
      ? row.allowed_paths.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (accessMode === "write" && allowedPaths.length === 0) {
      throw new Error("Task CHEF write sans allowedPaths");
    }

    const capabilitySelection = row.capability_selection !== undefined && row.capability_selection !== null
      ? normalizeChefCapabilitySelection(row.capability_selection) : undefined;
    let userId: string | undefined;
    if (capabilitySelection) {
      // The task/driver snapshot cannot assert ownership. Bind capability access
      // to the mission's canonical tenant before returning the claimed task.
      const owner = await supabase.from("chef_missions").select("user_id").eq("id", missionId).single();
      assertRpc(owner.error, "chef_mission_owner");
      if (typeof owner.data?.user_id !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.data.user_id)) {
        throw new Error("Propriétaire de mission CHEF invalide");
      }
      userId = owner.data.user_id;
    }

    // Mission ingestion may leave branch unassigned; keep the trusted worker binding.
    const branch = typeof row.branch === "string" && row.branch ? row.branch : this.options.branch;
    return {
      id,
      missionId,
      briefHash,
      instructions,
      cwd: worktree,
      accessMode,
      fencingToken: safeInt(row.fencing_token, "fencingToken"),
      attempt: safeInt(row.attempt, "attempt"),
      ...(branch ? { branch } : {}),
      ...(typeof row.base_sha === "string" && row.base_sha ? { baseSha: row.base_sha } : {}),
      verificationProfiles: [...verificationProfiles],
      allowedPaths: [...allowedPaths],
      ...(capabilitySelection ? { capabilitySelection, userId } : {}),
    };
  }

  async renewLease(input: {
    taskId: string;
    workerId: string;
    fencingToken: number;
    leaseSeconds: number;
  }): Promise<boolean> {
    const result = await supabase.rpc("chef_renew_task_lease", {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_fencing_token: input.fencingToken,
      p_lease_seconds: input.leaseSeconds,
    });
    assertRpc(result.error, "chef_renew_task_lease");
    return result.data === true;
  }

  async transition(input: {
    taskId: string;
    workerId: string;
    fencingToken: number;
    target: "running" | "verifying" | "verified_done" | "retryable" | "blocked_human" | "blocked_external" | "failed";
    error?: string;
    outputSha?: string;
  }): Promise<boolean> {
    const result = await supabase.rpc("chef_transition_task", {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_fencing_token: input.fencingToken,
      p_target_state: input.target,
      p_error: input.error ?? null,
      p_output_sha: input.outputSha ?? null,
    });
    assertRpc(result.error, "chef_transition_task");
    return result.data === true;
  }

  async quarantineProcess(taskId: string, claim: ChefEvidenceClaim, reason: string): Promise<boolean> {
    if (!claim || typeof claim.workerId !== "string" || claim.workerId.trim().length === 0) {
      throw new Error("Claim de quarantaine CHEF invalide");
    }
    const fencingToken = safeInt(claim.fencingToken, "fencingToken");
    const attempt = safeInt(claim.attempt, "attempt");
    if (fencingToken === 0 || attempt === 0 || typeof reason !== "string" || !reason.trim() || reason.length > 10_000) {
      throw new Error("Quarantaine CHEF invalide");
    }
    const result = await supabase.rpc("chef_quarantine_process", {
      p_task_id: taskId,
      p_worker_id: claim.workerId,
      p_fencing_token: fencingToken,
      p_attempt: attempt,
      p_reason: reason,
    });
    assertRpc(result.error, "chef_quarantine_process");
    return result.data === true;
  }

  async addEvidence(taskId: string, evidence: ChefVerificationEvidence, claim: ChefEvidenceClaim): Promise<boolean> {
    if (!claim || typeof claim.workerId !== "string" || claim.workerId.trim().length === 0) {
      throw new Error("Claim de preuve CHEF invalide");
    }
    const generation = {
      worker_id: claim.workerId,
      fencing_token: safeInt(claim.fencingToken, "fencingToken"),
      attempt: safeInt(claim.attempt, "attempt"),
    };
    if (generation.fencing_token === 0 || generation.attempt === 0) throw new Error("Génération de preuve CHEF invalide");
    const requirementKeys = normalizeChefRequirementKeys(evidence.requirementKeys);
    const requirementIds: string[] = [];
    if (requirementKeys.length > 0) {
      const links = await supabase
        .from("chef_task_requirements")
        .select("requirement_id, requirement:chef_requirements!inner(requirement_key)")
        .eq("task_id", taskId);
      assertRpc(links.error, "chef_task_requirements");

      const linkedByKey = new Map<string, string>();
      for (const row of links.data ?? []) {
        const requirement: unknown = row.requirement;
        if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
          throw new Error("Réponse exigences CHEF invalide");
        }
        const key = (requirement as Record<string, unknown>).requirement_key;
        if (typeof key !== "string" || typeof row.requirement_id !== "string") {
          throw new Error("Réponse exigences CHEF invalide");
        }
        if (linkedByKey.has(key) && linkedByKey.get(key) !== row.requirement_id) {
          throw new Error(`Clé d'exigence ambiguë: ${key}`);
        }
        linkedByKey.set(key, row.requirement_id);
      }
      for (const key of requirementKeys) {
        const id = linkedByKey.get(key);
        if (!id) throw new Error(`Exigence non liée à la tâche: ${key}`);
        if (evidence.payload.ok === true) requirementIds.push(id);
      }
    }

    // Reserved metadata is derived here, not trusted from an evidence payload.
    // Legacy fan-out rows have no scopeVersion and cannot satisfy the SQL gate.
    const payload = { ...evidence.payload, scopeVersion: 1, requirementKeys };

    const rows = [
      {
        ...generation,
        task_id: taskId,
        requirement_id: null,
        kind: evidence.kind,
        sha256: evidence.sha256,
        payload,
      },
      ...requirementIds.map((requirementId) => ({
        ...generation,
        task_id: taskId,
        requirement_id: requirementId,
        kind: evidence.kind,
        sha256: evidence.sha256,
        payload,
      })),
    ];

    const result = await supabase.from("chef_evidence").insert(rows);
    // The INSERT trigger checks the claim while holding the task row lock.
    // Never refresh and restamp a stale worker's evidence with a new generation.
    if (result.error?.code === "PCE01") return false;
    assertRpc(result.error, "chef_evidence");
    return true;
  }

  async recordUsage(input: ChefClaimUsage): Promise<boolean> {
    const result = await supabase.rpc("chef_record_claim_usage", {
      p_event_key: input.eventKey,
      p_mission_id: input.missionId,
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_provider: input.provider,
      p_model: input.model ?? null,
      p_attempt: input.attempt,
      p_fencing_token: input.fencingToken,
      p_input_tokens: input.inputTokens,
      p_output_tokens: input.outputTokens,
      p_cached_input_tokens: input.cachedInputTokens,
      p_cost_micros: input.costMicros,
    });
    assertRpc(result.error, "chef_record_claim_usage");
    if (typeof result.data !== "boolean") throw new Error("Résultat de réconciliation d'usage invalide");
    return result.data;
  }

  async tryFinishMission(missionId: string): Promise<boolean> {
    const result = await supabase.rpc("chef_try_finish_mission", { p_mission_id: missionId });
    if (result.error?.code === "PCQ01") {
      throw new ChefProcessStopUnconfirmedError("Validation de mission CHEF bloquée par une quarantaine persistante; intervention requise");
    }
    assertRpc(result.error, "chef_try_finish_mission");
    return result.data === true;
  }
}
