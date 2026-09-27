import { randomUUID } from "node:crypto";
import { supabase } from "../db/supabase.js";
import type { ChefDriverProvider } from "./driver.js";
import type { ChefControlPlane, ChefRuntimeTask } from "./supervisor.js";
import type { ChefVerificationEvidence } from "./verifier.js";

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
    assertRpc(requeue.error, "chef_requeue_expired_tasks");
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

    return {
      id,
      missionId,
      briefHash,
      instructions,
      cwd: worktree,
      accessMode,
      fencingToken: safeInt(row.fencing_token, "fencingToken"),
      attempt: safeInt(row.attempt, "attempt"),
      ...(typeof row.branch === "string" && row.branch ? { branch: row.branch } : {}),
      ...(typeof row.base_sha === "string" && row.base_sha ? { baseSha: row.base_sha } : {}),
      verificationProfiles: [...verificationProfiles],
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

  async addEvidence(taskId: string, evidence: ChefVerificationEvidence): Promise<void> {
    const result = await supabase.from("chef_evidence").insert({
      task_id: taskId,
      kind: evidence.kind,
      sha256: evidence.sha256,
      payload: evidence.payload,
    });
    assertRpc(result.error, "chef_evidence");
  }

  async recordUsage(input: {
    eventKey: string;
    missionId: string;
    taskId: string;
    workerId: string;
    provider: ChefDriverProvider;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costMicros: number;
  }): Promise<void> {
    const result = await supabase.rpc("chef_record_usage", {
      p_event_key: input.eventKey,
      p_mission_id: input.missionId,
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_provider: input.provider,
      p_model: input.model ?? null,
      p_input_tokens: input.inputTokens,
      p_output_tokens: input.outputTokens,
      p_cached_input_tokens: input.cachedInputTokens,
      p_cost_micros: input.costMicros,
    });
    assertRpc(result.error, "chef_record_usage");
  }

  async tryFinishMission(missionId: string): Promise<boolean> {
    const result = await supabase.rpc("chef_try_finish_mission", { p_mission_id: missionId });
    assertRpc(result.error, "chef_try_finish_mission");
    return result.data === true;
  }
}
