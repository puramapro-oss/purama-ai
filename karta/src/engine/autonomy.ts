import { supabase } from "../db/supabase.js";
import type { AgentRunResult, AgentState, AgentType } from "./types.js";

/** Charge l'état d'autonomie d'un agent pour un user. Crée une ligne par défaut (niveau 1, simulation) si absente. */
export async function loadAgentState(userId: string, agentType: AgentType): Promise<AgentState> {
  const { data, error } = await supabase
    .from("karta_agent_state")
    .select("*")
    .eq("user_id", userId)
    .eq("agent_type", agentType)
    .maybeSingle();

  if (error) {
    throw new Error(`loadAgentState(${agentType}): ${error.message}`);
  }

  if (data) {
    return parseAgentState(userId, agentType, data);
  }

  const { data: created, error: insertError } = await supabase
    .from("karta_agent_state")
    .insert({ user_id: userId, agent_type: agentType })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(`loadAgentState(${agentType}) création par défaut: ${insertError.message}`);
  }

  return parseAgentState(userId, agentType, created);
}

function parseAgentState(userId: string, agentType: AgentType, row: unknown): AgentState {
  if (!row || typeof row !== "object") throw new Error(`loadAgentState(${agentType}): état absent`);
  const data = row as Record<string, unknown>;
  if (typeof data.is_enabled !== "boolean" || typeof data.kill_switch !== "boolean" ||
      typeof data.simulation_mode !== "boolean" ||
      (data.autonomy_level !== 1 && data.autonomy_level !== 2 && data.autonomy_level !== 3)) {
    throw new Error(`loadAgentState(${agentType}): état invalide — exécution bloquée`);
  }
  return {
    userId,
    agentType,
    isEnabled: data.is_enabled,
    autonomyLevel: data.autonomy_level,
    killSwitch: data.kill_switch,
    simulationMode: data.simulation_mode,
  };
}

export async function recordRunOutcome(
  userId: string,
  agentType: AgentType,
  status: AgentRunResult["status"]
): Promise<void> {
  const { error } = await supabase
    .from("karta_agent_state")
    .update({ last_run_at: new Date().toISOString(), last_run_status: status, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("agent_type", agentType);

  if (error) {
    throw new Error(`recordRunOutcome(${agentType}): ${error.message}`);
  }
}

/**
 * Une action "sensible" (argent, envoi de masse, signature) ne s'exécute jamais seule
 * en dessous du niveau 3, quel que soit le paramétrage — garde-fou non contournable côté code
 * (cf CLAUDE.md §SÉCURITÉ : "Actions sensibles TOUJOURS en validation humaine par défaut").
 */
export function requiresHumanApproval(state: AgentState, toolIsSensitive: boolean): boolean {
  if (state.simulationMode) return true;
  if (state.autonomyLevel === 1) return true;
  if (state.autonomyLevel === 2 && toolIsSensitive) return true;
  return false;
}

export function isRunnable(state: AgentState): { ok: true } | { ok: false; reason: string } {
  if (state.killSwitch) return { ok: false, reason: "kill switch actif" };
  if (!state.isEnabled) return { ok: false, reason: "agent désactivé" };
  return { ok: true };
}
