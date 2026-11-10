import { supabase } from "../db/supabase.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { getQueuedExecutionKey } from "../queue/delivery-identity.js";

export const BRIEF_AGENT_TYPES = [
  "campagnes-par-courriel", "pro-de-la-sensibilisation-au-froid", "newsletter-genie",
  "maitre-des-publicites", "planificateur-d-appels", "reservation-intelligente",
] as const;
export type BriefAgentType = typeof BRIEF_AGENT_TYPES[number];

const STATES = ["pending", "claimed", "effect_started", "ready", "awaiting_approval", "completed", "reconciliation_required"] as const;
const RUN_STATUSES = ["running", "executing", "success", "error", "awaiting_approval", "skipped", "cancelled", "simulated", "partial"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BriefMission {
  submissionId: string;
  agentType: BriefAgentType;
  state: typeof STATES[number];
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  run: null | {
    id: string;
    status: typeof RUN_STATUSES[number];
    mode: "live" | "simulation";
    mock: boolean;
  };
}

export class BriefSubmissionError extends Error {
  constructor(
    readonly code: "BRIEF_INVALID" | "BRIEF_CONFLICT" | "BRIEF_BUSY" | "BRIEF_NOT_FOUND" | "BRIEF_UNAVAILABLE",
  ) {
    const messages = {
      BRIEF_INVALID: "La mission ou son identité est invalide.",
      BRIEF_CONFLICT: "Cette identité correspond déjà à une autre mission. Vérifie la demande précédente.",
      BRIEF_BUSY: "Une mission attend déjà son traitement pour cet employé. Consulte son suivi avant d’en créer une autre.",
      BRIEF_NOT_FOUND: "Cette mission est introuvable pour cet employé.",
      BRIEF_UNAVAILABLE: "Le suivi de la mission est temporairement indisponible. Conserve la même identité avant de réessayer.",
    };
    super(messages[code]);
    this.name = "BriefSubmissionError";
  }

  get status(): number {
    return this.code === "BRIEF_INVALID" ? 400 : this.code === "BRIEF_NOT_FOUND" ? 404
      : this.code === "BRIEF_UNAVAILABLE" ? 503 : 409;
  }
}

export interface BriefScope { userId: string; agentType: string }

function scopeParams(scope: BriefScope): { p_user_id: string; p_agent_type: BriefAgentType } {
  if (!UUID.test(scope.userId) || !BRIEF_AGENT_TYPES.includes(scope.agentType as BriefAgentType)) {
    throw new BriefSubmissionError("BRIEF_INVALID");
  }
  return { p_user_id: scope.userId, p_agent_type: scope.agentType as BriefAgentType };
}

function submissionId(id: string): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new BriefSubmissionError("BRIEF_INVALID");
  return id.toLowerCase();
}

function timestamp(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
  return time.toISOString();
}

function decodeMissions(data: unknown, scope: BriefScope, id?: string): BriefMission[] {
  if (!Array.isArray(data) || data.length > (id ? 1 : 20)) throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
  const seen = new Set<string>();
  return data.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
    const row = entry as Record<string, unknown>;
    if (typeof row.submission_id !== "string" || !UUID.test(row.submission_id)
      || (id && row.submission_id.toLowerCase() !== id)
      || row.agent_type !== scope.agentType || !STATES.includes(row.state as typeof STATES[number])
      || !Number.isInteger(row.attempt_count) || Number(row.attempt_count) < 0 || Number(row.attempt_count) > 3
      || seen.has(row.submission_id.toLowerCase())) throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
    seen.add(row.submission_id.toLowerCase());
    let run: BriefMission["run"] = null;
    if (row.run_id !== null) {
      if (typeof row.run_id !== "string" || !UUID.test(row.run_id)
        || !RUN_STATUSES.includes(row.run_status as typeof RUN_STATUSES[number])
        || (row.run_mode !== "live" && row.run_mode !== "simulation")
        || typeof row.run_mock !== "boolean") throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
      run = { id: row.run_id, status: row.run_status as NonNullable<BriefMission["run"]>["status"], mode: row.run_mode, mock: row.run_mock };
    } else if (row.run_status !== null || row.run_mode !== null || row.run_mock !== null) {
      throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
    }
    // Explicit projection: payload, tool parameters and raw database diagnostics
    // must not cross the authenticated metadata endpoint.
    return {
      submissionId: row.submission_id.toLowerCase(), agentType: row.agent_type as BriefAgentType,
      state: row.state as BriefMission["state"], createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at), attemptCount: Number(row.attempt_count), run,
    };
  });
}

