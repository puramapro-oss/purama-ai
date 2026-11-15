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
 *
 * Deux pièges PostgREST/Postgres vérifiés empiriquement (vrai Postgres + vrai PostgREST, pas un
 * mock) avant ce correctif, lors de la review indépendante du 2026-10-05 :
 * 1. `.eq("memory_value", value)` avec `value` un JS brut non échappé compare du TEXTE NON-JSON à
 *    une colonne jsonb → `invalid input syntax for type json` pour tout texte libre ; et pour une
 *    valeur qui ressemble à du JSON ("123", "true") la comparaison réussit au mauvais type
 *    (nombre/bool vs chaîne stockée) → 0 ligne, `null` silencieux et permanent. Fix : comparer la
 *    représentation JSON EXACTE via `JSON.stringify(value)`, jamais la valeur JS brute.
 * 2. `UPDATE ... SET memory_value = null` viole `memory_value JSONB NOT NULL` (schéma
 *    `migrations/001_karta_core.sql`) — en PRODUCTION RÉELLE, pas seulement avec un faux client.
 *    Fix : DELETE la ligne au lieu de la mettre à `null` (sémantique identique : `getMemory`
 *    traite déjà une ligne absente comme `null` via `data?.memory_value ?? null`), ce qui évite
 *    complètement la contrainte NOT NULL tout en gardant `RETURNING` (`.select()`) comme preuve
 *    de qui a gagné la course.
 */
export async function consumeBrief(userId: string, agentType: AgentType, key = "pending_brief"): Promise<string | null> {
  const value = await getMemory(userId, agentType, key);
  if (typeof value !== "string" || !value.trim()) return null;

  // CAS atomique : supprime la ligne SEULEMENT si sa valeur n'a pas changé depuis notre lecture
  // (comparaison JSONB exacte via JSON.stringify). Si quelqu'un d'autre a déjà consommé/modifié
  // entre-temps, le DELETE ne touche aucune ligne → on a perdu la course.
  const { data, error } = await supabase
    .from("karta_agent_memory")
    .delete()
    .eq("user_id", userId)
    .eq("agent_type", agentType)
    .eq("memory_key", key)
    .eq("memory_value", JSON.stringify(value)) // garde CAS : comparaison JSONB exacte, pas de texte brut
    .select("memory_value");

  if (error) {
    throw new Error(`consumeBrief(${agentType}, ${key}) CAS: ${error.message}`);
  }

  // Si DELETE n'a touché aucune ligne, c'est que quelqu'un d'autre a consommé avant nous → null.
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
