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
 *
 * Race-safe via compare-and-swap : deux consommateurs concurrents → exactement un reçoit le brief,
 * l'autre reçoit null (exactly-once semantics).
 */
export async function consumeBrief(userId: string, agentType: AgentType, key = "pending_brief"): Promise<string | null> {
  const value = await getMemory(userId, agentType, key);
  if (typeof value !== "string" || !value.trim()) return null;

  // CAS atomique : clear SEULEMENT si la valeur n'a pas changé depuis notre lecture.
  // Si quelqu'un d'autre a consommé/modifié entre-temps, UPDATE retourne 0 ligne → on a perdu la course.
  const { data, error } = await supabase
    .from("karta_agent_memory")
    .update({ memory_value: null, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("agent_type", agentType)
    .eq("memory_key", key)
    .eq("memory_value", value) // garde CAS : ne clear QUE si la valeur est identique
    .select("memory_value");

  if (error) {
    throw new Error(`consumeBrief(${agentType}, ${key}) CAS: ${error.message}`);
  }

  // Si UPDATE n'a touché aucune ligne, c'est que quelqu'un d'autre a consommé avant nous → null.
  if (!data || data.length === 0) return null;

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
