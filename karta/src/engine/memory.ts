import { supabase } from "../db/supabase.js";
import type { AgentType } from "./types.js";

export async function getMemory(userId: string, agentType: AgentType, key: string): Promise<unknown | null> {
  const { data, error } = await supabase
    .from("karta_agent_memory")
    .select("memory_value")
    .eq("user_id", userId)
    .eq("agent_type", agentType)
    .eq("memory_key", key)
    .maybeSingle();

  if (error) {
    throw new Error(`getMemory(${agentType}, ${key}): ${error.message}`);
  }

  return data?.memory_value ?? null;
}

/**
 * Consomme un "brief" laissé par l'utilisateur (ex: sujet de newsletter, brief de campagne) —
 * utilisé par les agents "action" pilotés à la demande plutôt que par des données déjà en base.
 * Le brief est effacé après lecture pour ne pas être retraité au cycle suivant.
 */
export async function consumeBrief(userId: string, agentType: AgentType, key = "pending_brief"): Promise<string | null> {
  const value = await getMemory(userId, agentType, key);
  if (typeof value !== "string" || !value.trim()) return null;
  await setMemory(userId, agentType, key, null);
  return value;
}

export async function setMemory(
  userId: string,
  agentType: AgentType,
  key: string,
  value: unknown
): Promise<void> {
  const { error } = await supabase.from("karta_agent_memory").upsert(
    {
      user_id: userId,
      agent_type: agentType,
      memory_key: key,
      memory_value: value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,agent_type,memory_key" }
  );

  if (error) {
    throw new Error(`setMemory(${agentType}, ${key}): ${error.message}`);
  }
}