async function callBriefRpc(name: string, params: Record<string, unknown>): Promise<unknown> {
  // The SQL submission is idempotent. Transport retries preserve all arguments;
  // no error is converted into a new identity or an assumed successful write.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc(name, params);
      if (!error) return data;
      const code = (error as { code?: unknown }).code;
      if (code === "PBR01") throw new BriefSubmissionError("BRIEF_INVALID");
      if (code === "PBR02") throw new BriefSubmissionError("BRIEF_CONFLICT");
      if (code === "PBR03") throw new BriefSubmissionError("BRIEF_BUSY");
    } catch (error) {
      if (error instanceof BriefSubmissionError) throw error;
    }
  }
  throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
}

export async function submitBrief(scope: BriefScope, id: string, text: unknown): Promise<BriefMission> {
  const params = scopeParams(scope);
  const stableId = submissionId(id);
  if (typeof text !== "string" || !text.trim() || text.length > 8_000
    || text.includes("\0") || Buffer.byteLength(text, "utf8") > 32_000) throw new BriefSubmissionError("BRIEF_INVALID");
  const data = await callBriefRpc("karta_submit_brief", {
    ...params, p_submission_id: stableId, p_brief: text,
  });
  const mission = decodeMissions(data, scope, stableId)[0];
  if (!mission) throw new BriefSubmissionError("BRIEF_UNAVAILABLE");
  return mission;
}

export async function getBriefStatus(scope: BriefScope, id: string): Promise<BriefMission | null> {
  const params = scopeParams(scope);
  const stableId = submissionId(id);
  const data = await callBriefRpc("karta_get_brief_status", { ...params, p_submission_id: stableId });
  return decodeMissions(data, scope, stableId)[0] ?? null;
}

export async function listBriefs(scope: BriefScope): Promise<BriefMission[]> {
  const data = await callBriefRpc("karta_list_briefs", scopeParams(scope));
  return decodeMissions(data, scope);
}

/** A failed queue acknowledgement leaves the admitted input in SQL. */
export async function dispatchBrief(
  scope: BriefScope, mission: BriefMission, requestId: string,
): Promise<{ state: "queued" | "unconfirmed" | "not_requested"; executionKey?: string }> {
  scopeParams(scope);
  const stableRequest = submissionId(requestId);
  if (mission.agentType !== scope.agentType || !UUID.test(mission.submissionId)) throw new BriefSubmissionError("BRIEF_INVALID");
  if (mission.state !== "pending" && mission.state !== "ready") return { state: "not_requested" };
  try {
    const jobId = await enqueueAgentCycle({
      userId: scope.userId, agentType: mission.agentType,
      trigger: { type: "manual", source: "brief-api", payload: { submissionId: mission.submissionId, requestKey: stableRequest } },
    }, { dedupeKey: `brief|${scope.userId}|${mission.agentType}|${mission.submissionId}|${stableRequest}` });
    const executionKey = getQueuedExecutionKey(jobId);
    return executionKey ? { state: "queued", executionKey } : { state: "unconfirmed" };
  } catch {
    // Including an uncertain add() response: never delete/recreate the brief or
    // choose another delivery identity to compensate for transport failure.
    return { state: "unconfirmed" };
  }
}
