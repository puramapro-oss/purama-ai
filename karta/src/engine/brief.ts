import { supabase } from "../db/supabase.js";
import type { AgentType } from "./types.js";

export interface PendingBriefRequest {
  userId: string;
  agentType: AgentType;
  runId: string;
  key?: string;
}

export interface PendingBrief {
  brief: string;
  briefId: string;
}

const INPUT_ERROR = "Mission indisponible : vérifier son état avant toute reprise";
const ARM_ERROR = "Autorisation de la mission non confirmée : vérifier son état avant toute action";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeBrief(data: unknown): PendingBrief | null {
  if (!Array.isArray(data) || data.length > 1) throw new Error(INPUT_ERROR);
  if (data.length === 0) return null;
  const row: unknown = data[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(INPUT_ERROR);
  const value = row as Record<string, unknown>;
  if (typeof value.brief !== "string" || !value.brief.trim() ||
      typeof value.brief_id !== "string" || !UUID.test(value.brief_id)) throw new Error(INPUT_ERROR);
  return { brief: value.brief, briefId: value.brief_id };
}

async function readBrief(
  rpc: "karta_claim_pending_brief" | "karta_peek_pending_brief", request: PendingBriefRequest,
): Promise<PendingBrief | null> {
  const params = {
    p_user_id: request.userId, p_agent_type: request.agentType,
    p_run_id: request.runId, p_key: request.key ?? "pending_brief",
  };
  // The retry keeps the exact run and key. A lost committed response must never
  // cause a second claim identity, a restoration, or an external action.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc(rpc, params);
      if (!error) return decodeBrief(data);
    } catch {
      // Do not expose PostgreSQL, transport or payload text in public traces.
    }
  }
  throw new Error(INPUT_ERROR);
}

export function claimPendingBrief(request: PendingBriefRequest): Promise<PendingBrief | null> {
  return readBrief("karta_claim_pending_brief", request);
}

/** Simulation previews do not reserve, delete or copy the pending input. */
export function peekPendingBrief(request: PendingBriefRequest): Promise<PendingBrief | null> {
  return readBrief("karta_peek_pending_brief", request);
}

export async function armPendingBrief(request: Omit<PendingBriefRequest, "key">): Promise<void> {
  const params = { p_user_id: request.userId, p_agent_type: request.agentType, p_run_id: request.runId };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc("karta_arm_pending_brief", params);
      if (!error && data === true) return;
    } catch {
      // An unconfirmed arm is possibly committed; it must never be released.
    }
  }
  throw new Error(ARM_ERROR);
}
