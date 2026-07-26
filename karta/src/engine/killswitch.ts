import { supabase } from "../db/supabase.js";

let cachedUntil = 0;
let cachedValue = false;
const CACHE_MS = 5_000; // évite de spammer la DB à chaque cycle d'agent, tout en restant quasi-instantané

/** Kill switch global — arrête TOUS les agents de TOUS les users. Vérifié avant chaque cycle. */
export async function isGlobalKillSwitchActive(): Promise<boolean> {
  if (Date.now() < cachedUntil) return cachedValue;

  const { data, error } = await supabase.from("karta_global_state").select("kill_switch").eq("id", "global").single();

  if (error) throw new Error(`isGlobalKillSwitchActive: ${error.message}`);

  cachedValue = data.kill_switch;
  cachedUntil = Date.now() + CACHE_MS;
  return cachedValue;
}

export async function setGlobalKillSwitch(active: boolean, updatedBy?: string): Promise<void> {
  const { error } = await supabase
    .from("karta_global_state")
    .update({ kill_switch: active, updated_at: new Date().toISOString(), updated_by: updatedBy ?? null })
    .eq("id", "global");

  if (error) throw new Error(`setGlobalKillSwitch: ${error.message}`);

  cachedUntil = 0; // invalide le cache immédiatement
}
